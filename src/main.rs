mod activity;
mod bugsync;
mod commands;
mod config;
mod crypto;
mod db;
mod deploy;
mod error;
mod git;
mod kanban;
mod state;
mod terminal;

use std::sync::atomic::Ordering;
use state::AppState;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::Mutex;
use tracing::{error, warn};

fn init_logging() {
    use tracing_subscriber::{fmt, EnvFilter};
    use tracing_appender::rolling;

    // Log file: ~/.config/glitch-goblin/glitch-goblin.log (daily rotation)
    let log_dir = dirs::config_dir()
        .map(|d| d.join("glitch-goblin"))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&log_dir);

    let file_appender = rolling::daily(&log_dir, "glitch-goblin.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    // Keep the guard alive for the entire app lifetime
    // We leak it intentionally since the app runs until exit
    std::mem::forget(_guard);

    // Filter: INFO by default, DEBUG with RUST_LOG=debug
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("glitch_goblin=info"));

    fmt()
        .with_env_filter(filter)
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(false)
        .with_file(true)
        .with_line_number(true)
        .init();

    tracing::info!("Glitch Goblin starting");
}

fn main() {
    // Initialize structured logging
    init_logging();

    // Migrate config dir from kanban-runner to glitch-goblin if needed
    config::migrate_config_dir();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Mutex::new(AppState::new()))
        .setup(|app| {
            // Load settings (decrypts API token on the fly)
            let settings = config::load_settings().unwrap_or_default();

            // One-time migration: if token is plain-text, re-save encrypted
            if !settings.bug_sync.api_token.is_empty() {
                if let Err(e) = config::save_settings_to_disk(&settings) {
                    error!(error = %e, "Settings save error");
                }
            }

            // Load projects config
            let projects_config = config::load_projects().unwrap_or_default();
            let projects = projects_config.projects.clone();

            // Resolve default project
            let project = config::resolve_default_project().unwrap_or(None);

            // Open SQLite DB — SQLite ist die einzige Datenquelle
            let (board, kanban_path, data_dir, db_conn) = match &project {
                Some(p) => {
                    let dd = config::project_data_dir(&p.name).unwrap_or_default();
                    // Migrate old runtime data from .claude/ if needed
                    if let Err(e) = config::migrate_project_data(&p.path, &dd) {
                        warn!(error = %e, "Project data migration issue");
                    }

                    let conn = db::open(&dd).map_err(|e| {
                        error!(error = %e, "Datenbank konnte nicht geöffnet werden");
                        format!("Datenbank konnte nicht geöffnet werden: {e}")
                    })?;

                    // Run JSON → SQLite migration (no-op if already done)
                    if let Err(e) = db::migrate_from_json(&conn, &dd) {
                        warn!(error = %e, "JSON to SQLite migration issue");
                    }

                    // Load board from DB — SQLite ist die einzige Datenquelle
                    let board = db::load_board(&conn).map_err(|e| {
                        error!(error = %e, "Board konnte nicht geladen werden");
                        format!("Board konnte nicht aus der Datenbank geladen werden: {e}")
                    })?;

                    let kp = dd.join("kanban.json");
                    (board, kp, dd, Some(conn))
                }
                None => (
                    kanban::KanbanBoard {
                        project_name: String::new(),
                        tickets: Vec::new(),
                        next_ticket_id: 1,
                    },
                    std::path::PathBuf::new(),
                    std::path::PathBuf::new(),
                    None,
                ),
            };

            // Initialize state
            let state = app.state::<Mutex<AppState>>();
            let mut s = tauri::async_runtime::block_on(state.lock());
            s.board = board;
            s.project = project;
            s.projects = projects;
            s.kanban_path = kanban_path.clone();
            s.data_dir = data_dir;
            s.settings = settings;
            s.db = db_conn;

            // Register window-destroyed handler for terminal cleanup (primary path).
            // The Drop impl on AppState serves as an additional fallback.
            if let Some(main_win) = app.get_webview_window("main") {
                let ah = app.handle().clone();
                main_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::Destroyed = event {
                        let state_ref = ah.state::<Mutex<AppState>>();
                        // try_lock: Tokio executor may already be shutting down
                        if let Ok(mut st) = state_ref.try_lock() {
                            st.cleanup_terminals();
                            st.watcher_stop.store(true, Ordering::Relaxed);
                        };
                    }
                });
            }

            // Start Bug-Sync auto-poll timer (always runs, checks settings on each tick)
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut tick =
                        tokio::time::interval(tokio::time::Duration::from_secs(60));
                    tick.tick().await; // skip immediate first tick
                    loop {
                        tick.tick().await;
                        let state_ref = app_handle.state::<Mutex<AppState>>();

                        // Read only what is needed before the optional extra sleep.
                        let (enabled, interval) = {
                            let s = state_ref.lock().await;
                            let bs = &s.settings.bug_sync;
                            (bs.enabled, bs.interval_secs.max(60))
                        };
                        if !enabled {
                            continue;
                        }
                        if interval > 60 {
                            tokio::time::sleep(tokio::time::Duration::from_secs(
                                interval - 60,
                            ))
                            .await;
                        }

                        // Re-read credentials *after* the sleep so we always use
                        // the most current settings (avoids stale-token race).
                        let (api_url, api_token, enabled) = {
                            let s = state_ref.lock().await;
                            let bs = &s.settings.bug_sync;
                            (bs.api_url.clone(), bs.api_token.clone(), bs.enabled)
                        };
                        if !enabled || api_url.is_empty() {
                            continue;
                        }

                        match bugsync::fetch_unsynced_bugs(&api_url, &api_token).await {
                            Ok(bugs) if !bugs.is_empty() => {
                                if let Err(e) = app_handle.emit("bug-sync-available", bugs.len()) {
                                    warn!(error = %e, "Emit bug-sync-available failed");
                                }
                            }
                            _ => {}
                        }
                    }
                });
            }

            let project_name = s.project.as_ref().map(|p| p.name.as_str()).unwrap_or("<none>");
            let ticket_count = s.board.tickets.len();
            tracing::info!(
                project = project_name,
                tickets = ticket_count,
                "App initialized"
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Project management
            commands::get_board,
            commands::get_projects,
            commands::get_current_project,
            commands::switch_project,
            commands::add_project,
            commands::set_ticket_prefix,
            commands::remove_project,
            // Ticket operations
            commands::create_ticket,
            commands::update_ticket,
            commands::move_ticket,
            commands::delete_ticket,
            commands::archive_ticket,
            commands::unarchive_ticket,
            commands::get_archived_tickets,
            commands::start_ticket,
            commands::finish_ticket,
            commands::merge_ticket,
            // Utilities
            commands::check_uncommitted,
            commands::get_log_lines,
            commands::get_running_ticket,
            commands::list_agents,
            commands::list_commands_available,
            // Settings
            commands::get_settings,
            commands::save_settings,
            // Dialog
            commands::pick_folder,
            // Backup (Block A2)
            commands::list_backups,
            commands::restore_backup,
            // Export (Block D1)
            commands::export_log,
            // Agent Editor (Block E)
            commands::read_agent,
            commands::save_agent,
            commands::create_agent,
            commands::delete_agent,
            // Command Editor (Block E)
            commands::read_command,
            commands::save_command,
            commands::create_command,
            commands::delete_command,
            // Cross-Project (Block F)
            commands::move_ticket_to_project,
            // Terminal (Block A - Phase 3)
            commands::spawn_terminal,
            commands::write_terminal,
            commands::resize_terminal,
            commands::close_terminal,
            commands::list_available_shells,
            // Git View (Block B - Phase 3)
            commands::list_branches,
            commands::get_branch_diff,
            commands::get_file_diff,
            commands::get_commit_diff,
            commands::get_commit_file_diff,
            commands::delete_branch_cmd,
            commands::get_commit_log,
            // Working Tree Diff (Review)
            commands::get_working_diff,
            commands::get_working_file_diff,
            // Git Status & Safety
            commands::get_git_status,
            // Activity & Comments (Block C - Phase 3)
            commands::get_activity,
            commands::add_comment,
            commands::delete_comment,
            // Dashboard, Templates, Import/Export (Block D - Phase 3)
            commands::get_project_info,
            commands::list_templates,
            commands::save_templates,
            commands::create_ticket_from_template,
            commands::export_tickets,
            commands::import_tickets,
            // Deploy (Phase 4)
            commands::get_deploy_config,
            commands::save_deploy_config,
            commands::detect_deploy_env,
            commands::check_docker_status,
            commands::local_deploy,
            commands::local_deploy_stop,
            commands::live_deploy,
            // Bug-Sync (Portal Bug-Tracker)
            commands::sync_portal_bugs,
            commands::get_bug_sync_settings,
            // Version / Utilities
            commands::get_version,
            commands::get_log_file_path,
            // Claude Usage
            commands::get_claude_usage,
            // Git Push
            commands::push_branch,
            commands::push_current_branch,
            commands::abort_git_merge,
            commands::get_remote_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
