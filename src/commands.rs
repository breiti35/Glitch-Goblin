use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

use crate::activity;
use crate::bugsync;
use crate::config::{self, ProjectEntry};
use crate::db;
use crate::deploy;
use crate::error::AppError;
use crate::git;
use crate::kanban::{self, Column, KanbanBoard, Ticket, TicketType};
use crate::state::{AppState, Settings};
use crate::terminal;

// ── Input Validation Helpers ──

/// Validate names used for agent/command file paths to prevent path traversal.
fn validate_safe_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Name must not be empty".to_string());
    }
    if name.contains("..") || name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(format!("Invalid name '{}': contains forbidden characters", name));
    }
    Ok(())
}

/// Validate backup filenames to prevent path traversal.
fn validate_backup_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() {
        return Err("Filename must not be empty".to_string());
    }
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') || filename.contains('\0') {
        return Err(format!("Invalid filename '{}': contains forbidden characters", filename));
    }
    if !filename.ends_with(".json") {
        return Err("Backup filename must end with .json".to_string());
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTicketResult {
    pub project_path: String,
    pub prompt: String,
    pub branch: String,
    pub ticket_id: String,
}

type State<'a> = tauri::State<'a, Mutex<AppState>>;

// ── Project Management ──

#[tauri::command]
pub async fn get_board(state: State<'_>) -> Result<KanbanBoard, String> {
    let s = state.lock().await;
    Ok(s.board.clone())
}

#[tauri::command]
pub async fn get_projects(state: State<'_>) -> Result<Vec<ProjectEntry>, String> {
    let s = state.lock().await;
    Ok(s.projects.clone())
}

#[tauri::command]
pub async fn get_current_project(state: State<'_>) -> Result<Option<ProjectEntry>, String> {
    let s = state.lock().await;
    Ok(s.project.clone())
}

#[tauri::command]
pub async fn switch_project(
    name: String,
    state: State<'_>,
    app: AppHandle,
) -> Result<KanbanBoard, String> {
    let mut s = state.lock().await;
    let project = s
        .projects
        .iter()
        .find(|p| p.name == name)
        .cloned()
        .ok_or_else(|| AppError::ProjectNotFound(name.clone()))?;

    // Validate project path still exists
    if !project.path.exists() {
        return Err(format!(
            "Projekt-Pfad existiert nicht mehr: {}",
            project.path.display()
        ));
    }

    let data_dir = config::project_data_dir(&project.name)?;
    // Migrate old runtime data from .claude/ if needed
    let _ = config::migrate_project_data(&project.path, &data_dir);

    // Open SQLite DB + run JSON migration if needed
    let new_conn = crate::db::open(&data_dir).map_err(|e| eprintln!("[db] open error: {e}")).ok();
    if let Some(ref conn) = new_conn {
        let _ = crate::db::migrate_from_json(conn, &data_dir);
    }

    // Load board from DB, fall back to JSON
    let kanban_path = data_dir.join("kanban.json");
    let board = new_conn
        .as_ref()
        .and_then(|c| crate::db::load_board(c).map_err(|e| eprintln!("[db] load_board error: {e}")).ok())
        .unwrap_or_else(|| kanban::load_board(&kanban_path).unwrap_or(kanban::KanbanBoard {
            project_name: String::new(),
            tickets: Vec::new(),
            next_ticket_id: 1,
        }));

    // Stop old watcher
    s.watcher_stop.store(true, Ordering::Relaxed);
    s.watcher_stop = Arc::new(AtomicBool::new(false));

    // File watcher: only when no DB
    if new_conn.is_none() {
        let stop = s.watcher_stop.clone();
        if let Err(e) = kanban::watch_kanban(&kanban_path, app.clone(), stop) {
            s.log(format!("File watcher error: {e}"));
        }
    }

    s.db = new_conn;
    s.board = board.clone();
    s.kanban_path = kanban_path;
    s.data_dir = data_dir;
    s.project = Some(project);
    s.log("Project switched".to_string());

    Ok(board)
}

#[tauri::command]
pub async fn add_project(
    name: String,
    path: String,
    state: State<'_>,
) -> Result<ProjectEntry, String> {
    config::add_project(&name, &path)?;
    let cfg = config::load_projects()?;
    let mut s = state.lock().await;
    s.projects = cfg.projects;
    let entry = s
        .projects
        .iter()
        .find(|p| p.name == name)
        .cloned()
        .ok_or_else(|| AppError::ProjectNotFound(name.clone()))?;
    Ok(entry)
}

#[tauri::command]
pub async fn remove_project(name: String, state: State<'_>) -> Result<(), String> {
    let mut cfg = config::load_projects()?;
    cfg.projects.retain(|p| p.name != name);
    if cfg.default_project.as_deref() == Some(&name) {
        cfg.default_project = cfg.projects.first().map(|p| p.name.clone());
    }
    config::save_projects(&cfg)?;
    let mut s = state.lock().await;
    s.projects = cfg.projects;
    Ok(())
}

// ── Ticket Operations ──

#[tauri::command]
pub async fn create_ticket(
    title: String,
    ticket_type: TicketType,
    description: String,
    prio: Option<String>,
    state: State<'_>,
) -> Result<Ticket, String> {
    let mut s = state.lock().await;
    let next_num = s.board.next_ticket_id;
    s.board.next_ticket_id += 1;
    let id = format!("GG-{:03}", next_num);
    let slug = kanban::slugify(&title);
    let ticket = Ticket {
        id: id.clone(),
        title,
        slug,
        ticket_type,
        column: Column::Backlog,
        description,
        prio,
        created_at: Some(kanban::now_iso()),
        started_at: None,
        review_at: None,
        done_at: None,
        has_changes: None,
        branch: None,
        tokens_used: None,
        cost_usd: None,
        model_used: None,
        comments: None,
        portal_bug_id: None,
        portal_bug_url: None,
    };
    s.board.tickets.push(ticket.clone());
    s.save_and_backup()?;
    s.log(format!("Created ticket {id}"));
    s.log_activity("ticket_created", Some(&ticket.id), Some(&ticket.title), None);
    Ok(ticket)
}

#[tauri::command]
pub async fn update_ticket(ticket: Ticket, state: State<'_>) -> Result<(), String> {
    let mut s = state.lock().await;
    let idx = s
        .board
        .tickets
        .iter()
        .position(|t| t.id == ticket.id)
        .ok_or_else(|| AppError::TicketNotFound(ticket.id.clone()))?;
    s.board.tickets[idx] = ticket;
    s.save_and_backup()?;
    Ok(())
}

#[tauri::command]
pub async fn move_ticket(
    ticket_id: String,
    target_column: Column,
    state: State<'_>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    let idx = s
        .board
        .tickets
        .iter()
        .position(|t| t.id == ticket_id)
        .ok_or_else(|| AppError::TicketNotFound(ticket_id.clone()))?;

    let current = s.board.tickets[idx].column.clone();

    // Validate allowed transitions
    let allowed = matches!(
        (&current, &target_column),
        (Column::Review, Column::Done)
            | (Column::Review, Column::Backlog)
            | (Column::Done, Column::Review)
            | (Column::Backlog, Column::Review)
            | (Column::Backlog, Column::Progress)
    );

    if !allowed {
        return Err(format!(
            "Cannot move from {} to {}",
            current.label(),
            target_column.label()
        ));
    }

    // Set timestamps based on transitions
    match (&current, &target_column) {
        (Column::Backlog, Column::Progress) => {
            s.board.tickets[idx].started_at = Some(kanban::now_iso());
        }
        (_, Column::Review) => {
            s.board.tickets[idx].review_at = Some(kanban::now_iso());
        }
        (_, Column::Done) => {
            s.board.tickets[idx].done_at = Some(kanban::now_iso());
        }
        _ => {}
    }

    s.board.tickets[idx].column = target_column.clone();
    s.save_and_backup()?;
    let detail = format!("{} -> {}", current.label(), target_column.label());
    s.log_activity("ticket_moved", Some(&ticket_id), None, Some(&detail));
    Ok(())
}

#[tauri::command]
pub async fn delete_ticket(ticket_id: String, state: State<'_>) -> Result<(), String> {
    let mut s = state.lock().await;
    let idx = s
        .board
        .tickets
        .iter()
        .position(|t| t.id == ticket_id)
        .ok_or_else(|| AppError::TicketNotFound(ticket_id.clone()))?;
    let title = s.board.tickets[idx].title.clone();
    s.board.tickets.remove(idx);
    s.save_and_backup()?;
    s.log_activity("ticket_deleted", Some(&ticket_id), Some(&title), None);
    Ok(())
}

// ── Ticket Execution (interactive terminal mode) ──

#[tauri::command]
pub async fn start_ticket(
    ticket_id: String,
    model: Option<String>,
    state: State<'_>,
    app: AppHandle,
) -> Result<StartTicketResult, String> {
    // Check git is available
    if tokio::process::Command::new("git")
        .arg("--version")
        .output()
        .await
        .is_err()
    {
        return Err("Git ist nicht installiert oder nicht im PATH".to_string());
    }

    // Pre-flight: verify git repo and clean state
    {
        let s = state.lock().await;
        let project_path = s.project_path()
            .ok_or(AppError::NoProjectSelected)?;

        if !git::is_git_repo(&project_path).await {
            return Err("Das Projektverzeichnis ist kein Git-Repository. Bitte initialisiere Git zuerst.".to_string());
        }

        if let Some(op) = git::has_in_progress_operation(&project_path).await {
            return Err(format!(
                "Ein {} ist noch in Arbeit. Bitte schließe diesen zuerst ab oder breche ihn ab.",
                op
            ));
        }
    }

    // Phase 1: Lock briefly to update state
    let (ticket, project_path, kanban_path) = {
        let mut s = state.lock().await;
        if s.running_ticket.is_some() {
            return Err("A ticket is already running".to_string());
        }
        let idx = s
            .board
            .tickets
            .iter()
            .position(|t| t.id == ticket_id)
            .ok_or_else(|| AppError::TicketNotFound(ticket_id.clone()))?;
        s.board.tickets[idx].column = Column::Progress;
        s.board.tickets[idx].started_at = Some(kanban::now_iso());
        s.board.tickets[idx].model_used = model;
        s.running_ticket = Some(ticket_id.clone());
        let ticket = s.board.tickets[idx].clone();
        let project_path = s
            .project_path()
            .ok_or(AppError::NoProjectSelected)?;
        let kanban_path = s.kanban_path.clone();
        s.save_and_backup()?;
        s.log(format!(
            "Starting {} - {}",
            ticket.id, ticket.title
        ));
        s.log_activity("ticket_started", Some(&ticket.id), Some(&ticket.title), None);
        (ticket, project_path, kanban_path)
    }; // Lock released

    // Create and checkout ticket branch
    let branch = git::checkout_branch(&project_path, &ticket).await?;

    // Store branch on ticket
    {
        let mut s = state.lock().await;
        if let Some(idx) = s.board.tickets.iter().position(|t| t.id == ticket_id) {
            s.board.tickets[idx].branch = Some(branch.clone());
            s.save_and_backup()?;
        }
    }

    let prompt = kanban::build_prompt_for(&ticket);
    let pp_str = git::strip_unc_prefix(&project_path)
        .to_string_lossy()
        .to_string();

    // Notify frontend of board change (re-read current state from DB or file)
    {
        let s = state.lock().await;
        let board_snapshot = s.db.as_ref().and_then(|c| crate::db::load_board(c).map_err(|e| eprintln!("[db] load_board error: {e}")).ok())
            .unwrap_or_else(|| kanban::load_board(&kanban_path).unwrap_or(KanbanBoard {
                project_name: String::new(),
                tickets: Vec::new(),
                next_ticket_id: 1,
            }));
        let _ = app.emit("board-changed", &board_snapshot);
    }

    Ok(StartTicketResult {
        project_path: pp_str,
        prompt,
        branch,
        ticket_id,
    })
}

#[tauri::command]
pub async fn finish_ticket(
    ticket_id: String,
    state: State<'_>,
    app: AppHandle,
) -> Result<(), String> {
    let (ticket, project_path, kanban_path, commit_prefix) = {
        let s = state.lock().await;
        let idx = s
            .board
            .tickets
            .iter()
            .position(|t| t.id == ticket_id)
            .ok_or_else(|| AppError::TicketNotFound(ticket_id.clone()))?;
        let ticket = s.board.tickets[idx].clone();
        let project_path = s
            .project_path()
            .ok_or(AppError::NoProjectSelected)?;
        let kanban_path = s.kanban_path.clone();
        let commit_prefix = s.settings.commit_prefix.clone();
        (ticket, project_path, kanban_path, commit_prefix)
    };

    // Auto-commit if there are uncommitted changes
    let clean_project = git::strip_unc_prefix(&project_path);
    let msg = format!(
        "{}{}: {}",
        commit_prefix, ticket.id, ticket.title
    );
    let committed = git::auto_commit(&clean_project, &msg).await?;

    // Move to Review
    {
        let mut s = state.lock().await;
        if let Some(idx) = s.board.tickets.iter().position(|t| t.id == ticket_id) {
            s.board.tickets[idx].column = Column::Review;
            s.board.tickets[idx].review_at = Some(kanban::now_iso());
            s.board.tickets[idx].has_changes = Some(committed);
            s.running_ticket = None;
            s.save_and_backup()?;
            s.log(format!(
                "Finished {} -> Review (committed={})",
                ticket_id, committed
            ));
            let title = s.board.tickets[idx].title.clone();
            s.log_activity("ticket_finished", Some(&ticket_id), Some(&title), None);
        }
    }

    {
        let s = state.lock().await;
        let board_snapshot = s.db.as_ref().and_then(|c| crate::db::load_board(c).map_err(|e| eprintln!("[db] load_board error: {e}")).ok())
            .unwrap_or_else(|| kanban::load_board(&kanban_path).unwrap_or(KanbanBoard {
                project_name: String::new(),
                tickets: Vec::new(),
                next_ticket_id: 1,
            }));
        let _ = app.emit("board-changed", &board_snapshot);
    }

    Ok(())
}

#[tauri::command]
pub async fn merge_ticket(
    ticket_id: String,
    state: State<'_>,
    app: AppHandle,
) -> Result<(), String> {
    let (ticket, project_path, kanban_path, auto_push) = {
        let s = state.lock().await;
        let idx = s
            .board
            .tickets
            .iter()
            .position(|t| t.id == ticket_id)
            .ok_or_else(|| AppError::TicketNotFound(ticket_id.clone()))?;
        let ticket = s.board.tickets[idx].clone();
        let project_path = s
            .project_path()
            .ok_or(AppError::NoProjectSelected)?;
        let kanban_path = s.kanban_path.clone();
        let auto_push = s.settings.auto_push_after_merge;
        (ticket, project_path, kanban_path, auto_push)
    };

    let branch = ticket
        .branch
        .as_deref()
        .ok_or_else(|| format!("Ticket {} has no branch", ticket_id))?;

    // Pre-flight: check for in-progress operations
    if let Some(op) = git::has_in_progress_operation(&project_path).await {
        return Err(format!(
            "Ein {} ist noch in Arbeit. Bitte schließe diesen zuerst ab bevor du mergst.",
            op
        ));
    }

    // Ensure we're on main
    git::checkout_main(&project_path).await?;

    // Merge the ticket branch
    git::merge_branch(&project_path, branch).await?;

    // Delete the merged branch (non-fatal)
    let _ = git::delete_branch(&project_path, branch, false).await;

    // Auto-push main to origin if enabled
    if auto_push && git::has_remote(&project_path).await {
        let main_branch = git::default_branch_name(&project_path).await;
        let _ = git::push_branch(&project_path, &main_branch).await;
    }

    // Update state: move to Done
    {
        let mut s = state.lock().await;
        if let Some(idx) = s.board.tickets.iter().position(|t| t.id == ticket_id) {
            s.board.tickets[idx].column = Column::Done;
            s.board.tickets[idx].done_at = Some(kanban::now_iso());
            let _ = s.save_and_backup();
            s.log(format!("{} merged -> Done", ticket_id));
            let title = s.board.tickets[idx].title.clone();
            s.log_activity("ticket_merged", Some(&ticket_id), Some(&title), None);
        }
    }

    {
        let s = state.lock().await;
        let board_snapshot = s.db.as_ref().and_then(|c| crate::db::load_board(c).map_err(|e| eprintln!("[db] load_board error: {e}")).ok())
            .unwrap_or_else(|| kanban::load_board(&kanban_path).unwrap_or(KanbanBoard {
                project_name: String::new(),
                tickets: Vec::new(),
                next_ticket_id: 1,
            }));
        let _ = app.emit("board-changed", &board_snapshot);
    }

    Ok(())
}

// ── Git Push Commands ──

#[tauri::command]
pub async fn push_branch(branch: String, state: State<'_>) -> Result<(), String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::push_branch(&project_path, &branch).await
}

#[tauri::command]
pub async fn push_current_branch(state: State<'_>) -> Result<(), String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    let branch = git::current_branch(&project_path).await?;
    git::push_branch(&project_path, &branch).await
}

#[tauri::command]
pub async fn abort_git_merge(state: State<'_>) -> Result<(), String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::abort_merge(&project_path).await
}

#[tauri::command]
pub async fn get_remote_info(state: State<'_>) -> Result<Option<String>, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    if git::has_remote(&project_path).await {
        Ok(Some(git::get_remote_url(&project_path).await?))
    } else {
        Ok(None)
    }
}

// ── Utilities ──

#[tauri::command]
pub async fn check_uncommitted(state: State<'_>) -> Result<bool, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::check_uncommitted(&project_path).await
}

#[tauri::command]
pub async fn get_log_lines(state: State<'_>) -> Result<Vec<String>, String> {
    let s = state.lock().await;
    Ok(s.log_lines.iter().cloned().collect())
}

#[tauri::command]
pub async fn get_running_ticket(state: State<'_>) -> Result<Option<String>, String> {
    let s = state.lock().await;
    Ok(s.running_ticket.clone())
}

#[tauri::command]
pub async fn list_agents(state: State<'_>) -> Result<Vec<String>, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    Ok(config::list_agents(&project_path))
}

#[tauri::command]
pub async fn list_commands_available(state: State<'_>) -> Result<Vec<String>, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    Ok(config::list_commands(&project_path))
}

// ── Settings ──

#[tauri::command]
pub async fn get_settings(state: State<'_>) -> Result<Settings, String> {
    let s = state.lock().await;
    Ok(s.settings.clone())
}

#[tauri::command]
pub async fn save_settings(mut settings: Settings, state: State<'_>) -> Result<(), String> {
    // Preserve existing API token if the frontend sends an empty one
    {
        let s = state.lock().await;
        if settings.bug_sync.api_token.is_empty() && !s.settings.bug_sync.api_token.is_empty() {
            settings.bug_sync.api_token = s.settings.bug_sync.api_token.clone();
        }
    }
    config::save_settings_to_disk(&settings)?;
    let mut s = state.lock().await;
    s.settings = settings;
    Ok(())
}

// ── Dialog ──

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let window = app.get_webview_window("main").ok_or("No main window")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.map(|f| f.to_string()));
    });
    rx.await.map_err(|_| "Dialog cancelled".to_string())
}

// ── Backup Commands (Block A2) ──

#[tauri::command]
pub async fn list_backups(state: State<'_>) -> Result<Vec<String>, String> {
    let s = state.lock().await;
    let backup_dir = s
        .kanban_path
        .parent()
        .ok_or("kanban.json has no parent")?
        .join("kanban-backups");

    if !backup_dir.exists() {
        return Ok(Vec::new());
    }

    let mut backups: Vec<String> = std::fs::read_dir(&backup_dir)
        .map_err(|e| format!("Failed to read backup dir: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .file_name()
                .map(|f| {
                    let name = f.to_string_lossy();
                    name.starts_with("kanban-") && name.ends_with(".json")
                })
                .unwrap_or(false)
        })
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();

    backups.sort();
    backups.reverse();
    Ok(backups)
}

#[tauri::command]
pub async fn restore_backup(
    filename: String,
    state: State<'_>,
    app: AppHandle,
) -> Result<KanbanBoard, String> {
    validate_backup_filename(&filename)?;
    let mut s = state.lock().await;
    let backup_dir = s
        .kanban_path
        .parent()
        .ok_or("kanban.json has no parent")?
        .join("kanban-backups");

    let backup_path = backup_dir.join(&filename);
    if !backup_path.exists() {
        return Err(format!("Backup '{}' not found", filename));
    }

    let board = kanban::load_board(&backup_path)?;
    s.board = board.clone();
    s.save_and_backup()?;
    s.log(format!("Restored backup: {}", filename));
    s.log_activity("backup_restored", None, None, Some(&filename));

    let _ = app.emit("board-changed", &board);
    Ok(board)
}

// ── Export (Block D1) ──

#[tauri::command]
pub async fn export_log(
    ticket_id: String,
    content: String,
    app: AppHandle,
) -> Result<(), String> {
    let now = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let default_name = format!("kanban-log-{}-{}.txt", ticket_id, now);

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .save_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });

    match rx.await {
        Ok(Some(path)) => {
            tokio::fs::write(&path, &content)
                .await
                .map_err(|e| format!("Failed to write log file: {e}"))?;
            Ok(())
        }
        Ok(None) => Ok(()), // User cancelled
        Err(_) => Err("Dialog error".to_string()),
    }
}

// ── Agent Editor (Block E) ──

#[tauri::command]
pub async fn read_agent(name: String, state: State<'_>) -> Result<String, String> {
    validate_safe_name(&name)?;
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    let agent_path = project_path
        .join(".claude")
        .join("agents")
        .join(format!("{}.md", name));
    tokio::fs::read_to_string(&agent_path)
        .await
        .map_err(|e| format!("Failed to read agent '{}': {e}", name))
}

#[tauri::command]
pub async fn save_agent(name: String, content: String, state: State<'_>) -> Result<(), String> {
    validate_safe_name(&name)?;
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    let agents_dir = project_path.join(".claude").join("agents");
    tokio::fs::create_dir_all(&agents_dir)
        .await
        .map_err(|e| format!("Failed to create agents dir: {e}"))?;
    let agent_path = agents_dir.join(format!("{}.md", name));
    tokio::fs::write(&agent_path, &content)
        .await
        .map_err(|e| format!("Failed to save agent '{}': {e}", name))
}

#[tauri::command]
pub async fn create_agent(name: String, state: State<'_>) -> Result<String, String> {
    validate_safe_name(&name)?;
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    let agents_dir = project_path.join(".claude").join("agents");
    tokio::fs::create_dir_all(&agents_dir)
        .await
        .map_err(|e| format!("Failed to create agents dir: {e}"))?;
    let agent_path = agents_dir.join(format!("{}.md", name));
    if agent_path.exists() {
        return Err(format!("Agent '{}' already exists", name));
    }
    let template = format!(
        "---\nname: {}\ndescription: \ntools: []\n---\n\n# {}\n\nBeschreibung des Agents...\n",
        name, name
    );
    tokio::fs::write(&agent_path, &template)
        .await
        .map_err(|e| format!("Failed to create agent '{}': {e}", name))?;
    Ok(template)
}

#[tauri::command]
pub async fn delete_agent(name: String, state: State<'_>) -> Result<(), String> {
    validate_safe_name(&name)?;
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    let agent_path = project_path
        .join(".claude")
        .join("agents")
        .join(format!("{}.md", name));
    tokio::fs::remove_file(&agent_path)
        .await
        .map_err(|e| format!("Failed to delete agent '{}': {e}", name))
}

// ── Command Editor (Block E) ──

#[tauri::command]
pub async fn read_command(name: String, state: State<'_>) -> Result<String, String> {
    validate_safe_name(&name)?;
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    let cmd_path = project_path
        .join(".claude")
        .join("commands")
        .join(format!("{}.md", name));
    tokio::fs::read_to_string(&cmd_path)
        .await
        .map_err(|e| format!("Failed to read command '{}': {e}", name))
}

#[tauri::command]
pub async fn save_command(name: String, content: String, state: State<'_>) -> Result<(), String> {
    validate_safe_name(&name)?;
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    let cmds_dir = project_path.join(".claude").join("commands");
    tokio::fs::create_dir_all(&cmds_dir)
        .await
        .map_err(|e| format!("Failed to create commands dir: {e}"))?;
    let cmd_path = cmds_dir.join(format!("{}.md", name));
    tokio::fs::write(&cmd_path, &content)
        .await
        .map_err(|e| format!("Failed to save command '{}': {e}", name))
}

#[tauri::command]
pub async fn create_command(name: String, state: State<'_>) -> Result<String, String> {
    validate_safe_name(&name)?;
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    let cmds_dir = project_path.join(".claude").join("commands");
    tokio::fs::create_dir_all(&cmds_dir)
        .await
        .map_err(|e| format!("Failed to create commands dir: {e}"))?;
    let cmd_path = cmds_dir.join(format!("{}.md", name));
    if cmd_path.exists() {
        return Err(format!("Command '{}' already exists", name));
    }
    let template = format!("# {}\n\nBeschreibung des Commands...\n", name);
    tokio::fs::write(&cmd_path, &template)
        .await
        .map_err(|e| format!("Failed to create command '{}': {e}", name))?;
    Ok(template)
}

#[tauri::command]
pub async fn delete_command(name: String, state: State<'_>) -> Result<(), String> {
    validate_safe_name(&name)?;
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    let cmd_path = project_path
        .join(".claude")
        .join("commands")
        .join(format!("{}.md", name));
    tokio::fs::remove_file(&cmd_path)
        .await
        .map_err(|e| format!("Failed to delete command '{}': {e}", name))
}

// ── Cross-Project (Block F) ──

#[tauri::command]
pub async fn move_ticket_to_project(
    ticket_id: String,
    target_project: String,
    state: State<'_>,
    app: AppHandle,
) -> Result<(), String> {
    let mut s = state.lock().await;

    // Find ticket in current board
    let idx = s
        .board
        .tickets
        .iter()
        .position(|t| t.id == ticket_id)
        .ok_or("Ticket not found")?;

    let mut ticket = s.board.tickets[idx].clone();

    // Find target project
    let target = s
        .projects
        .iter()
        .find(|p| p.name == target_project)
        .cloned()
        .ok_or_else(|| format!("Target project '{}' not found", target_project))?;

    let target_data_dir = config::project_data_dir(&target.name)?;
    let target_kanban_path = target_data_dir.join("kanban.json");
    let mut target_board = kanban::load_board(&target_kanban_path)?;

    // Re-generate ticket ID based on target board
    let next_num = target_board.next_ticket_id;
    target_board.next_ticket_id += 1;
    ticket.id = format!("GG-{:03}", next_num);
    ticket.column = Column::Backlog;
    ticket.branch = None;

    // Add to target board
    target_board.tickets.push(ticket);
    kanban::save_board(&target_kanban_path, &target_board)?;

    // Remove from current board
    s.board.tickets.remove(idx);
    s.save_and_backup()?;
    s.log(format!(
        "Moved ticket {} to project '{}'",
        ticket_id, target_project
    ));

    let _ = app.emit("board-changed", &s.board);
    Ok(())
}

// ── Terminal Commands (Phase 3 - Block A) ──

#[tauri::command]
pub async fn spawn_terminal(
    shell: String,
    cwd: String,
    state: State<'_>,
    app: AppHandle,
) -> Result<String, String> {
    // Validate shell against known shells to prevent arbitrary program execution
    let known_shells = terminal::detect_shells();
    if !known_shells.iter().any(|s| s.path == shell) {
        return Err(format!("Shell '{}' is not in the list of known shells", shell));
    }
    let terminal_id = uuid::Uuid::new_v4().to_string();
    let session =
        terminal::spawn_terminal(&shell, &cwd, terminal_id.clone(), app).await?;
    let mut s = state.lock().await;
    s.terminals.insert(terminal_id.clone(), session);
    s.log(format!("Terminal spawned: {terminal_id}"));
    Ok(terminal_id)
}

#[tauri::command]
pub async fn write_terminal(
    terminal_id: String,
    data: String,
    state: State<'_>,
) -> Result<(), String> {
    let s = state.lock().await;
    let session = s
        .terminals
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal '{}' not found", terminal_id))?;
    session
        .cmd_tx
        .send(terminal::TerminalCmd::Write(data))
        .map_err(|_| "Terminal channel closed".to_string())
}

#[tauri::command]
pub async fn resize_terminal(
    terminal_id: String,
    cols: u32,
    rows: u32,
    state: State<'_>,
) -> Result<(), String> {
    let s = state.lock().await;
    let session = s
        .terminals
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal '{}' not found", terminal_id))?;
    session
        .cmd_tx
        .send(terminal::TerminalCmd::Resize(cols, rows))
        .map_err(|_| "Terminal channel closed".to_string())
}

#[tauri::command]
pub async fn close_terminal(
    terminal_id: String,
    state: State<'_>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    if let Some(session) = s.terminals.remove(&terminal_id) {
        let _ = session.cmd_tx.send(terminal::TerminalCmd::Close);
        s.log(format!("Terminal closed: {terminal_id}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_available_shells() -> Result<Vec<terminal::ShellInfo>, String> {
    Ok(terminal::detect_shells())
}

// ── Git View Commands (Phase 3 - Block B) ──

#[tauri::command]
pub async fn list_branches(state: State<'_>) -> Result<Vec<git::BranchInfo>, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::list_branches(&project_path).await
}

#[tauri::command]
pub async fn get_branch_diff(
    branch: String,
    state: State<'_>,
) -> Result<git::DiffInfo, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::get_branch_diff(&project_path, &branch).await
}

#[tauri::command]
pub async fn get_file_diff(
    branch: String,
    file_path: String,
    state: State<'_>,
) -> Result<String, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::get_file_diff(&project_path, &branch, &file_path).await
}

#[tauri::command]
pub async fn get_commit_diff(
    commit_hash: String,
    state: State<'_>,
) -> Result<git::DiffInfo, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::get_commit_diff(&project_path, &commit_hash).await
}

#[tauri::command]
pub async fn get_commit_file_diff(
    commit_hash: String,
    file_path: String,
    state: State<'_>,
) -> Result<String, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::get_commit_file_diff(&project_path, &commit_hash, &file_path).await
}

#[tauri::command]
pub async fn delete_branch_cmd(
    branch: String,
    force: bool,
    state: State<'_>,
) -> Result<(), String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::delete_branch(&project_path, &branch, force).await
}

#[tauri::command]
pub async fn get_commit_log(
    branch: String,
    limit: u32,
    state: State<'_>,
) -> Result<Vec<git::CommitInfo>, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::get_commit_log(&project_path, &branch, limit).await
}

// ── Working Tree Diff (Review) ──

#[tauri::command]
pub async fn get_working_diff(state: State<'_>) -> Result<git::DiffInfo, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::get_working_diff(&project_path).await
}

#[tauri::command]
pub async fn get_working_file_diff(
    file_path: String,
    state: State<'_>,
) -> Result<String, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::get_working_file_diff(&project_path, &file_path).await
}

// ── Git Status & Safety ──

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusInfo {
    pub is_git_repo: bool,
    pub current_branch: String,
    pub is_detached: bool,
    pub is_dirty: bool,
    pub operation_in_progress: Option<String>,
    pub has_remote: bool,
    pub remote_url: Option<String>,
}

#[tauri::command]
pub async fn get_git_status(state: State<'_>) -> Result<GitStatusInfo, String> {
    let s = state.lock().await;
    let project_path = match s.project_path() {
        Some(p) => p,
        None => {
            return Ok(GitStatusInfo {
                is_git_repo: false,
                current_branch: String::new(),
                is_detached: false,
                is_dirty: false,
                operation_in_progress: None,
                has_remote: false,
                remote_url: None,
            })
        }
    };
    drop(s);

    if !git::is_git_repo(&project_path).await {
        return Ok(GitStatusInfo {
            is_git_repo: false,
            current_branch: String::new(),
            is_detached: false,
            is_dirty: false,
            operation_in_progress: None,
            has_remote: false,
            remote_url: None,
        });
    }

    let branch = git::current_branch(&project_path).await.unwrap_or_default();
    let is_detached = branch == "HEAD" || branch.is_empty();
    let is_dirty = git::check_uncommitted(&project_path).await.unwrap_or(false);
    let operation_in_progress = git::has_in_progress_operation(&project_path).await;
    let has_remote = git::has_remote(&project_path).await;
    let remote_url = if has_remote {
        git::get_remote_url(&project_path).await.ok()
    } else {
        None
    };

    Ok(GitStatusInfo {
        is_git_repo: true,
        current_branch: branch,
        is_detached,
        is_dirty,
        operation_in_progress,
        has_remote,
        remote_url,
    })
}

// ── Activity & Comments (Phase 3 - Block C) ──

#[tauri::command]
pub async fn get_activity(
    limit: u32,
    state: State<'_>,
) -> Result<Vec<activity::ActivityEntry>, String> {
    let s = state.lock().await;
    if let Some(conn) = &s.db {
        return Ok(db::get_activity(conn, limit as usize));
    }
    let data_dir = s
        .data_dir()
        .ok_or_else(|| AppError::NoProjectSelected.to_string())?;
    drop(s);
    Ok(activity::get_activity(&data_dir, limit as usize))
}

#[tauri::command]
pub async fn add_comment(
    ticket_id: String,
    text: String,
    state: State<'_>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    let idx = s
        .board
        .tickets
        .iter()
        .position(|t| t.id == ticket_id)
        .ok_or("Ticket not found")?;

    let comment = kanban::TicketComment {
        timestamp: kanban::now_iso(),
        text,
    };

    match &mut s.board.tickets[idx].comments {
        Some(comments) => comments.push(comment),
        None => s.board.tickets[idx].comments = Some(vec![comment]),
    }

    s.save_and_backup()?;
    Ok(())
}

#[tauri::command]
pub async fn delete_comment(
    ticket_id: String,
    comment_index: u32,
    state: State<'_>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    let idx = s
        .board
        .tickets
        .iter()
        .position(|t| t.id == ticket_id)
        .ok_or("Ticket not found")?;

    if let Some(comments) = &mut s.board.tickets[idx].comments {
        let ci = comment_index as usize;
        if ci < comments.len() {
            comments.remove(ci);
        }
    }

    s.save_and_backup()?;
    Ok(())
}

// ── Dashboard (Phase 3 - Block D) ──

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub readme_preview: Option<String>,
    pub tech_stack: Vec<String>,
    pub recent_commits: Vec<git::CommitInfo>,
    pub branch_count: u32,
    pub ticket_counts: std::collections::HashMap<String, u32>,
    pub agent_count: u32,
    pub command_count: u32,
    pub recent_activity: Vec<activity::ActivityEntry>,
}

#[tauri::command]
pub async fn get_project_info(state: State<'_>) -> Result<ProjectInfo, String> {
    let s = state.lock().await;
    let project_path = s
        .project_path()
        .ok_or_else(|| AppError::NoProjectSelected.to_string())?;
    let data_dir = s.data_dir();
    let recent_activity_db = s.db.as_ref().map(|conn| db::get_activity(conn, 5));
    let board = s.board.clone();
    drop(s);

    // README preview
    let readme_preview = ["README.md", "readme.md", "Readme.md"]
        .iter()
        .map(|f| project_path.join(f))
        .find(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.chars().take(500).collect::<String>());

    // Tech stack detection
    let mut tech_stack = Vec::new();
    let checks: &[(&str, &str)] = &[
        ("Cargo.toml", "Rust"),
        ("package.json", "Node.js"),
        ("requirements.txt", "Python"),
        ("pyproject.toml", "Python"),
        ("go.mod", "Go"),
        ("pom.xml", "Java"),
        ("build.gradle", "Java"),
        ("Gemfile", "Ruby"),
        ("composer.json", "PHP"),
    ];
    for (file, lang) in checks {
        if project_path.join(file).exists() && !tech_stack.contains(&lang.to_string()) {
            tech_stack.push(lang.to_string());
        }
    }

    // Recent commits
    let recent_commits = git::get_commit_log(&project_path, "HEAD", 5)
        .await
        .unwrap_or_default();

    // Branch count
    let branch_count = git::list_branches(&project_path)
        .await
        .map(|b| b.len() as u32)
        .unwrap_or(0);

    // Ticket counts
    let mut ticket_counts = std::collections::HashMap::new();
    for col in &["backlog", "progress", "review", "done"] {
        ticket_counts.insert(
            col.to_string(),
            board
                .tickets
                .iter()
                .filter(|t| {
                    let tc: &str = match &t.column {
                        Column::Backlog => "backlog",
                        Column::Progress => "progress",
                        Column::Review => "review",
                        Column::Done => "done",
                    };
                    tc == *col
                })
                .count() as u32,
        );
    }

    // Agent/command counts
    let agent_count = config::list_agents(&project_path).len() as u32;
    let command_count = config::list_commands(&project_path).len() as u32;

    // Recent activity
    let recent_activity = recent_activity_db.unwrap_or_else(|| {
        data_dir
            .map(|dd| activity::get_activity(&dd, 5))
            .unwrap_or_default()
    });

    Ok(ProjectInfo {
        readme_preview,
        tech_stack,
        recent_commits,
        branch_count,
        ticket_counts,
        agent_count,
        command_count,
        recent_activity,
    })
}

// ── Templates (Phase 3 - Block D) ──

#[tauri::command]
pub async fn list_templates(
    state: State<'_>,
) -> Result<Vec<config::TicketTemplate>, String> {
    let s = state.lock().await;
    if let Some(conn) = &s.db {
        let templates = db::load_templates(conn);
        return Ok(if templates.is_empty() {
            // Seed defaults on first access
            let defaults = config::default_templates_pub();
            let _ = db::save_templates(conn, &defaults);
            defaults
        } else {
            templates
        });
    }
    let data_dir = s
        .data_dir()
        .ok_or_else(|| AppError::NoProjectSelected.to_string())?;
    drop(s);
    Ok(config::load_templates(&data_dir))
}

#[tauri::command]
pub async fn save_templates(
    templates: Vec<config::TicketTemplate>,
    state: State<'_>,
) -> Result<(), String> {
    let s = state.lock().await;
    if let Some(conn) = &s.db {
        return db::save_templates(conn, &templates);
    }
    let data_dir = s
        .data_dir()
        .ok_or_else(|| AppError::NoProjectSelected.to_string())?;
    drop(s);
    config::save_templates(&data_dir, &templates)
}

#[tauri::command]
pub async fn create_ticket_from_template(
    template_name: String,
    title: String,
    state: State<'_>,
) -> Result<Ticket, String> {
    let mut s = state.lock().await;
    let data_dir = s.data_dir().ok_or("No project data directory")?;
    let templates = config::load_templates(&data_dir);
    let tpl = templates
        .iter()
        .find(|t| t.name == template_name)
        .ok_or_else(|| format!("Template '{}' not found", template_name))?;

    let next_num = s.board.next_ticket_id;
    s.board.next_ticket_id += 1;
    let id = format!("GG-{:03}", next_num);
    let full_title = format!("{}{}", tpl.title_prefix, title);
    let slug = kanban::slugify(&full_title);
    let ticket_type = match tpl.ticket_type.as_str() {
        "bugfix" => TicketType::Bugfix,
        "security" => TicketType::Security,
        "docs" => TicketType::Docs,
        _ => TicketType::Feature,
    };

    let ticket = Ticket {
        id: id.clone(),
        title: full_title,
        slug,
        ticket_type,
        column: Column::Backlog,
        description: tpl.description_template.clone(),
        prio: if tpl.default_prio.is_empty() {
            None
        } else {
            Some(tpl.default_prio.clone())
        },
        created_at: Some(kanban::now_iso()),
        started_at: None,
        review_at: None,
        done_at: None,
        has_changes: None,
        branch: None,
        tokens_used: None,
        cost_usd: None,
        model_used: None,
        comments: None,
        portal_bug_id: None,
        portal_bug_url: None,
    };

    s.board.tickets.push(ticket.clone());
    s.save_and_backup()?;
    s.log(format!("Created ticket {} from template '{}'", id, template_name));
    s.log_activity(
        "ticket_created",
        Some(&ticket.id),
        Some(&ticket.title),
        Some(&format!("template: {}", template_name)),
    );
    Ok(ticket)
}

// ── Import/Export (Phase 3 - Block D) ──

#[tauri::command]
pub async fn export_tickets(
    format: String,
    state: State<'_>,
    app: AppHandle,
) -> Result<(), String> {
    let s = state.lock().await;
    let board = s.board.clone();
    drop(s);

    let (default_name, content) = match format.as_str() {
        "csv" => {
            let mut wtr = csv::Writer::from_writer(Vec::new());
            // BOM for Excel compatibility
            let mut buf = vec![0xEF, 0xBB, 0xBF];
            wtr.write_record(["id", "title", "type", "priority", "column", "description", "created_at"])
                .map_err(|e| format!("CSV header error: {e}"))?;
            for t in &board.tickets {
                let col = match &t.column {
                    Column::Backlog => "backlog",
                    Column::Progress => "progress",
                    Column::Review => "review",
                    Column::Done => "done",
                };
                wtr.write_record([
                    &t.id,
                    &t.title,
                    &format!("{:?}", t.ticket_type).to_lowercase(),
                    t.prio.as_deref().unwrap_or(""),
                    col,
                    &t.description,
                    t.created_at.as_deref().unwrap_or(""),
                ])
                .map_err(|e| format!("CSV write error: {e}"))?;
            }
            let csv_bytes = wtr.into_inner().map_err(|e| format!("CSV flush: {e}"))?;
            buf.extend_from_slice(&csv_bytes);
            ("kanban-export.csv".to_string(), buf)
        }
        _ => {
            let json = serde_json::to_string_pretty(&board)
                .map_err(|e| format!("JSON serialize: {e}"))?;
            ("kanban-export.json".to_string(), json.into_bytes())
        }
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .save_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });

    match rx.await {
        Ok(Some(path)) => {
            tokio::fs::write(&path, &content)
                .await
                .map_err(|e| format!("Write failed: {e}"))?;
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(_) => Err("Dialog error".to_string()),
    }
}

#[tauri::command]
pub async fn import_tickets(
    mode: String,
    state: State<'_>,
    app: AppHandle,
) -> Result<KanbanBoard, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });

    let path = match rx.await {
        Ok(Some(p)) => p,
        Ok(None) => return Err("Cancelled".to_string()),
        Err(_) => return Err("Dialog error".to_string()),
    };

    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Read failed: {e}"))?;

    let mut s = state.lock().await;

    if path.ends_with(".csv") {
        // CSV import: create new tickets in backlog
        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_reader(content.trim_start_matches('\u{FEFF}').as_bytes());

        let mut new_tickets = Vec::new();
        for result in rdr.records() {
            let record = result.map_err(|e| format!("CSV parse: {e}"))?;
            if record.len() < 3 {
                continue;
            }
            let next_num = s.board.next_ticket_id.saturating_add(new_tickets.len() as u32);
            let id = format!("GG-{:03}", next_num);
            let title = record.get(1).unwrap_or("").to_string();
            let ticket_type = match record.get(2).unwrap_or("feature") {
                "bugfix" => TicketType::Bugfix,
                "security" => TicketType::Security,
                "docs" => TicketType::Docs,
                _ => TicketType::Feature,
            };
            new_tickets.push(Ticket {
                id,
                slug: kanban::slugify(&title),
                title,
                ticket_type,
                column: Column::Backlog,
                description: record.get(5).unwrap_or("").to_string(),
                prio: record.get(3).filter(|s| !s.is_empty()).map(|s| s.to_string()),
                created_at: Some(kanban::now_iso()),
                started_at: None,
                review_at: None,
                done_at: None,
                has_changes: None,
                branch: None,
                tokens_used: None,
                cost_usd: None,
                model_used: None,
                comments: None,
                portal_bug_id: None,
                portal_bug_url: None,
            });
        }
        s.board.next_ticket_id = s.board.next_ticket_id.saturating_add(new_tickets.len() as u32);
        s.board.tickets.extend(new_tickets);
    } else {
        // JSON import
        let imported: KanbanBoard =
            serde_json::from_str(&content).map_err(|e| format!("JSON parse: {e}"))?;

        if mode == "replace" {
            s.board = imported;
        } else {
            // Append to backlog
            for mut t in imported.tickets {
                let next_num = s.board.next_ticket_id;
                s.board.next_ticket_id += 1;
                t.id = format!("GG-{:03}", next_num);
                t.column = Column::Backlog;
                t.branch = None;
                s.board.tickets.push(t);
            }
        }
    }

    s.save_and_backup()?;
    s.log("Tickets imported".to_string());
    s.log_activity("tickets_imported", None, None, Some(&mode));
    Ok(s.board.clone())
}

// ── Deploy Commands (Phase 4) ──

#[tauri::command]
pub async fn get_deploy_config(state: State<'_>) -> Result<deploy::DeployConfig, String> {
    let s = state.lock().await;
    if let Some(conn) = &s.db {
        return Ok(db::load_deploy_config(conn).unwrap_or_default());
    }
    let data_dir = s
        .data_dir()
        .ok_or_else(|| AppError::NoProjectSelected.to_string())?;
    drop(s);
    Ok(deploy::load_deploy_config(&data_dir))
}

#[tauri::command]
pub async fn save_deploy_config(
    config: deploy::DeployConfig,
    state: State<'_>,
) -> Result<(), String> {
    let s = state.lock().await;
    if let Some(conn) = &s.db {
        return db::save_deploy_config(conn, &config);
    }
    let data_dir = s
        .data_dir()
        .ok_or_else(|| AppError::NoProjectSelected.to_string())?;
    drop(s);
    deploy::save_deploy_config(&data_dir, &config)
}

#[tauri::command]
pub async fn detect_deploy_env(
    state: State<'_>,
) -> Result<deploy::DeployEnvironment, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    Ok(deploy::detect_deploy_environment(&project_path).await)
}

#[tauri::command]
pub async fn check_docker_status(
    state: State<'_>,
) -> Result<deploy::DockerStatus, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    Ok(deploy::check_docker(&project_path).await)
}

#[tauri::command]
pub async fn local_deploy(
    state: State<'_>,
    app: AppHandle,
) -> Result<String, String> {
    let (project_path, config, shell) = {
        let s = state.lock().await;
        let pp = s.project_path().ok_or_else(|| AppError::NoProjectSelected.to_string())?;
        let cfg = if let Some(conn) = &s.db {
            db::load_deploy_config(conn).unwrap_or_default()
        } else {
            let dd = s.data_dir().ok_or_else(|| AppError::NoProjectSelected.to_string())?;
            deploy::load_deploy_config(&dd)
        };
        let shell = s.settings.default_shell.clone();
        (pp, cfg, shell)
    };

    let cwd = project_path.to_string_lossy().to_string();
    let shell = resolve_validated_shell(&shell)?;

    let terminal_id = uuid::Uuid::new_v4().to_string();
    let session =
        terminal::spawn_terminal(&shell, &cwd, terminal_id.clone(), app).await?;

    let mut s = state.lock().await;
    s.terminals.insert(terminal_id.clone(), session);
    let cmd = deploy::build_compose_command(&config, &project_path, "up")?;
    s.log(format!("Local deploy started: {cmd}"));
    s.log_activity("local_deploy", None, None, Some(&cmd));

    Ok(terminal_id)
}

#[tauri::command]
pub async fn local_deploy_stop(
    state: State<'_>,
    app: AppHandle,
) -> Result<String, String> {
    let (project_path, config, shell) = {
        let s = state.lock().await;
        let pp = s.project_path().ok_or_else(|| AppError::NoProjectSelected.to_string())?;
        let cfg = if let Some(conn) = &s.db {
            db::load_deploy_config(conn).unwrap_or_default()
        } else {
            let dd = s.data_dir().ok_or_else(|| AppError::NoProjectSelected.to_string())?;
            deploy::load_deploy_config(&dd)
        };
        let shell = s.settings.default_shell.clone();
        (pp, cfg, shell)
    };

    let cwd = project_path.to_string_lossy().to_string();
    let shell = resolve_validated_shell(&shell)?;

    let terminal_id = uuid::Uuid::new_v4().to_string();
    let session =
        terminal::spawn_terminal(&shell, &cwd, terminal_id.clone(), app).await?;

    let mut s = state.lock().await;
    s.terminals.insert(terminal_id.clone(), session);
    let cmd = deploy::build_compose_command(&config, &project_path, "down")?;
    s.log(format!("Local deploy stop: {cmd}"));

    Ok(terminal_id)
}

#[tauri::command]
pub async fn live_deploy(
    state: State<'_>,
    app: AppHandle,
) -> Result<String, String> {
    let (project_path, config, shell) = {
        let s = state.lock().await;
        let pp = s.project_path().ok_or_else(|| AppError::NoProjectSelected.to_string())?;
        let cfg = if let Some(conn) = &s.db {
            db::load_deploy_config(conn).unwrap_or_default()
        } else {
            let dd = s.data_dir().ok_or_else(|| AppError::NoProjectSelected.to_string())?;
            deploy::load_deploy_config(&dd)
        };
        if !cfg.live_enabled {
            return Err("Live deploy is not enabled".to_string());
        }
        if cfg.ssh_host.is_empty() {
            return Err("SSH host is not configured".to_string());
        }
        let shell = s.settings.default_shell.clone();
        (pp, cfg, shell)
    };

    let cwd = project_path.to_string_lossy().to_string();
    let shell = resolve_validated_shell(&shell)?;

    let terminal_id = uuid::Uuid::new_v4().to_string();
    let session =
        terminal::spawn_terminal(&shell, &cwd, terminal_id.clone(), app).await?;

    let mut s = state.lock().await;
    s.terminals.insert(terminal_id.clone(), session);
    s.log(format!("Live deploy started to {}", config.ssh_host));
    s.log_activity("live_deploy", None, None, Some(&format!("host: {}", config.ssh_host)));

    Ok(terminal_id)
}

fn detect_default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// Resolve and validate the shell to use, falling back to default if empty.
fn resolve_validated_shell(shell: &str) -> Result<String, String> {
    let resolved = if shell.is_empty() {
        detect_default_shell()
    } else {
        shell.to_string()
    };
    let known_shells = terminal::detect_shells();
    if !known_shells.iter().any(|s| s.path == resolved) {
        return Err(format!("Shell '{}' is not in the list of known shells", resolved));
    }
    Ok(resolved)
}

// ── Bug-Sync (Portal Bug-Tracker) ──

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BugSyncResult {
    pub synced_count: usize,
    pub tickets: Vec<Ticket>,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn sync_portal_bugs(
    state: State<'_>,
) -> Result<BugSyncResult, String> {
    let (api_url, api_token) = {
        let s = state.lock().await;
        let bs = &s.settings.bug_sync;
        if bs.api_url.is_empty() {
            return Err("Bug-Sync: API URL not configured".to_string());
        }
        (bs.api_url.clone(), bs.api_token.clone())
    };

    let bugs = bugsync::fetch_unsynced_bugs(&api_url, &api_token).await?;

    if bugs.is_empty() {
        return Ok(BugSyncResult {
            synced_count: 0,
            tickets: Vec::new(),
            errors: Vec::new(),
        });
    }

    let mut synced_tickets = Vec::new();
    let mut bug_ids = Vec::new();
    let mut ticket_ids = Vec::new();
    let mut errors = Vec::new();

    {
        let mut s = state.lock().await;

        let existing_bug_ids: std::collections::HashSet<u64> = s
            .board
            .tickets
            .iter()
            .filter_map(|t| t.portal_bug_id)
            .collect();

        for bug in &bugs {
            if existing_bug_ids.contains(&bug.id) {
                continue;
            }

            let next_num = s.board.next_ticket_id;
            s.board.next_ticket_id += 1;
            let id = format!("GG-{:03}", next_num);
            let slug = kanban::slugify(&bug.title);

            let mut desc_parts = Vec::new();
            if !bug.description.is_empty() {
                desc_parts.push(bug.description.clone());
            }
            if let Some(cat) = &bug.category {
                desc_parts.push(format!("Kategorie: {cat}"));
            }
            if let Some(reporter) = &bug.reporter_name {
                desc_parts.push(format!("Gemeldet von: {reporter}"));
            }
            if let Some(screenshot) = &bug.screenshot_url {
                desc_parts.push(format!("Screenshot: {screenshot}"));
            }
            let description = desc_parts.join("\n\n");

            let ticket = Ticket {
                id: id.clone(),
                title: bug.title.clone(),
                slug,
                ticket_type: TicketType::Bugfix,
                column: Column::Backlog,
                description,
                prio: Some("high".to_string()),
                created_at: Some(kanban::now_iso()),
                started_at: None,
                review_at: None,
                done_at: None,
                has_changes: None,
                branch: None,
                tokens_used: None,
                cost_usd: None,
                model_used: None,
                comments: None,
                portal_bug_id: Some(bug.id),
                portal_bug_url: bug.portal_url.clone(),
            };

            s.board.tickets.push(ticket.clone());
            synced_tickets.push(ticket);
            bug_ids.push(bug.id);
            ticket_ids.push(id.clone());

            s.log(format!(
                "Bug-Sync: Created ticket {id} from Portal Bug #{}",
                bug.id
            ));

            s.log_activity(
                "bug_synced",
                Some(&id),
                Some(&bug.title),
                Some(&format!("Portal Bug #{}", bug.id)),
            );
        }

        if !synced_tickets.is_empty() {
            s.save_and_backup()?;
        }
    }

    if !bug_ids.is_empty() {
        if let Err(e) =
            bugsync::mark_bugs_synced(&api_url, &api_token, &bug_ids, &ticket_ids).await
        {
            errors.push(e);
        }
    }

    Ok(BugSyncResult {
        synced_count: synced_tickets.len(),
        tickets: synced_tickets,
        errors,
    })
}

#[derive(Clone, Serialize)]
pub struct BugSyncSettingsResponse {
    pub enabled: bool,
    pub api_url: String,
    pub api_token_set: bool,
    pub interval_secs: u64,
}

#[tauri::command]
pub async fn get_bug_sync_settings(
    state: State<'_>,
) -> Result<BugSyncSettingsResponse, String> {
    let s = state.lock().await;
    let bs = &s.settings.bug_sync;
    Ok(BugSyncSettingsResponse {
        enabled: bs.enabled,
        api_url: bs.api_url.clone(),
        api_token_set: !bs.api_token.is_empty(),
        interval_secs: bs.interval_secs,
    })
}

#[tauri::command]
pub fn get_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

// ── Claude Usage (OAuth API) ──

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub five_hour: f64,
    pub seven_day: f64,
    pub five_hour_resets_at: String,
    pub seven_day_resets_at: String,
    pub available: bool,
}

/// Cached usage result to avoid hammering the API.
static USAGE_CACHE: std::sync::LazyLock<tokio::sync::Mutex<Option<(std::time::Instant, ClaudeUsage)>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));

#[tauri::command]
pub async fn get_claude_usage() -> Result<ClaudeUsage, String> {
    // Check cache (60 seconds)
    {
        let cache = USAGE_CACHE.lock().await;
        if let Some((ts, ref usage)) = *cache {
            if ts.elapsed().as_secs() < 60 {
                return Ok(usage.clone());
            }
        }
    }

    // Read OAuth token from ~/.claude/.credentials.json
    let home = dirs::home_dir().ok_or("Home directory not found")?;
    let creds_path = home.join(".claude").join(".credentials.json");
    let creds_content = tokio::fs::read_to_string(&creds_path)
        .await
        .map_err(|e| format!("Credentials not found: {e}"))?;
    let creds: serde_json::Value = serde_json::from_str(&creds_content)
        .map_err(|e| format!("Invalid credentials JSON: {e}"))?;
    let token = creds
        .pointer("/claudeAiOauth/accessToken")
        .and_then(|v| v.as_str())
        .ok_or("OAuth access token not found in credentials")?;

    // Call Anthropic OAuth usage API
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("Usage API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Usage API returned {status}: {body}"));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse usage response: {e}"))?;

    let usage = ClaudeUsage {
        five_hour: body
            .pointer("/five_hour/utilization")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        seven_day: body
            .pointer("/seven_day/utilization")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        five_hour_resets_at: body
            .pointer("/five_hour/resets_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        seven_day_resets_at: body
            .pointer("/seven_day/resets_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        available: true,
    };

    // Update cache
    {
        let mut cache = USAGE_CACHE.lock().await;
        *cache = Some((std::time::Instant::now(), usage.clone()));
    }

    Ok(usage)
}
