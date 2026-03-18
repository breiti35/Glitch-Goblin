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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Mutex::new(AppState::new()))
        .setup(|app| {
            // Load settings (decrypts API token on the fly)
            let settings = config::load_settings().unwrap_or_default();

            // One-time migration: if token is plain-text, re-save encrypted
            if !settings.bug_sync.api_token.is_empty() {
                let _ = config::save_settings_to_disk(&settings);
            }

            // Load projects config
            let projects_config = config::load_projects().unwrap_or_default();
            let projects = projects_config.projects.clone();

            // Resolve default project
            let project = config::resolve_default_project().unwrap_or(None);

            // Open SQLite DB + migrate JSON → SQLite if needed
            let (board, kanban_path, data_dir, db_conn) = match &project {
                Some(p) => {
                    let dd = config::project_data_dir(&p.name).unwrap_or_default();
                    // Migrate old runtime data from .claude/ if needed
                    let _ = config::migrate_project_data(&p.path, &dd);

                    let conn = db::open(&dd).ok();

                    // Run JSON → SQLite migration (no-op if already done)
                    if let Some(ref c) = conn {
                        let _ = db::migrate_from_json(c, &dd);
                    }

                    // Load board from DB (fallback: kanban.json)
                    let board = conn
                        .as_ref()
                        .and_then(|c| db::load_board(c).ok())
                        .unwrap_or_else(|| {
                            let kp = dd.join("kanban.json");
                            kanban::load_board(&kp).unwrap_or(kanban::KanbanBoard {
                                project_name: String::new(),
                                tickets: Vec::new(),
                                next_ticket_id: 1,
                            })
                        });

                    let kp = dd.join("kanban.json");
                    (board, kp, dd, conn)
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

            // Get owned AppHandle (it is 'static and Clone)
            let app_handle = app.handle().clone();

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

            // File watcher: only start when DB is unavailable (JSON fallback)
            if s.db.is_none() && kanban_path.exists() {
                let stop = s.watcher_stop.clone();
                if let Err(e) = kanban::watch_kanban(&kanban_path, app_handle.clone(), stop) {
                    s.log(format!("File watcher error: {e}"));
                }
            }

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
                                let _ = app_handle.emit("bug-sync-available", bugs.len());
                            }
                            _ => {}
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Project management
            commands::get_board,
            commands::get_projects,
            commands::get_current_project,
            commands::switch_project,
            commands::add_project,
            commands::remove_project,
            // Ticket operations
            commands::create_ticket,
            commands::update_ticket,
            commands::move_ticket,
            commands::delete_ticket,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
