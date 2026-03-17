use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

use crate::activity;
use crate::config::{self, ProjectEntry};
use crate::git;
use crate::kanban::{self, Column, KanbanBoard, Ticket, TicketType};
use crate::state::{AppState, Settings};
use crate::terminal;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTicketResult {
    pub worktree_path: String,
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
        .ok_or_else(|| format!("Project '{}' not found", name))?;

    let kanban_path = project.path.join(".claude").join("kanban.json");
    let board = kanban::load_board(&kanban_path)?;

    // Stop old watcher
    s.watcher_stop.store(true, Ordering::Relaxed);
    s.watcher_stop = Arc::new(AtomicBool::new(false));

    // Start new watcher
    let stop = s.watcher_stop.clone();
    if let Err(e) = kanban::watch_kanban(&kanban_path, app.clone(), stop) {
        s.log(format!("File watcher error: {e}"));
    }

    s.board = board.clone();
    s.kanban_path = kanban_path;
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
        .ok_or("Project not found after adding")?;
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
    let next_num = s.board.tickets.len() + 1;
    let id = format!("KANBAN-{:03}", next_num);
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
    };
    s.board.tickets.push(ticket.clone());
    s.save_and_backup()?;
    s.log(format!("Created ticket {id}"));
    if let Some(pp) = s.project_path() {
        activity::log_activity(&pp, "ticket_created", Some(&ticket.id), Some(&ticket.title), None);
    }
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
        .ok_or("Ticket not found")?;
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
        .ok_or("Ticket not found")?;

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
    if let Some(pp) = s.project_path() {
        let detail = format!("{} -> {}", current.label(), target_column.label());
        activity::log_activity(&pp, "ticket_moved", Some(&ticket_id), None, Some(&detail));
    }
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
        .ok_or("Ticket not found")?;
    let title = s.board.tickets[idx].title.clone();
    s.board.tickets.remove(idx);
    s.save_and_backup()?;
    if let Some(pp) = s.project_path() {
        activity::log_activity(&pp, "ticket_deleted", Some(&ticket_id), Some(&title), None);
    }
    Ok(())
}

// ── Ticket Execution (interactive terminal mode) ──

#[tauri::command]
pub async fn start_ticket(
    ticket_id: String,
    state: State<'_>,
    app: AppHandle,
) -> Result<StartTicketResult, String> {
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
            .ok_or_else(|| "Ticket not found".to_string())?;
        s.board.tickets[idx].column = Column::Progress;
        s.board.tickets[idx].started_at = Some(kanban::now_iso());
        s.running_ticket = Some(ticket_id.clone());
        let ticket = s.board.tickets[idx].clone();
        let project_path = s.project_path().ok_or("No project selected")?;
        let kanban_path = s.kanban_path.clone();
        s.save_and_backup()?;
        s.log(format!(
            "Starting {} - {}",
            ticket.id, ticket.title
        ));
        activity::log_activity(
            &project_path,
            "ticket_started",
            Some(&ticket.id),
            Some(&ticket.title),
            None,
        );
        (ticket, project_path, kanban_path)
    }; // Lock released

    // Phase 2: Git setup (no lock held)
    git::create_branch(&project_path, &ticket).await?;
    let wt_path = git::create_worktree(&project_path, &ticket).await?;
    git::copy_claude_config(&project_path, &wt_path).await?;

    let prompt = kanban::build_prompt_for(&ticket);
    let branch = git::branch_name(&ticket);
    let wt_str = git::strip_unc_prefix(&wt_path)
        .to_string_lossy()
        .to_string();

    // Notify frontend of board change
    let _ = app.emit(
        "board-changed",
        &kanban::load_board(&kanban_path).unwrap_or(KanbanBoard {
            project_name: String::new(),
            tickets: Vec::new(),
        }),
    );

    Ok(StartTicketResult {
        worktree_path: wt_str,
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
            .ok_or_else(|| "Ticket not found".to_string())?;
        let ticket = s.board.tickets[idx].clone();
        let project_path = s.project_path().ok_or("No project selected")?;
        let kanban_path = s.kanban_path.clone();
        let commit_prefix = s.settings.commit_prefix.clone();
        (ticket, project_path, kanban_path, commit_prefix)
    };

    // Auto-commit changes from worktree
    let wt_path = git::worktree_dir(&project_path, &ticket);
    if wt_path.exists() {
        let commit_msg = format!("{} {} - {}", commit_prefix, ticket.id, ticket.title);
        let _ = git::auto_commit(&wt_path, &commit_msg).await;
        let _ = git::cleanup_worktree(&project_path, &ticket).await;
    }

    // Update state
    {
        let mut s = state.lock().await;
        s.running_ticket = None;
        if let Some(idx) = s.board.tickets.iter().position(|t| t.id == ticket_id) {
            s.board.tickets[idx].column = Column::Review;
            s.board.tickets[idx].review_at = Some(kanban::now_iso());
            s.board.tickets[idx].branch = Some(git::branch_name(&ticket));
            s.log(format!("{} finished -> Review", ticket_id));
            activity::log_activity(
                &project_path,
                "ticket_completed",
                Some(&ticket_id),
                Some(&ticket.title),
                None,
            );
            let _ = s.save_and_backup();
        }
    }

    // Notify frontend
    let _ = app.emit(
        "board-changed",
        &kanban::load_board(&kanban_path).unwrap_or(KanbanBoard {
            project_name: String::new(),
            tickets: Vec::new(),
        }),
    );

    Ok(())
}

#[tauri::command]
pub async fn merge_ticket(
    ticket_id: String,
    state: State<'_>,
    app: AppHandle,
) -> Result<(), String> {
    let (branch, project_path, kanban_path) = {
        let s = state.lock().await;
        let idx = s
            .board
            .tickets
            .iter()
            .position(|t| t.id == ticket_id)
            .ok_or("Ticket not found")?;
        let branch = s.board.tickets[idx]
            .branch
            .clone()
            .ok_or("Ticket has no branch to merge")?;
        let project_path = s.project_path().ok_or("No project selected")?;
        (branch, project_path, s.kanban_path.clone())
    };

    git::merge_branch(&project_path, &branch).await?;

    {
        let mut s = state.lock().await;
        if let Some(idx) = s.board.tickets.iter().position(|t| t.id == ticket_id) {
            s.board.tickets[idx].column = Column::Done;
            s.board.tickets[idx].done_at = Some(kanban::now_iso());
            let _ = s.save_and_backup();
            s.log(format!("Merged {} successfully", ticket_id));
            let title = s.board.tickets[idx].title.clone();
            activity::log_activity(&project_path, "ticket_merged", Some(&ticket_id), Some(&title), Some(&branch));
        }
    }

    if let Ok(board) = kanban::load_board(&kanban_path) {
        let _ = app.emit("board-changed", &board);
    }

    Ok(())
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
    Ok(s.log_lines.clone())
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
pub async fn save_settings(settings: Settings, state: State<'_>) -> Result<(), String> {
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
    kanban::save_board(&s.kanban_path, &board)?;
    s.board = board.clone();
    s.log(format!("Restored backup: {}", filename));
    if let Some(pp) = s.project_path() {
        activity::log_activity(&pp, "backup_restored", None, None, Some(&filename));
    }

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

    let target_kanban_path = target.path.join(".claude").join("kanban.json");
    let mut target_board = kanban::load_board(&target_kanban_path)?;

    // Re-generate ticket ID based on target board
    let next_num = target_board.tickets.len() + 1;
    ticket.id = format!("KANBAN-{:03}", next_num);
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

// ── Activity & Comments (Phase 3 - Block C) ──

#[tauri::command]
pub async fn get_activity(
    limit: u32,
    state: State<'_>,
) -> Result<Vec<activity::ActivityEntry>, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    Ok(activity::get_activity(&project_path, limit as usize))
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
    let project_path = s.project_path().ok_or("No project selected")?;
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
    let recent_activity = activity::get_activity(&project_path, 5);

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
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    Ok(config::load_templates(&project_path))
}

#[tauri::command]
pub async fn save_templates(
    templates: Vec<config::TicketTemplate>,
    state: State<'_>,
) -> Result<(), String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    config::save_templates(&project_path, &templates)
}

#[tauri::command]
pub async fn create_ticket_from_template(
    template_name: String,
    title: String,
    state: State<'_>,
) -> Result<Ticket, String> {
    let mut s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    let templates = config::load_templates(&project_path);
    let tpl = templates
        .iter()
        .find(|t| t.name == template_name)
        .ok_or_else(|| format!("Template '{}' not found", template_name))?;

    let next_num = s.board.tickets.len() + 1;
    let id = format!("KANBAN-{:03}", next_num);
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
    };

    s.board.tickets.push(ticket.clone());
    s.save_and_backup()?;
    s.log(format!("Created ticket {} from template '{}'", id, template_name));
    if let Some(pp) = s.project_path() {
        activity::log_activity(
            &pp,
            "ticket_created",
            Some(&ticket.id),
            Some(&ticket.title),
            Some(&format!("template: {}", template_name)),
        );
    }
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
            let next_num = s.board.tickets.len() + new_tickets.len() + 1;
            let id = format!("KANBAN-{:03}", next_num);
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
            });
        }
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
                let next_num = s.board.tickets.len() + 1;
                t.id = format!("KANBAN-{:03}", next_num);
                t.column = Column::Backlog;
                t.branch = None;
                s.board.tickets.push(t);
            }
        }
    }

    s.save_and_backup()?;
    s.log("Tickets imported".to_string());
    if let Some(pp) = s.project_path() {
        activity::log_activity(&pp, "tickets_imported", None, None, Some(&mode));
    }
    Ok(s.board.clone())
}
