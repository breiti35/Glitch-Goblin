use chrono::Utc;
use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Column {
    Backlog,
    Progress,
    Review,
    Done,
}

#[allow(dead_code)]
impl Column {
    pub const ALL: [Column; 4] = [
        Column::Backlog,
        Column::Progress,
        Column::Review,
        Column::Done,
    ];

    pub fn label(&self) -> &'static str {
        match self {
            Column::Backlog => "Backlog",
            Column::Progress => "Progress",
            Column::Review => "Review",
            Column::Done => "Done",
        }
    }

    pub fn index(&self) -> usize {
        match self {
            Column::Backlog => 0,
            Column::Progress => 1,
            Column::Review => 2,
            Column::Done => 3,
        }
    }

    pub fn from_index(i: usize) -> Self {
        match i {
            0 => Column::Backlog,
            1 => Column::Progress,
            2 => Column::Review,
            3 => Column::Done,
            _ => Column::Backlog,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TicketType {
    Feature,
    Bugfix,
    Security,
    Docs,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ticket {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub slug: String,
    #[serde(alias = "type")]
    pub ticket_type: TicketType,
    pub column: Column,
    #[serde(default, alias = "desc")]
    pub description: String,
    #[serde(default)]
    pub prio: Option<String>,
    #[serde(default, alias = "createdAt")]
    pub created_at: Option<String>,
    #[serde(default, alias = "startedAt")]
    pub started_at: Option<String>,
    #[serde(default, alias = "reviewAt")]
    pub review_at: Option<String>,
    #[serde(default, alias = "doneAt")]
    pub done_at: Option<String>,
    #[serde(default, alias = "hasChanges")]
    pub has_changes: Option<bool>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub tokens_used: Option<u64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub model_used: Option<String>,
    #[serde(default)]
    pub comments: Option<Vec<TicketComment>>,
    #[serde(default)]
    pub portal_bug_id: Option<u64>,
    #[serde(default)]
    pub portal_bug_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketComment {
    pub timestamp: String,
    pub text: String,
}

pub fn slugify(s: &str) -> String {
    let full: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if full.len() <= 30 {
        return full;
    }
    // Truncate at last hyphen before the 30-char limit
    let truncated = &full[..30];
    match truncated.rfind('-') {
        Some(pos) => truncated[..pos].to_string(),
        None => truncated.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KanbanBoard {
    #[serde(alias = "project")]
    pub project_name: String,
    pub tickets: Vec<Ticket>,
    #[serde(default)]
    pub next_ticket_id: u32,
}

pub fn load_board(path: &Path) -> Result<KanbanBoard, String> {
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read kanban.json: {e}"))?;
    let mut board: KanbanBoard =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse kanban.json: {e}"))?;
    for ticket in &mut board.tickets {
        if ticket.slug.is_empty() {
            ticket.slug = slugify(&ticket.title);
        }
    }
    // Compute next_ticket_id from existing tickets if not set (legacy files)
    if board.next_ticket_id == 0 {
        let max_id = board
            .tickets
            .iter()
            .filter_map(|t| {
                t.id.strip_prefix("KANBAN-")
                    .and_then(|n| n.parse::<u32>().ok())
            })
            .max()
            .unwrap_or(0);
        board.next_ticket_id = max_id + 1;
    }
    Ok(board)
}

pub fn save_board(path: &Path, board: &KanbanBoard) -> Result<(), String> {
    let json = serde_json::to_string_pretty(board)
        .map_err(|e| format!("Failed to serialize board: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write kanban.json: {e}"))
}

pub fn backup_board(kanban_path: &Path, max_backups: u32) -> Result<(), String> {
    let backup_dir = kanban_path
        .parent()
        .ok_or("kanban.json has no parent")?
        .join("kanban-backups");
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Failed to create backup dir: {e}"))?;

    let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
    let backup_name = format!("kanban-{}.json", timestamp);
    let backup_path = backup_dir.join(&backup_name);

    std::fs::copy(kanban_path, &backup_path)
        .map_err(|e| format!("Failed to create backup: {e}"))?;

    // Prune old backups
    let mut backups: Vec<_> = std::fs::read_dir(&backup_dir)
        .map_err(|e| format!("Failed to read backup dir: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .file_name()
                .map(|f| f.to_string_lossy().starts_with("kanban-") && f.to_string_lossy().ends_with(".json"))
                .unwrap_or(false)
        })
        .collect();

    backups.sort_by_key(|e| e.file_name());

    while backups.len() > max_backups as usize {
        if let Some(oldest) = backups.first() {
            let _ = std::fs::remove_file(oldest.path());
        }
        backups.remove(0);
    }

    Ok(())
}

#[allow(dead_code)]
pub fn tickets_in_column<'a>(board: &'a KanbanBoard, col: &Column) -> Vec<&'a Ticket> {
    board.tickets.iter().filter(|t| &t.column == col).collect()
}

pub fn build_prompt_for(ticket: &Ticket) -> String {
    let base = match ticket.ticket_type {
        TicketType::Feature => format!("/new-feature {}", ticket.title),
        TicketType::Bugfix => format!("/bugfix {}", ticket.title),
        TicketType::Security => format!("/security-audit {}", ticket.title),
        TicketType::Docs => format!(
            "Nutze den doc-updater Agent und aktualisiere die Doku: {}",
            ticket.title
        ),
    };
    if ticket.description.is_empty() {
        base
    } else {
        format!("{base}\n\nBeschreibung: {}", ticket.description)
    }
}

#[allow(dead_code)]
pub fn requires_confirmation(ticket_type: &TicketType) -> bool {
    matches!(ticket_type, TicketType::Feature | TicketType::Bugfix)
}

pub fn watch_kanban(
    path: &Path,
    app_handle: tauri::AppHandle,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let watched_path = path.to_path_buf();
    let (notify_tx, notify_rx) = std::sync::mpsc::channel();

    let mut debouncer = new_debouncer(Duration::from_millis(500), notify_tx)
        .map_err(|e| format!("Failed to create debouncer: {e}"))?;

    let parent = watched_path
        .parent()
        .ok_or_else(|| "kanban.json has no parent directory".to_string())?;

    debouncer
        .watcher()
        .watch(parent, notify::RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch directory: {e}"))?;

    let file_name = watched_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();

    std::thread::spawn(move || {
        let _debouncer = debouncer; // keep alive
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            match notify_rx.recv_timeout(Duration::from_secs(1)) {
                Ok(Ok(events)) => {
                    let relevant = events.iter().any(|e| {
                        e.kind == DebouncedEventKind::Any
                            && e.path
                                .file_name()
                                .map(|f| f.to_string_lossy() == file_name)
                                .unwrap_or(false)
                    });
                    if relevant {
                        if let Ok(board) = load_board(&watched_path) {
                            let _ = app_handle.emit("board-changed", &board);
                        }
                    }
                }
                Ok(Err(_)) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_existing_format() {
        let json = r#"{
          "project": "portal",
          "tickets": [
            {
              "id": "t_001",
              "title": "UI-Fix: Speditions-Dashboard",
              "desc": "Navigation hat zu viele Icons",
              "type": "feature",
              "prio": "high",
              "column": "backlog",
              "createdAt": "2026-03-15T00:00:00.000Z"
            }
          ]
        }"#;

        let board: KanbanBoard = serde_json::from_str(json).unwrap();
        assert_eq!(board.project_name, "portal");
        assert_eq!(board.tickets.len(), 1);

        let t = &board.tickets[0];
        assert_eq!(t.id, "t_001");
        assert_eq!(t.description, "Navigation hat zu viele Icons");
        assert_eq!(t.ticket_type, TicketType::Feature);
        assert_eq!(t.prio.as_deref(), Some("high"));
        assert_eq!(t.created_at.as_deref(), Some("2026-03-15T00:00:00.000Z"));
        assert_eq!(t.column, Column::Backlog);
        assert!(t.slug.is_empty());
    }

    #[test]
    fn parse_canonical_format() {
        let json = r#"{
          "project_name": "test",
          "tickets": [
            {
              "id": "KANBAN-001",
              "title": "Add Auth",
              "slug": "add-auth",
              "ticket_type": "bugfix",
              "column": "review",
              "description": "Fix login",
              "branch": "kanban/KANBAN-001-add-auth"
            }
          ]
        }"#;

        let board: KanbanBoard = serde_json::from_str(json).unwrap();
        assert_eq!(board.project_name, "test");
        let t = &board.tickets[0];
        assert_eq!(t.slug, "add-auth");
        assert_eq!(t.ticket_type, TicketType::Bugfix);
        assert_eq!(t.description, "Fix login");
        assert_eq!(t.branch.as_deref(), Some("kanban/KANBAN-001-add-auth"));
    }

    #[test]
    fn slugify_from_title() {
        assert_eq!(
            slugify("UI-Fix: Speditions-Dashboard"),
            "ui-fix-speditions-dashboard"
        );
        assert_eq!(slugify("Add OAuth2 Auth"), "add-oauth2-auth");
    }

    #[test]
    fn slugify_truncates_at_30_chars() {
        // Long slug: "installationsverzeichnis" is one segment, so last hyphen before 30 is after "plugin"
        assert_eq!(
            slugify("ETS2 Plugin Installationsverzeichnis wird nicht korrekt erkannt"),
            "ets2-plugin"
        );
        // Multiple short segments: truncates at last hyphen within 30 chars
        assert_eq!(
            slugify("add new user login page with dark mode support enabled"),
            "add-new-user-login-page-with"
        );
        // Exactly 30 chars kept as-is
        assert_eq!(slugify("aaaaaa-bbbbbbb-ccccccc-dddddd"), "aaaaaa-bbbbbbb-ccccccc-dddddd");
        // Short slugs unchanged
        assert_eq!(slugify("short title"), "short-title");
    }
}
