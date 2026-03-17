mod activity;
mod commands;
mod config;
mod deploy;
mod git;
mod kanban;
mod runner;
mod state;
mod terminal;

use state::AppState;
use tokio::sync::Mutex;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Mutex::new(AppState::new()))
        .setup(|app| {
            use tauri::Manager;

            // Load settings
            let settings = config::load_settings().unwrap_or_default();

            // Load projects config
            let projects_config = config::load_projects().unwrap_or_default();
            let projects = projects_config.projects.clone();

            // Resolve default project
            let project = config::resolve_default_project().unwrap_or(None);

            // Load board if project exists
            let (board, kanban_path) = match &project {
                Some(p) => {
                    let kp = p.path.join(".claude").join("kanban.json");
                    let board = kanban::load_board(&kp).unwrap_or(kanban::KanbanBoard {
                        project_name: String::new(),
                        tickets: Vec::new(),
                    });
                    (board, kp)
                }
                None => (
                    kanban::KanbanBoard {
                        project_name: String::new(),
                        tickets: Vec::new(),
                    },
                    std::path::PathBuf::new(),
                ),
            };

            // Initialize state
            let state = app.state::<Mutex<AppState>>();
            let mut s = tauri::async_runtime::block_on(state.lock());
            s.board = board;
            s.project = project;
            s.projects = projects;
            s.kanban_path = kanban_path.clone();
            s.settings = settings;

            // Start file watcher
            if kanban_path.exists() {
                let stop = s.watcher_stop.clone();
                if let Err(e) = kanban::watch_kanban(&kanban_path, app.handle().clone(), stop) {
                    s.log(format!("File watcher error: {e}"));
                }
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
