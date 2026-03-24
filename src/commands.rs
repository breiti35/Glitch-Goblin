use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use tracing::{error, info};

use crate::activity;
use crate::bugsync;
use crate::config::{self, ProjectEntry};
use crate::db;
use crate::deploy;
use crate::error::AppError;
use crate::git;
use crate::kanban::{self, Column, KanbanBoard, Ticket, TicketType};
use crate::state::{AppState, GitHubSettings, Settings};
use crate::terminal;
use crate::undo::UndoAction;

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

/// Returns the ticket prefix for the current project (e.g. "GG", "VTC").
fn ticket_prefix(state: &AppState) -> String {
    state
        .project
        .as_ref()
        .map(|p| p.ticket_prefix.clone())
        .unwrap_or_else(|| "GG".to_string())
}

/// Formats a ticket ID from the project prefix and number (e.g. "GG-001").
fn format_ticket_id(prefix: &str, num: u32) -> String {
    format!("{}-{:03}", prefix, num)
}

/// Derives the commit prefix from a ticket prefix (e.g. "GG" → "gg:").
fn commit_prefix_from(ticket_prefix: &str) -> String {
    format!("{}:", ticket_prefix.to_lowercase())
}

// ── Project Management ──

/// Gibt das aktuelle Kanban-Board zurück.
#[tauri::command]
pub async fn get_board(state: State<'_>) -> Result<KanbanBoard, String> {
    let s = state.lock().await;
    Ok(s.board.clone())
}

/// Gibt alle konfigurierten Projekte zurück.
#[tauri::command]
pub async fn get_projects(state: State<'_>) -> Result<Vec<ProjectEntry>, String> {
    let s = state.lock().await;
    let mut projects = s.projects.clone();
    // Never send plaintext GitHub tokens to the frontend
    for p in &mut projects {
        p.github.token = String::new();
    }
    Ok(projects)
}

/// Gibt das aktuell ausgewählte Projekt zurück.
#[tauri::command]
pub async fn get_current_project(state: State<'_>) -> Result<Option<ProjectEntry>, String> {
    let s = state.lock().await;
    let mut project = s.project.clone();
    // Never send plaintext GitHub token to the frontend
    if let Some(ref mut p) = project {
        p.github.token = String::new();
    }
    Ok(project)
}

/// Wechselt zu einem anderen Projekt und lädt dessen Board.
#[tauri::command]
pub async fn switch_project(
    name: String,
    state: State<'_>,
    _app: AppHandle,
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

    // Open SQLite DB — SQLite ist die einzige Datenquelle
    let new_conn = crate::db::open(&data_dir).map_err(|e| {
        error!(error = %e, "DB open failed");
        format!("Datenbank konnte nicht geöffnet werden: {e}")
    })?;
    let _ = crate::db::migrate_from_json(&new_conn, &data_dir);

    let board = crate::db::load_board(&new_conn).map_err(|e| {
        error!(error = %e, "DB load_board failed");
        format!("Board konnte nicht geladen werden: {e}")
    })?;

    // Stop old watcher
    s.watcher_stop.store(true, Ordering::Relaxed);
    s.watcher_stop = Arc::new(AtomicBool::new(false));

    s.db = Some(new_conn);
    s.board = board.clone();
    s.kanban_path = data_dir.join("kanban.json");
    s.data_dir = data_dir;
    s.project = Some(project);
    s.undo_manager.clear();
    s.log("Project switched".to_string());

    Ok(board)
}

/// Fügt ein neues Projekt zur Konfiguration hinzu.
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

/// Setzt das Ticket-Prefix für ein Projekt (z.B. "GG", "VTC").
#[tauri::command]
pub async fn set_ticket_prefix(
    project_name: String,
    prefix: String,
    state: State<'_>,
) -> Result<(), String> {
    let prefix = prefix.trim().to_uppercase();
    if prefix.is_empty() || !prefix.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Ticket-Prefix darf nur Buchstaben und Zahlen enthalten".to_string());
    }
    let mut cfg = config::load_projects()?;
    let project = cfg
        .projects
        .iter_mut()
        .find(|p| p.name == project_name)
        .ok_or_else(|| AppError::ProjectNotFound(project_name.clone()))?;
    project.ticket_prefix = prefix;
    config::save_projects(&cfg)?;
    let mut s = state.lock().await;
    s.projects = cfg.projects.clone();
    // Update current project if it matches
    if s.project.as_ref().is_some_and(|p| p.name == project_name) {
        s.project = cfg.projects.into_iter().find(|p| p.name == project_name);
    }
    Ok(())
}

/// Entfernt ein Projekt aus der Konfiguration.
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

/// Erstellt ein neues Ticket im Backlog.
#[tauri::command]
pub async fn create_ticket(
    title: String,
    ticket_type: TicketType,
    description: String,
    prio: Option<String>,
    state: State<'_>,
) -> Result<Ticket, String> {
    let mut s = state.lock().await;
    let prefix = ticket_prefix(&s);
    let next_num = s.board.next_ticket_id;
    s.board.next_ticket_id += 1;
    let id = format_ticket_id(&prefix, next_num);
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
        archived_at: None,
    };
    s.board.tickets.push(ticket.clone());
    s.save_and_backup()?;
    s.undo_manager.push(UndoAction::CreateTicket {
        ticket_id: id.clone(),
    });
    s.log(format!("Created ticket {id}"));
    s.log_activity("ticket_created", Some(&ticket.id), Some(&ticket.title), None);
    Ok(ticket)
}

/// Aktualisiert alle Felder eines bestehenden Tickets.
#[tauri::command]
pub async fn update_ticket(ticket: Ticket, state: State<'_>) -> Result<(), String> {
    let mut s = state.lock().await;
    let idx = s
        .board
        .tickets
        .iter()
        .position(|t| t.id == ticket.id)
        .ok_or_else(|| AppError::TicketNotFound(ticket.id.clone()))?;
    let old_ticket = s.board.tickets[idx].clone();
    s.board.tickets[idx] = ticket;
    s.save_and_backup()?;
    s.undo_manager.push(UndoAction::UpdateTicket { old_ticket });
    Ok(())
}

/// Verschiebt ein Ticket in eine andere Spalte (mit Timestamp-Aktualisierung).
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

    let old_ticket = s.board.tickets[idx].clone();
    let current = s.board.tickets[idx].column.clone();

    // Same column: no-op
    if current == target_column {
        return Ok(());
    }

    // Validate: all moves between board columns allowed; Archived only from Done
    let allowed = match (&current, &target_column) {
        (Column::Archived, _) => false,
        (_, Column::Archived) => current == Column::Done,
        _ => true,
    };

    if !allowed {
        return Err(format!(
            "Cannot move from {} to {}",
            current.label(),
            target_column.label()
        ));
    }

    // Set timestamps based on target column
    match &target_column {
        Column::Progress => {
            s.board.tickets[idx].started_at = Some(kanban::now_iso());
        }
        Column::Review => {
            s.board.tickets[idx].review_at = Some(kanban::now_iso());
        }
        Column::Done => {
            s.board.tickets[idx].done_at = Some(kanban::now_iso());
        }
        Column::Archived => {
            s.board.tickets[idx].archived_at = Some(kanban::now_iso());
        }
        Column::Backlog => {}
    }

    s.board.tickets[idx].column = target_column.clone();
    s.save_and_backup()?;
    s.undo_manager.push(UndoAction::MoveTicket { old_ticket });
    let detail = format!("{} -> {}", current.label(), target_column.label());
    s.log_activity("ticket_moved", Some(&ticket_id), None, Some(&detail));
    Ok(())
}

/// Löscht ein Ticket dauerhaft aus dem Board.
#[tauri::command]
pub async fn delete_ticket(ticket_id: String, state: State<'_>) -> Result<(), String> {
    let mut s = state.lock().await;
    let idx = s
        .board
        .tickets
        .iter()
        .position(|t| t.id == ticket_id)
        .ok_or_else(|| AppError::TicketNotFound(ticket_id.clone()))?;
    let removed_ticket = s.board.tickets.remove(idx);
    let title = removed_ticket.title.clone();
    s.save_and_backup()?;
    s.undo_manager.push(UndoAction::DeleteTicket {
        ticket: removed_ticket,
        index: idx,
    });
    s.log_activity("ticket_deleted", Some(&ticket_id), Some(&title), None);
    Ok(())
}

// ── Ticket Archive ──

/// Archiviert ein Ticket (verschiebt von Done nach Archived).
#[tauri::command]
pub async fn archive_ticket(ticket_id: String, state: State<'_>) -> Result<(), String> {
    let mut s = state.lock().await;
    let idx = s
        .board
        .tickets
        .iter()
        .position(|t| t.id == ticket_id)
        .ok_or_else(|| AppError::TicketNotFound(ticket_id.clone()))?;

    if s.board.tickets[idx].column != Column::Done {
        return Err("Nur erledigte Tickets können archiviert werden".to_string());
    }

    let old_ticket = s.board.tickets[idx].clone();
    s.board.tickets[idx].column = Column::Archived;
    s.board.tickets[idx].archived_at = Some(kanban::now_iso());
    let title = s.board.tickets[idx].title.clone();
    s.save_and_backup()?;
    s.undo_manager.push(UndoAction::ArchiveTicket { old_ticket });
    s.log_activity("ticket_archived", Some(&ticket_id), Some(&title), None);
    Ok(())
}

/// Stellt ein archiviertes Ticket wieder her (zurück nach Done).
#[tauri::command]
pub async fn unarchive_ticket(ticket_id: String, state: State<'_>) -> Result<(), String> {
    let mut s = state.lock().await;

    // Ticket might be in board.tickets (already loaded) or only in DB
    // Since archived tickets are NOT in board.tickets, we operate on DB directly
    if let Some(conn) = &s.db {
        // Check ticket exists and is archived
        let col: String = conn
            .query_row(
                "SELECT col FROM tickets WHERE id = ?1",
                rusqlite::params![ticket_id],
                |r| r.get(0),
            )
            .map_err(|_| AppError::TicketNotFound(ticket_id.clone()))?;

        if col != "archived" {
            return Err("Ticket ist nicht archiviert".to_string());
        }

        conn.execute(
            "UPDATE tickets SET col = 'done', archived_at = NULL WHERE id = ?1",
            rusqlite::params![ticket_id],
        )
        .map_err(|e| format!("Unarchive fehlgeschlagen: {e}"))?;

        // Reload board to pick up the restored ticket
        s.board = db::load_board(conn)?;
        s.log_activity("ticket_unarchived", Some(&ticket_id), None, None);
        Ok(())
    } else {
        Err("Keine Datenbankverbindung".to_string())
    }
}

/// Gibt alle archivierten Tickets zurück.
#[tauri::command]
pub async fn get_archived_tickets(state: State<'_>) -> Result<Vec<Ticket>, String> {
    let s = state.lock().await;
    if let Some(conn) = &s.db {
        db::load_archived_tickets(conn)
    } else {
        Ok(Vec::new())
    }
}

// ── Undo / Redo ──

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_description: Option<String>,
    pub redo_description: Option<String>,
}

/// Gibt den aktuellen Undo/Redo-Zustand zurück.
#[tauri::command]
pub async fn get_undo_state(state: State<'_>) -> Result<UndoState, String> {
    let s = state.lock().await;
    Ok(UndoState {
        can_undo: s.undo_manager.can_undo(),
        can_redo: s.undo_manager.can_redo(),
        undo_description: s.undo_manager.undo_description(),
        redo_description: s.undo_manager.redo_description(),
    })
}

/// Macht die letzte Ticket-Aktion rückgängig.
#[tauri::command]
pub async fn undo_action(state: State<'_>) -> Result<UndoState, String> {
    let mut s = state.lock().await;
    let entry = match s.undo_manager.pop_undo() {
        Some(e) => e,
        None => return Err("Nichts zum Rückgängigmachen".to_string()),
    };
    let label = entry.label.clone();

    match entry.action {
        UndoAction::CreateTicket { ref ticket_id } => {
            // Undo create = delete the ticket
            let idx = s
                .board
                .tickets
                .iter()
                .position(|t| t.id == *ticket_id)
                .ok_or_else(|| AppError::TicketNotFound(ticket_id.clone()))?;
            let removed = s.board.tickets.remove(idx);
            s.save_and_backup()?;
            s.undo_manager.record_for_redo(
                UndoAction::DeleteTicket {
                    ticket: removed,
                    index: idx,
                },
                label,
            );
        }
        UndoAction::DeleteTicket { ticket, index } => {
            // Undo delete = re-insert the ticket
            let insert_at = index.min(s.board.tickets.len());
            let id = ticket.id.clone();
            s.board.tickets.insert(insert_at, ticket);
            s.save_and_backup()?;
            s.undo_manager.record_for_redo(
                UndoAction::CreateTicket { ticket_id: id },
                label,
            );
        }
        UndoAction::MoveTicket { old_ticket } => {
            // Undo move = restore old ticket state
            let idx = s
                .board
                .tickets
                .iter()
                .position(|t| t.id == old_ticket.id)
                .ok_or_else(|| AppError::TicketNotFound(old_ticket.id.clone()))?;
            let current_ticket = s.board.tickets[idx].clone();
            s.board.tickets[idx] = old_ticket;
            s.save_and_backup()?;
            s.undo_manager.record_for_redo(
                UndoAction::MoveTicket {
                    old_ticket: current_ticket,
                },
                label,
            );
        }
        UndoAction::UpdateTicket { old_ticket } => {
            // Undo update = restore old ticket state
            let idx = s
                .board
                .tickets
                .iter()
                .position(|t| t.id == old_ticket.id)
                .ok_or_else(|| AppError::TicketNotFound(old_ticket.id.clone()))?;
            let current_ticket = s.board.tickets[idx].clone();
            s.board.tickets[idx] = old_ticket;
            s.save_and_backup()?;
            s.undo_manager.record_for_redo(
                UndoAction::UpdateTicket {
                    old_ticket: current_ticket,
                },
                label,
            );
        }
        UndoAction::ArchiveTicket { old_ticket } => {
            // Undo archive = restore old ticket state (back to Done)
            let idx = s
                .board
                .tickets
                .iter()
                .position(|t| t.id == old_ticket.id)
                .ok_or_else(|| AppError::TicketNotFound(old_ticket.id.clone()))?;
            let current_ticket = s.board.tickets[idx].clone();
            s.board.tickets[idx] = old_ticket;
            s.save_and_backup()?;
            s.undo_manager.record_for_redo(
                UndoAction::ArchiveTicket {
                    old_ticket: current_ticket,
                },
                label,
            );
        }
    }

    s.log_activity("undo", None, None, None);
    Ok(UndoState {
        can_undo: s.undo_manager.can_undo(),
        can_redo: s.undo_manager.can_redo(),
        undo_description: s.undo_manager.undo_description(),
        redo_description: s.undo_manager.redo_description(),
    })
}

/// Stellt die letzte rückgängig gemachte Aktion wieder her.
#[tauri::command]
pub async fn redo_action(state: State<'_>) -> Result<UndoState, String> {
    let mut s = state.lock().await;
    let entry = match s.undo_manager.pop_redo() {
        Some(e) => e,
        None => return Err("Nichts zum Wiederherstellen".to_string()),
    };
    let label = entry.label.clone();

    match entry.action {
        UndoAction::CreateTicket { ref ticket_id } => {
            // Redo of a "delete undo" = delete the ticket again
            let idx = s
                .board
                .tickets
                .iter()
                .position(|t| t.id == *ticket_id)
                .ok_or_else(|| AppError::TicketNotFound(ticket_id.clone()))?;
            let removed = s.board.tickets.remove(idx);
            s.save_and_backup()?;
            s.undo_manager.record_for_undo_only(
                UndoAction::DeleteTicket {
                    ticket: removed,
                    index: idx,
                },
                label,
            );
        }
        UndoAction::DeleteTicket { ticket, index } => {
            // Redo of a "create undo" = re-insert the ticket
            let insert_at = index.min(s.board.tickets.len());
            let id = ticket.id.clone();
            s.board.tickets.insert(insert_at, ticket);
            s.save_and_backup()?;
            s.undo_manager.record_for_undo_only(
                UndoAction::CreateTicket { ticket_id: id },
                label,
            );
        }
        UndoAction::MoveTicket { old_ticket } => {
            let idx = s
                .board
                .tickets
                .iter()
                .position(|t| t.id == old_ticket.id)
                .ok_or_else(|| AppError::TicketNotFound(old_ticket.id.clone()))?;
            let current_ticket = s.board.tickets[idx].clone();
            s.board.tickets[idx] = old_ticket;
            s.save_and_backup()?;
            s.undo_manager.record_for_undo_only(
                UndoAction::MoveTicket {
                    old_ticket: current_ticket,
                },
                label,
            );
        }
        UndoAction::UpdateTicket { old_ticket } => {
            let idx = s
                .board
                .tickets
                .iter()
                .position(|t| t.id == old_ticket.id)
                .ok_or_else(|| AppError::TicketNotFound(old_ticket.id.clone()))?;
            let current_ticket = s.board.tickets[idx].clone();
            s.board.tickets[idx] = old_ticket;
            s.save_and_backup()?;
            s.undo_manager.record_for_undo_only(
                UndoAction::UpdateTicket {
                    old_ticket: current_ticket,
                },
                label,
            );
        }
        UndoAction::ArchiveTicket { old_ticket } => {
            let idx = s
                .board
                .tickets
                .iter()
                .position(|t| t.id == old_ticket.id)
                .ok_or_else(|| AppError::TicketNotFound(old_ticket.id.clone()))?;
            let current_ticket = s.board.tickets[idx].clone();
            s.board.tickets[idx] = old_ticket;
            s.save_and_backup()?;
            s.undo_manager.record_for_undo_only(
                UndoAction::ArchiveTicket {
                    old_ticket: current_ticket,
                },
                label,
            );
        }
    }

    s.log_activity("redo", None, None, None);
    Ok(UndoState {
        can_undo: s.undo_manager.can_undo(),
        can_redo: s.undo_manager.can_redo(),
        undo_description: s.undo_manager.undo_description(),
        redo_description: s.undo_manager.redo_description(),
    })
}

// ── Ticket Execution (interactive terminal mode) ──

/// Startet ein Ticket: erstellt Branch, setzt Status auf Progress.
#[tauri::command]
pub async fn start_ticket(
    ticket_id: String,
    model: Option<String>,
    state: State<'_>,
    app: AppHandle,
) -> Result<StartTicketResult, String> {
    // Check git is available
    if crate::git::check_git_available().await.is_err() {
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
    let (ticket, project_path) = {
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
        s.save_and_backup()?;
        s.log(format!(
            "Starting {} - {}",
            ticket.id, ticket.title
        ));
        s.log_activity("ticket_started", Some(&ticket.id), Some(&ticket.title), None);
        (ticket, project_path)
    }; // Lock released

    info!(ticket_id = %ticket_id, "Ticket started");

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

    // Notify frontend of board change
    {
        let s = state.lock().await;
        let _ = app.emit("board-changed", &s.board);
    }

    Ok(StartTicketResult {
        project_path: pp_str,
        prompt,
        branch,
        ticket_id,
    })
}

/// Schließt ein Ticket ab: auto-commit der Änderungen, verschiebt in Review.
#[tauri::command]
pub async fn finish_ticket(
    ticket_id: String,
    tokens_used: Option<u64>,
    cost_usd: Option<f64>,
    state: State<'_>,
    app: AppHandle,
) -> Result<(), String> {
    let (ticket, project_path, commit_prefix) = {
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
        let prefix = ticket_prefix(&s);
        let commit_prefix = commit_prefix_from(&prefix);
        (ticket, project_path, commit_prefix)
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
            if tokens_used.is_some() {
                s.board.tickets[idx].tokens_used = tokens_used;
            }
            if cost_usd.is_some() {
                s.board.tickets[idx].cost_usd = cost_usd;
            }
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

    info!(ticket_id = %ticket_id, "Ticket finished");

    {
        let s = state.lock().await;
        let _ = app.emit("board-changed", &s.board);
    }

    Ok(())
}

/// Merged den Ticket-Branch in main, löscht den Branch und verschiebt das Ticket in Done.
#[tauri::command]
pub async fn merge_ticket(
    ticket_id: String,
    state: State<'_>,
    app: AppHandle,
) -> Result<(), String> {
    let (ticket, project_path, auto_push) = {
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
        let auto_push = s.settings.auto_push_after_merge;
        (ticket, project_path, auto_push)
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

    info!(ticket_id = %ticket_id, "Ticket merged");

    {
        let s = state.lock().await;
        let _ = app.emit("board-changed", &s.board);
    }

    Ok(())
}

// ── Git Push Commands ──

/// Pusht einen benannten Branch zum Remote (origin).
#[tauri::command]
pub async fn push_branch(branch: String, state: State<'_>) -> Result<(), String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::push_branch(&project_path, &branch).await
}

/// Pusht den aktuell ausgecheckten Branch zum Remote.
#[tauri::command]
pub async fn push_current_branch(state: State<'_>) -> Result<(), String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    let branch = git::current_branch(&project_path).await?;
    git::push_branch(&project_path, &branch).await
}

/// Bricht einen laufenden Git-Merge ab.
#[tauri::command]
pub async fn abort_git_merge(state: State<'_>) -> Result<(), String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::abort_merge(&project_path).await
}

/// Gibt die Remote-URL zurück, sofern ein Remote konfiguriert ist.
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

/// Prüft, ob uncommittete Änderungen im Projektverzeichnis vorhanden sind.
#[tauri::command]
pub async fn check_uncommitted(state: State<'_>) -> Result<bool, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::check_uncommitted(&project_path).await
}

/// Gibt die internen App-Log-Zeilen zurück.
#[tauri::command]
pub async fn get_log_lines(state: State<'_>) -> Result<Vec<String>, String> {
    let s = state.lock().await;
    Ok(s.log_lines.iter().cloned().collect())
}

/// Gibt die ID des aktuell laufenden Tickets zurück, falls vorhanden.
#[tauri::command]
pub async fn get_running_ticket(state: State<'_>) -> Result<Option<String>, String> {
    let s = state.lock().await;
    Ok(s.running_ticket.clone())
}

/// Listet verfügbare Claude-Agent-Dateien im Projekt auf.
#[tauri::command]
pub async fn list_agents(state: State<'_>) -> Result<Vec<String>, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    Ok(config::list_agents(&project_path))
}

/// Listet verfügbare Claude-Command-Dateien im Projekt auf.
#[tauri::command]
pub async fn list_commands_available(state: State<'_>) -> Result<Vec<String>, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    Ok(config::list_commands(&project_path))
}

// ── Settings ──

/// Gibt die aktuellen App-Einstellungen zurück.
/// Tokens werden vor dem Senden entfernt — das Frontend nutzt `token_set`-Flags.
#[tauri::command]
pub async fn get_settings(state: State<'_>) -> Result<Settings, String> {
    let s = state.lock().await;
    let mut settings = s.settings.clone();
    // Never send plaintext tokens to the frontend
    settings.bug_sync.api_token = if settings.bug_sync.api_token.is_empty() {
        String::new()
    } else {
        "__set__".into()
    };
    // Overlay project-specific GitHub settings onto the response
    if let Some(p) = &s.project {
        settings.github = p.github.clone();
    }
    settings.github.token = if settings.github.token.is_empty() {
        String::new()
    } else {
        "__set__".into()
    };
    Ok(settings)
}

/// Speichert die App-Einstellungen dauerhaft auf der Festplatte.
#[tauri::command]
pub async fn save_settings(mut settings: Settings, state: State<'_>) -> Result<(), String> {
    // Validate settings ranges
    settings.terminal_font_size = settings.terminal_font_size.clamp(8, 24);
    settings.max_backups = settings.max_backups.clamp(1, 50);
    if settings.cost_per_input_mtok < 0.0 {
        settings.cost_per_input_mtok = 0.0;
    }
    if settings.cost_per_output_mtok < 0.0 {
        settings.cost_per_output_mtok = 0.0;
    }
    if settings.bug_sync.interval_secs < 60 {
        settings.bug_sync.interval_secs = 60;
    }
    if settings.github.poll_interval_secs < 30 {
        settings.github.poll_interval_secs = 30;
    }

    // Extract project-specific GitHub settings before saving global settings
    let mut project_github = settings.github.clone();

    // Preserve existing tokens if the frontend sends empty ones
    {
        let s = state.lock().await;
        if settings.bug_sync.api_token.is_empty() && !s.settings.bug_sync.api_token.is_empty() {
            settings.bug_sync.api_token = s.settings.bug_sync.api_token.clone();
        }
        // Preserve project-specific GitHub token
        if project_github.token.is_empty() {
            if let Some(p) = &s.project {
                if !p.github.token.is_empty() {
                    project_github.token = p.github.token.clone();
                }
            }
        }
    }

    // Save GitHub settings to the current project (not global)
    {
        let mut s = state.lock().await;
        if let Some(ref mut p) = s.project {
            let project_name = p.name.clone();
            p.github = project_github.clone();
            // Also update in the projects list
            if let Some(entry) = s.projects.iter_mut().find(|e| e.name == project_name) {
                entry.github = project_github.clone();
            }
            // Persist to projects.json
            let mut cfg = config::load_projects()?;
            if let Some(entry) = cfg.projects.iter_mut().find(|e| e.name == project_name) {
                entry.github = project_github;
            }
            config::save_projects(&cfg)?;
        }
    }

    // Save global settings without GitHub (cleared to default)
    settings.github = GitHubSettings::default();
    config::save_settings_to_disk(&settings)?;
    let mut s = state.lock().await;
    s.settings = settings;
    Ok(())
}

// ── Dialog ──

/// Öffnet einen nativen Ordner-Auswahl-Dialog und gibt den gewählten Pfad zurück.
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

/// Listet vorhandene Kanban-Board-Backups auf.
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

/// Stellt das Kanban-Board aus einer Backup-Datei wieder her.
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

/// Exportiert das Terminal-Log eines Tickets via Dateiauswahl-Dialog in eine Textdatei.
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

/// Liest den Inhalt einer Claude-Agent-Markdown-Datei anhand des Namens.
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

/// Speichert oder überschreibt eine Claude-Agent-Markdown-Datei.
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

/// Erstellt eine neue Claude-Agent-Markdown-Datei aus einer Standardvorlage.
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

/// Löscht eine Claude-Agent-Markdown-Datei.
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

/// Liest den Inhalt einer Claude-Command-Markdown-Datei anhand des Namens.
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

/// Speichert oder überschreibt eine Claude-Command-Markdown-Datei.
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

/// Erstellt eine neue Claude-Command-Markdown-Datei aus einer Standardvorlage.
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

/// Löscht eine Claude-Command-Markdown-Datei.
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

/// Verschiebt ein Ticket in ein anderes Projekt und vergibt eine neue ID.
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

    // Re-generate ticket ID based on target board and project prefix
    let target_prefix = &target.ticket_prefix;
    let next_num = target_board.next_ticket_id;
    target_board.next_ticket_id += 1;
    ticket.id = format_ticket_id(target_prefix, next_num);
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

/// Startet eine neue PTY-Terminal-Session in einem angegebenen Verzeichnis.
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

/// Schreibt Daten in eine laufende Terminal-Session.
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

/// Ändert die Fenstergröße einer Terminal-Session (Spalten × Zeilen).
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

/// Schließt und entfernt eine Terminal-Session.
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

/// Gibt alle auf dem System erkannten Shells zurück.
#[tauri::command]
pub async fn list_available_shells() -> Result<Vec<terminal::ShellInfo>, String> {
    Ok(terminal::detect_shells())
}

// ── Git View Commands (Phase 3 - Block B) ──

/// Gibt alle Git-Branches mit Metadaten zurück (aktuell, Kanban, Commits, etc.).
#[tauri::command]
pub async fn list_branches(state: State<'_>) -> Result<Vec<git::BranchInfo>, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::list_branches(&project_path).await
}

/// Gibt die Diff-Statistik eines Branches gegenüber dem Haupt-Branch zurück.
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

/// Gibt den unified Diff einer einzelnen Datei in einem Branch zurück.
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

/// Gibt die Diff-Statistik eines einzelnen Commits zurück.
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

/// Gibt den unified Diff einer einzelnen Datei in einem Commit zurück.
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

/// Löscht einen Git-Branch (optional mit Force-Flag).
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

/// Löscht alle lokalen Branches die bereits in den Default-Branch gemergt wurden.
/// Gibt die Namen der gelöschten Branches zurück.
#[tauri::command]
pub async fn cleanup_merged_branches(state: State<'_>) -> Result<Vec<String>, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::cleanup_merged_branches(&project_path).await
}

/// Gibt die Commit-Historie eines Branches zurück (begrenzt auf `limit` Einträge).
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

/// Gibt uncommittete Änderungen im Working Tree zurück (staged + unstaged + untracked).
#[tauri::command]
pub async fn get_working_diff(state: State<'_>) -> Result<git::DiffInfo, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    git::get_working_diff(&project_path).await
}

/// Gibt den unified Diff einer einzelnen Datei im Working Tree zurück.
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
    pub ahead_count: u32,
    pub behind_count: u32,
}

/// Gibt den vollständigen Git-Status des Projekts zurück (Branch, Dirty-Flag, Remote etc.).
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
                ahead_count: 0,
                behind_count: 0,
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
            ahead_count: 0,
            behind_count: 0,
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
    let (ahead_count, behind_count) = git::ahead_behind(&project_path).await;

    Ok(GitStatusInfo {
        is_git_repo: true,
        current_branch: branch,
        is_detached,
        is_dirty,
        operation_in_progress,
        has_remote,
        remote_url,
        ahead_count,
        behind_count,
    })
}

// ── Activity & Comments (Phase 3 - Block C) ──

/// Gibt die letzten Aktivitäts-Einträge zurück (begrenzt auf `limit` Einträge).
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

/// Fügt einen Kommentar zu einem Ticket hinzu.
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

/// Löscht einen Kommentar aus einem Ticket anhand des Index.
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

/// Einzelne Notiz mit Ticket-Kontext fuer den Notizen-View.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    pub text: String,
    pub timestamp: String,
    pub ticket_id: String,
    pub ticket_title: String,
    pub ticket_type: TicketType,
    pub ticket_column: Column,
}

/// Gibt alle Notizen des aktuellen Projekts zurueck (Board + Archiv), sortiert nach Datum (neueste zuerst).
#[tauri::command]
pub async fn get_all_notes(state: State<'_>) -> Result<Vec<NoteEntry>, String> {
    let s = state.lock().await;

    let mut entries = Vec::new();

    // Board-Tickets
    for ticket in &s.board.tickets {
        if let Some(comments) = &ticket.comments {
            for c in comments {
                entries.push(NoteEntry {
                    text: c.text.clone(),
                    timestamp: c.timestamp.clone(),
                    ticket_id: ticket.id.clone(),
                    ticket_title: ticket.title.clone(),
                    ticket_type: ticket.ticket_type.clone(),
                    ticket_column: ticket.column.clone(),
                });
            }
        }
    }

    // Archivierte Tickets aus DB
    if let Some(conn) = &s.db {
        if let Ok(archived) = db::load_archived_tickets(conn) {
            for ticket in &archived {
                if let Some(comments) = &ticket.comments {
                    for c in comments {
                        entries.push(NoteEntry {
                            text: c.text.clone(),
                            timestamp: c.timestamp.clone(),
                            ticket_id: ticket.id.clone(),
                            ticket_title: ticket.title.clone(),
                            ticket_type: ticket.ticket_type.clone(),
                            ticket_column: ticket.column.clone(),
                        });
                    }
                }
            }
        }
    }

    // Sortierung: neueste zuerst
    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    Ok(entries)
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

/// Gibt Dashboard-Infos zurück: README, Tech-Stack, Commits, Branches, Tickets etc.
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
                        Column::Archived => "archived",
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

/// Gibt alle Ticket-Vorlagen zurück (aus DB oder Datei, mit Seeding der Defaults).
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

/// Speichert die Liste der Ticket-Vorlagen dauerhaft (DB oder Datei).
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

/// Erstellt ein neues Ticket anhand einer benannten Vorlage.
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

    let prefix = ticket_prefix(&s);
    let next_num = s.board.next_ticket_id;
    s.board.next_ticket_id += 1;
    let id = format_ticket_id(&prefix, next_num);
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
        archived_at: None,
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

/// Exportiert alle Tickets als CSV oder JSON via Dateiauswahl-Dialog.
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
                    Column::Archived => "archived",
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

/// Importiert Tickets aus einer CSV- oder JSON-Datei (append oder replace).
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

        let prefix = ticket_prefix(&s);
        let mut new_tickets = Vec::new();
        for result in rdr.records() {
            let record = result.map_err(|e| format!("CSV parse: {e}"))?;
            if record.len() < 3 {
                continue;
            }
            let next_num = s.board.next_ticket_id.saturating_add(new_tickets.len() as u32);
            let id = format_ticket_id(&prefix, next_num);
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
                archived_at: None,
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
            let prefix = ticket_prefix(&s);
            for mut t in imported.tickets {
                let next_num = s.board.next_ticket_id;
                s.board.next_ticket_id += 1;
                t.id = format_ticket_id(&prefix, next_num);
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

/// Gibt die aktuelle Deploy-Konfiguration zurück.
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

/// Speichert die Deploy-Konfiguration dauerhaft (DB oder Datei).
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

/// Erkennt die Deploy-Umgebung des Projekts (Docker, Compose etc.).
#[tauri::command]
pub async fn detect_deploy_env(
    state: State<'_>,
) -> Result<deploy::DeployEnvironment, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    Ok(deploy::detect_deploy_environment(&project_path).await)
}

/// Prüft, ob Docker im Projektverzeichnis verfügbar und aktiv ist.
#[tauri::command]
pub async fn check_docker_status(
    state: State<'_>,
) -> Result<deploy::DockerStatus, String> {
    let s = state.lock().await;
    let project_path = s.project_path().ok_or("No project selected")?;
    drop(s);
    Ok(deploy::check_docker(&project_path).await)
}

/// Startet einen lokalen Deploy via Docker Compose in einem integrierten Terminal.
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

/// Stoppt den lokalen Docker-Compose-Deploy in einem integrierten Terminal.
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

/// Startet einen Live-Deploy via SSH in einem integrierten Terminal.
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

/// Synchronisiert offene Bugs vom Portal-Bugtracker als neue Kanban-Tickets.
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

        let prefix = ticket_prefix(&s);
        for bug in &bugs {
            if existing_bug_ids.contains(&bug.id) {
                continue;
            }

            let next_num = s.board.next_ticket_id;
            s.board.next_ticket_id += 1;
            let id = format_ticket_id(&prefix, next_num);
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
                archived_at: None,
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

/// Gibt Bug-Sync-Einstellungen zurück (API-Token nur als gesetzt/nicht gesetzt).
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

// ── GitHub Actions Build Status ──

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildStatus {
    pub status: String,
    pub conclusion: Option<String>,
    pub workflow_name: Option<String>,
    pub commit_sha: Option<String>,
    pub duration_secs: Option<i64>,
    pub run_url: Option<String>,
    pub updated_at: Option<String>,
}

/// Ruft den Status des letzten GitHub Actions Workflow-Runs ab.
/// Liest die GitHub-Settings aus dem aktuellen Projekt (nicht global).
#[tauri::command]
pub async fn get_build_status(state: State<'_>) -> Result<BuildStatus, String> {
    let s = state.lock().await;
    let gh = match &s.project {
        Some(p) => &p.github,
        None => {
            return Ok(BuildStatus {
                status: "unconfigured".into(),
                conclusion: None,
                workflow_name: None,
                commit_sha: None,
                duration_secs: None,
                run_url: None,
                updated_at: None,
            });
        }
    };
    if !gh.enabled || gh.owner.is_empty() || gh.repo.is_empty() {
        return Ok(BuildStatus {
            status: "unconfigured".into(),
            conclusion: None,
            workflow_name: None,
            commit_sha: None,
            duration_secs: None,
            run_url: None,
            updated_at: None,
        });
    }
    let owner = gh.owner.clone();
    let repo = gh.repo.clone();
    let token = gh.token.clone();
    drop(s);

    let url = format!(
        "https://api.github.com/repos/{}/{}/actions/runs?per_page=1",
        owner, repo
    );

    let client = reqwest::Client::new();
    let mut request = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "glitch-goblin")
        .timeout(std::time::Duration::from_secs(10));

    if !token.is_empty() {
        request = request.header("Authorization", format!("Bearer {token}"));
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub API returned status {}",
            response.status()
        ));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("GitHub API: failed to parse response: {e}"))?;

    let runs = body["workflow_runs"]
        .as_array()
        .ok_or("GitHub API: unexpected response format")?;

    if runs.is_empty() {
        return Ok(BuildStatus {
            status: "no_runs".into(),
            conclusion: None,
            workflow_name: None,
            commit_sha: None,
            duration_secs: None,
            run_url: None,
            updated_at: None,
        });
    }

    let run = &runs[0];
    let status = run["status"].as_str().unwrap_or("unknown").to_string();
    let conclusion = run["conclusion"].as_str().map(String::from);
    let workflow_name = run["name"].as_str().map(String::from);
    let commit_sha = run["head_sha"]
        .as_str()
        .map(|s| s.chars().take(7).collect());
    let run_url = run["html_url"].as_str().map(String::from);
    let updated_at = run["updated_at"].as_str().map(String::from);

    // Calculate duration from created_at to updated_at
    let duration_secs = run["created_at"]
        .as_str()
        .and_then(|created| {
            run["updated_at"].as_str().and_then(|updated| {
                let c = chrono::DateTime::parse_from_rfc3339(created).ok()?;
                let u = chrono::DateTime::parse_from_rfc3339(updated).ok()?;
                Some((u - c).num_seconds())
            })
        });

    Ok(BuildStatus {
        status,
        conclusion,
        workflow_name,
        commit_sha,
        duration_secs,
        run_url,
        updated_at,
    })
}

/// Gibt die App-Versionsnummer zurück (aus CARGO_PKG_VERSION).
#[tauri::command]
pub fn get_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

// ── Project Logo ──

/// Maximale Logo-Dateigröße: 2 MiB (Base64-kodiert ≈ 2.7 MiB).
const MAX_LOGO_BYTES: usize = 2 * 1024 * 1024;

/// Speichert ein Projekt-Logo (Base64-kodiertes Bild) im Data-Dir.
#[tauri::command]
pub async fn set_project_logo(
    project_name: String,
    data: String,
    state: State<'_>,
) -> Result<(), String> {
    let s = state.lock().await;
    // Verify project exists
    if !s.projects.iter().any(|p| p.name == project_name) {
        return Err(AppError::ProjectNotFound(project_name).to_string());
    }
    drop(s);

    // Validate and decode base64 data (may have data-URL prefix)
    let raw_b64 = data
        .strip_prefix("data:")
        .and_then(|s| s.split_once(','))
        .map(|(_, b)| b)
        .unwrap_or(&data);

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw_b64)
        .map_err(|e| format!("Ungültige Base64-Daten: {e}"))?;

    if bytes.len() > MAX_LOGO_BYTES {
        return Err(format!(
            "Logo zu groß ({} KB, max {} KB)",
            bytes.len() / 1024,
            MAX_LOGO_BYTES / 1024
        ));
    }

    let data_dir = config::project_data_dir(&project_name)?;
    let logo_path = data_dir.join("logo.png");
    std::fs::write(&logo_path, &bytes).map_err(|e| format!("Logo speichern fehlgeschlagen: {e}"))?;
    info!(project = %project_name, "Project logo saved");
    Ok(())
}

/// Gibt das Projekt-Logo als Base64-Data-URL zurück, oder null wenn keins gesetzt.
#[tauri::command]
pub async fn get_project_logo(
    project_name: String,
    state: State<'_>,
) -> Result<Option<String>, String> {
    let s = state.lock().await;
    if !s.projects.iter().any(|p| p.name == project_name) {
        return Err(AppError::ProjectNotFound(project_name).to_string());
    }
    drop(s);

    let data_dir = config::project_data_dir(&project_name)?;
    let logo_path = data_dir.join("logo.png");
    if !logo_path.exists() {
        return Ok(None);
    }
    let bytes =
        std::fs::read(&logo_path).map_err(|e| format!("Logo lesen fehlgeschlagen: {e}"))?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:image/png;base64,{b64}")))
}

/// Entfernt das Projekt-Logo.
#[tauri::command]
pub async fn remove_project_logo(
    project_name: String,
    state: State<'_>,
) -> Result<(), String> {
    let s = state.lock().await;
    if !s.projects.iter().any(|p| p.name == project_name) {
        return Err(AppError::ProjectNotFound(project_name).to_string());
    }
    drop(s);

    let data_dir = config::project_data_dir(&project_name)?;
    let logo_path = data_dir.join("logo.png");
    if logo_path.exists() {
        std::fs::remove_file(&logo_path)
            .map_err(|e| format!("Logo löschen fehlgeschlagen: {e}"))?;
        info!(project = %project_name, "Project logo removed");
    }
    Ok(())
}

/// Gibt den Pfad zur aktuellsten Log-Datei der App zurück.
#[tauri::command]
pub async fn get_log_file_path() -> Result<String, String> {
    let log_dir = dirs::config_dir()
        .map(|d| d.join("glitch-goblin"))
        .ok_or("Could not determine config directory")?;

    let entries = std::fs::read_dir(&log_dir)
        .map_err(|e| format!("Could not read log directory: {e}"))?;

    let mut log_files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("glitch-goblin.log")
        })
        .collect();

    log_files.sort_by_key(|e| {
        std::cmp::Reverse(e.metadata().ok().and_then(|m| m.modified().ok()))
    });

    log_files
        .first()
        .map(|e| e.path().to_string_lossy().to_string())
        .ok_or_else(|| "No log files found".to_string())
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

/// In-memory cache: (timestamp, usage, backoff_until).
/// `backoff_until` is set after a 429 to avoid retrying too quickly.
struct UsageCacheEntry {
    ts: std::time::Instant,
    usage: ClaudeUsage,
    backoff_until: Option<std::time::Instant>,
}

static USAGE_CACHE: std::sync::LazyLock<tokio::sync::Mutex<Option<UsageCacheEntry>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));

/// Versucht, Usage aus dem Statusline-Datei-Cache zu lesen (%TEMP%/claude/statusline-usage-cache.json).
/// Gibt `Some(ClaudeUsage)` zurueck wenn die Datei existiert und juenger als 300s ist.
fn read_file_cache() -> Option<ClaudeUsage> {
    let temp = std::env::temp_dir();
    let cache_path = temp.join("claude").join("statusline-usage-cache.json");
    let meta = std::fs::metadata(&cache_path).ok()?;
    let age = meta
        .modified()
        .ok()
        .and_then(|mtime| mtime.elapsed().ok())
        .unwrap_or_default();
    if age.as_secs() >= 300 {
        return None;
    }
    let content = std::fs::read_to_string(&cache_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;

    // The statusline cache uses snake_case keys
    Some(ClaudeUsage {
        five_hour: v.pointer("/five_hour/utilization")
            .or_else(|| v.get("five_hour_utilization"))
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0),
        seven_day: v.pointer("/seven_day/utilization")
            .or_else(|| v.get("seven_day_utilization"))
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0),
        five_hour_resets_at: v.pointer("/five_hour/resets_at")
            .or_else(|| v.get("five_hour_resets_at"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        seven_day_resets_at: v.pointer("/seven_day/resets_at")
            .or_else(|| v.get("seven_day_resets_at"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        available: true,
    })
}

/// Ruft Claude-Nutzungsstatistiken ab.
/// Strategie: 1) In-Memory-Cache  2) Datei-Cache  3) API (mit 429-Backoff)
#[tauri::command]
pub async fn get_claude_usage() -> Result<ClaudeUsage, String> {
    // 1) In-memory cache (60 seconds)
    {
        let cache = USAGE_CACHE.lock().await;
        if let Some(ref entry) = *cache {
            if entry.ts.elapsed().as_secs() < 60 {
                return Ok(entry.usage.clone());
            }
        }
    }

    // 2) File cache from statusline script (%TEMP%/claude/statusline-usage-cache.json)
    if let Some(usage) = read_file_cache() {
        let mut cache = USAGE_CACHE.lock().await;
        *cache = Some(UsageCacheEntry {
            ts: std::time::Instant::now(),
            usage: usage.clone(),
            backoff_until: cache.as_ref().and_then(|e| e.backoff_until),
        });
        return Ok(usage);
    }

    // 3) Check backoff — if we got a 429 recently, return stale cache or error
    {
        let cache = USAGE_CACHE.lock().await;
        if let Some(ref entry) = *cache {
            if let Some(until) = entry.backoff_until {
                if std::time::Instant::now() < until {
                    // Still in backoff period — return stale data if available
                    return Ok(entry.usage.clone());
                }
            }
        }
    }

    // 4) Call API
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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("Usage API request failed: {e}"))?;

    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        // 429 — activate backoff (5 minutes)
        let mut cache = USAGE_CACHE.lock().await;
        let backoff_until = std::time::Instant::now() + std::time::Duration::from_secs(300);
        if let Some(ref mut entry) = *cache {
            entry.backoff_until = Some(backoff_until);
            return Ok(entry.usage.clone());
        }
        return Err("Usage API rate limited (429)".to_string());
    }

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

    // Update cache, clear backoff on success
    {
        let mut cache = USAGE_CACHE.lock().await;
        *cache = Some(UsageCacheEntry {
            ts: std::time::Instant::now(),
            usage: usage.clone(),
            backoff_until: None,
        });
    }

    Ok(usage)
}
