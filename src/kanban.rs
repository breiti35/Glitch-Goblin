use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::error::AppError;

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
    let content = std::fs::read_to_string(path).map_err(|e| AppError::FileRead {
        path: path.display().to_string(),
        cause: e.to_string(),
    })?;
    let mut board: KanbanBoard = serde_json::from_str(&content)
        .map_err(|e| AppError::BoardLoad(format!("{}: {e}", path.display())))?;
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
                t.id.strip_prefix("GG-")
                    .or_else(|| t.id.strip_prefix("KANBAN-"))
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
        .map_err(|e| AppError::Serialize(e.to_string()))?;
    // Write to a temp file first, then rename for a near-atomic replacement.
    // This prevents a partial write from corrupting kanban.json if the app
    // is killed mid-write.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| AppError::FileWrite {
        path: tmp.display().to_string(),
        cause: e.to_string(),
    })?;
    std::fs::rename(&tmp, path).map_err(|e| AppError::FileWrite {
        path: path.display().to_string(),
        cause: e.to_string(),
    })?;
    Ok(())
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
        let oldest_path = backups.remove(0).path();
        std::fs::remove_file(&oldest_path)
            .map_err(|e| format!("Failed to prune old backup {oldest_path:?}: {e}"))?;
    }

    Ok(())
}

#[allow(dead_code)]
pub fn tickets_in_column<'a>(board: &'a KanbanBoard, col: &Column) -> Vec<&'a Ticket> {
    board.tickets.iter().filter(|t| &t.column == col).collect()
}

pub fn build_prompt_for(ticket: &Ticket) -> String {
    let cmd = match ticket.ticket_type {
        TicketType::Feature => "/new-feature",
        TicketType::Bugfix => "/bugfix",
        TicketType::Security => "/security-audit",
        TicketType::Docs => "/kanban",
    };
    if ticket.description.is_empty() {
        format!("{cmd} {}", ticket.title)
    } else {
        format!("{cmd} {}\n\n{}", ticket.title, ticket.description)
    }
}

#[allow(dead_code)]
pub fn requires_confirmation(ticket_type: &TicketType) -> bool {
    matches!(ticket_type, TicketType::Feature | TicketType::Bugfix)
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
              "id": "GG-001",
              "title": "Add Auth",
              "slug": "add-auth",
              "ticket_type": "bugfix",
              "column": "review",
              "description": "Fix login",
              "branch": "gg/GG-001-add-auth"
            }
          ]
        }"#;

        let board: KanbanBoard = serde_json::from_str(json).unwrap();
        assert_eq!(board.project_name, "test");
        let t = &board.tickets[0];
        assert_eq!(t.slug, "add-auth");
        assert_eq!(t.ticket_type, TicketType::Bugfix);
        assert_eq!(t.description, "Fix login");
        assert_eq!(t.branch.as_deref(), Some("gg/GG-001-add-auth"));
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

    #[test]
    fn slugify_special_chars() {
        assert_eq!(slugify("Fix Bug #123"), "fix-bug-123");
        assert_eq!(slugify("Hello World!!!"), "hello-world");
        assert_eq!(slugify("  spaces  everywhere  "), "spaces-everywhere");
    }

    #[test]
    fn slugify_empty_string() {
        assert_eq!(slugify(""), "");
    }

    #[test]
    fn slugify_unicode() {
        // Rust's char::is_alphanumeric() treats Unicode letters (umlauts etc.) as alphanumeric
        assert_eq!(slugify("Ümläute & Sönderzeichen"), "\u{00fc}ml\u{00e4}ute-s\u{00f6}nderzeichen");
    }

    #[test]
    fn next_ticket_id_from_gg_prefix() {
        let json = r#"{
            "project_name": "test",
            "tickets": [
                {"id": "GG-005", "title": "Test", "slug": "test", "ticket_type": "feature", "column": "backlog", "description": ""},
                {"id": "GG-003", "title": "Other", "slug": "other", "ticket_type": "bugfix", "column": "done", "description": ""}
            ]
        }"#;
        let board: KanbanBoard = serde_json::from_str(json).unwrap();
        // next_ticket_id should be computed from max existing ID
        // (load_board does this, but we test the parsing logic)
        let max = board.tickets.iter()
            .filter_map(|t| t.id.strip_prefix("GG-").or_else(|| t.id.strip_prefix("KANBAN-")).and_then(|n| n.parse::<u32>().ok()))
            .max()
            .unwrap_or(0);
        assert_eq!(max, 5);
    }

    #[test]
    fn next_ticket_id_backward_compat_kanban_prefix() {
        let json = r#"{
            "project_name": "test",
            "tickets": [
                {"id": "KANBAN-010", "title": "Old", "slug": "old", "ticket_type": "feature", "column": "done", "description": ""},
                {"id": "GG-012", "title": "New", "slug": "new", "ticket_type": "feature", "column": "backlog", "description": ""}
            ]
        }"#;
        let board: KanbanBoard = serde_json::from_str(json).unwrap();
        let max = board.tickets.iter()
            .filter_map(|t| t.id.strip_prefix("GG-").or_else(|| t.id.strip_prefix("KANBAN-")).and_then(|n| n.parse::<u32>().ok()))
            .max()
            .unwrap_or(0);
        assert_eq!(max, 12);
    }

    #[test]
    fn column_serde_roundtrip() {
        assert_eq!(serde_json::to_string(&Column::Backlog).unwrap(), "\"backlog\"");
        assert_eq!(serde_json::to_string(&Column::Progress).unwrap(), "\"progress\"");
        assert_eq!(serde_json::to_string(&Column::Review).unwrap(), "\"review\"");
        assert_eq!(serde_json::to_string(&Column::Done).unwrap(), "\"done\"");

        let col: Column = serde_json::from_str("\"review\"").unwrap();
        assert_eq!(col, Column::Review);
    }

    #[test]
    fn ticket_type_serde() {
        let tt: TicketType = serde_json::from_str("\"bugfix\"").unwrap();
        assert_eq!(tt, TicketType::Bugfix);
        assert_eq!(serde_json::to_string(&TicketType::Security).unwrap(), "\"security\"");
    }

    #[test]
    fn board_with_missing_fields_uses_defaults() {
        let json = r#"{"project_name": "test", "tickets": [
            {"id": "GG-001", "title": "Minimal", "ticket_type": "feature", "column": "backlog"}
        ]}"#;
        let board: KanbanBoard = serde_json::from_str(json).unwrap();
        let t = &board.tickets[0];
        assert_eq!(t.description, "");
        assert_eq!(t.prio, None);
        assert_eq!(t.branch, None);
        assert_eq!(t.cost_usd, None);
        assert_eq!(t.slug, ""); // slug is empty until load_board fills it
    }

    #[test]
    fn column_index_roundtrip() {
        for col in &Column::ALL {
            assert_eq!(Column::from_index(col.index()), *col);
        }
    }

    #[test]
    fn column_from_index_out_of_range_defaults_to_backlog() {
        assert_eq!(Column::from_index(99), Column::Backlog);
    }

    #[test]
    fn column_labels() {
        assert_eq!(Column::Backlog.label(), "Backlog");
        assert_eq!(Column::Progress.label(), "Progress");
        assert_eq!(Column::Review.label(), "Review");
        assert_eq!(Column::Done.label(), "Done");
    }

    #[test]
    fn tickets_in_column_filters_correctly() {
        let board = KanbanBoard {
            project_name: "test".into(),
            tickets: vec![
                Ticket {
                    id: "GG-001".into(),
                    title: "A".into(),
                    slug: "a".into(),
                    ticket_type: TicketType::Feature,
                    column: Column::Backlog,
                    description: String::new(),
                    prio: None,
                    created_at: None,
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
                },
                Ticket {
                    id: "GG-002".into(),
                    title: "B".into(),
                    slug: "b".into(),
                    ticket_type: TicketType::Bugfix,
                    column: Column::Done,
                    description: String::new(),
                    prio: None,
                    created_at: None,
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
                },
                Ticket {
                    id: "GG-003".into(),
                    title: "C".into(),
                    slug: "c".into(),
                    ticket_type: TicketType::Feature,
                    column: Column::Backlog,
                    description: String::new(),
                    prio: None,
                    created_at: None,
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
                },
            ],
            next_ticket_id: 4,
        };
        let backlog = tickets_in_column(&board, &Column::Backlog);
        assert_eq!(backlog.len(), 2);
        assert_eq!(backlog[0].id, "GG-001");
        assert_eq!(backlog[1].id, "GG-003");

        let done = tickets_in_column(&board, &Column::Done);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].id, "GG-002");

        let review = tickets_in_column(&board, &Column::Review);
        assert!(review.is_empty());
    }

    #[test]
    fn build_prompt_feature_no_desc() {
        let ticket = Ticket {
            id: "GG-001".into(),
            title: "Add dark mode".into(),
            slug: "add-dark-mode".into(),
            ticket_type: TicketType::Feature,
            column: Column::Backlog,
            description: String::new(),
            prio: None,
            created_at: None,
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
        assert_eq!(build_prompt_for(&ticket), "/new-feature Add dark mode");
    }

    #[test]
    fn build_prompt_bugfix_with_desc() {
        let ticket = Ticket {
            id: "GG-002".into(),
            title: "Fix login".into(),
            slug: "fix-login".into(),
            ticket_type: TicketType::Bugfix,
            column: Column::Backlog,
            description: "Users cannot log in".into(),
            prio: None,
            created_at: None,
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
        assert_eq!(build_prompt_for(&ticket), "/bugfix Fix login\n\nUsers cannot log in");
    }

    #[test]
    fn build_prompt_security() {
        let ticket = Ticket {
            id: "GG-003".into(),
            title: "Audit API".into(),
            slug: "audit-api".into(),
            ticket_type: TicketType::Security,
            column: Column::Backlog,
            description: String::new(),
            prio: None,
            created_at: None,
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
        assert_eq!(build_prompt_for(&ticket), "/security-audit Audit API");
    }

    #[test]
    fn build_prompt_docs() {
        let ticket = Ticket {
            id: "GG-004".into(),
            title: "Update README".into(),
            slug: "update-readme".into(),
            ticket_type: TicketType::Docs,
            column: Column::Backlog,
            description: String::new(),
            prio: None,
            created_at: None,
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
        assert_eq!(build_prompt_for(&ticket), "/kanban Update README");
    }

    #[test]
    fn requires_confirmation_feature_and_bugfix() {
        assert!(requires_confirmation(&TicketType::Feature));
        assert!(requires_confirmation(&TicketType::Bugfix));
        assert!(!requires_confirmation(&TicketType::Security));
        assert!(!requires_confirmation(&TicketType::Docs));
    }

    #[test]
    fn ticket_comment_serde() {
        let comment = TicketComment {
            timestamp: "2026-03-20T12:00:00Z".into(),
            text: "Fixed in latest commit".into(),
        };
        let json = serde_json::to_string(&comment).unwrap();
        let parsed: TicketComment = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.timestamp, "2026-03-20T12:00:00Z");
        assert_eq!(parsed.text, "Fixed in latest commit");
    }

    #[test]
    fn kanban_board_serde_roundtrip() {
        let board = KanbanBoard {
            project_name: "test-project".into(),
            tickets: vec![
                Ticket {
                    id: "GG-001".into(),
                    title: "Test ticket".into(),
                    slug: "test-ticket".into(),
                    ticket_type: TicketType::Feature,
                    column: Column::Progress,
                    description: "A test".into(),
                    prio: Some("high".into()),
                    created_at: Some("2026-03-20T12:00:00Z".into()),
                    started_at: None,
                    review_at: None,
                    done_at: None,
                    has_changes: Some(true),
                    branch: Some("gg/GG-001-test-ticket".into()),
                    tokens_used: Some(1500),
                    cost_usd: Some(0.05),
                    model_used: Some("claude-sonnet-4-6".into()),
                    comments: None,
                    portal_bug_id: None,
                    portal_bug_url: None,
                },
            ],
            next_ticket_id: 2,
        };
        let json = serde_json::to_string_pretty(&board).unwrap();
        let parsed: KanbanBoard = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.project_name, "test-project");
        assert_eq!(parsed.tickets.len(), 1);
        assert_eq!(parsed.next_ticket_id, 2);
        let t = &parsed.tickets[0];
        assert_eq!(t.has_changes, Some(true));
        assert_eq!(t.tokens_used, Some(1500));
        assert_eq!(t.cost_usd, Some(0.05));
    }
}
