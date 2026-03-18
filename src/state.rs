use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::config::ProjectEntry;
use crate::kanban::{self, KanbanBoard};
use crate::terminal::{self, TerminalSession};

fn default_true() -> bool {
    true
}

fn default_max_backups() -> u32 {
    10
}

fn default_terminal_font_size() -> u32 {
    14
}

fn default_model() -> String {
    "claude-sonnet-4-6".to_string()
}

// Sonnet 4.6 pricing: $3.00 / MTok input, $15.00 / MTok output.
// Update these in Settings if Anthropic changes pricing or a different model is used.
fn default_cost_input() -> f64 {
    3.0
}

fn default_cost_output() -> f64 {
    15.0
}

fn default_sync_interval() -> u64 {
    300
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BugSyncSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub api_url: String,
    #[serde(default)]
    pub api_token: String,
    #[serde(default = "default_sync_interval")]
    pub interval_secs: u64,
}

impl Default for BugSyncSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            api_url: String::new(),
            api_token: String::new(),
            interval_secs: 300,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub auto_execute_types: Vec<String>,
    pub commit_prefix: String,
    pub claude_cli_path: String,
    pub accent_color: String,
    pub theme: String,
    #[serde(default = "default_true")]
    pub notifications_enabled: bool,
    #[serde(default = "default_true")]
    pub sounds_enabled: bool,
    #[serde(default = "default_true")]
    pub backups_enabled: bool,
    #[serde(default = "default_max_backups")]
    pub max_backups: u32,
    #[serde(default)]
    pub default_shell: String,
    #[serde(default = "default_terminal_font_size")]
    pub terminal_font_size: u32,
    #[serde(default = "default_model")]
    pub claude_model: String,
    #[serde(default = "default_cost_input")]
    pub cost_per_input_mtok: f64,
    #[serde(default = "default_cost_output")]
    pub cost_per_output_mtok: f64,
    #[serde(default)]
    pub bug_sync: BugSyncSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_execute_types: vec!["docs".into(), "security".into()],
            commit_prefix: "kanban:".into(),
            claude_cli_path: "claude".into(),
            accent_color: "#F97316".into(),
            theme: "dark".into(),
            notifications_enabled: true,
            sounds_enabled: true,
            backups_enabled: true,
            max_backups: 10,
            default_shell: String::new(),
            terminal_font_size: 14,
            claude_model: "claude-sonnet-4-6".into(),
            cost_per_input_mtok: 3.0,
            cost_per_output_mtok: 15.0,
            bug_sync: BugSyncSettings::default(),
        }
    }
}

pub struct AppState {
    pub board: KanbanBoard,
    pub project: Option<ProjectEntry>,
    pub projects: Vec<ProjectEntry>,
    pub running_ticket: Option<String>,
    pub log_lines: VecDeque<String>,
    pub kanban_path: PathBuf,
    pub data_dir: PathBuf,
    pub settings: Settings,
    pub watcher_stop: Arc<AtomicBool>,
    pub terminals: HashMap<String, TerminalSession>,
    /// SQLite connection for the active project. `None` when no project is open.
    pub db: Option<rusqlite::Connection>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            board: KanbanBoard {
                project_name: String::new(),
                tickets: Vec::new(),
                next_ticket_id: 1,
            },
            project: None,
            projects: Vec::new(),
            running_ticket: None,
            log_lines: VecDeque::new(),
            kanban_path: PathBuf::new(),
            data_dir: PathBuf::new(),
            settings: Settings::default(),
            watcher_stop: Arc::new(AtomicBool::new(false)),
            terminals: HashMap::new(),
            db: None,
        }
    }

    /// Send `Close` to all running terminal sessions.
    pub fn cleanup_terminals(&mut self) {
        for (_id, session) in self.terminals.drain() {
            let _ = session.cmd_tx.send(terminal::TerminalCmd::Close);
        }
    }

    /// Append an activity entry.  Uses the SQLite DB when available, falls
    /// back to the JSON activity log otherwise.
    pub fn log_activity(
        &self,
        action: &str,
        ticket_id: Option<&str>,
        ticket_title: Option<&str>,
        details: Option<&str>,
    ) {
        if let Some(conn) = &self.db {
            crate::db::log_activity(conn, action, ticket_id, ticket_title, details);
        } else if let Some(dd) = self.data_dir() {
            crate::activity::log_activity(&dd, action, ticket_id, ticket_title, details);
        }
    }

    pub fn log(&mut self, msg: String) {
        self.log_lines.push_back(msg);
        if self.log_lines.len() > 500 {
            self.log_lines.pop_front();
        }
    }

    pub fn project_path(&self) -> Option<PathBuf> {
        self.project.as_ref().map(|p| p.path.clone())
    }

    pub fn data_dir(&self) -> Option<PathBuf> {
        if self.data_dir.as_os_str().is_empty() {
            None
        } else {
            Some(self.data_dir.clone())
        }
    }

    pub fn save_and_backup(&self) -> Result<(), String> {
        if let Some(conn) = &self.db {
            crate::db::save_board(conn, &self.board)?;
            // Backup: write a JSON snapshot into kanban-backups/ for safety
            if self.settings.backups_enabled && !self.kanban_path.as_os_str().is_empty() {
                let _ = kanban::backup_board(&self.kanban_path, self.settings.max_backups);
            }
        } else {
            kanban::save_board(&self.kanban_path, &self.board)?;
            if self.settings.backups_enabled {
                let _ = kanban::backup_board(&self.kanban_path, self.settings.max_backups);
            }
        }
        Ok(())
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        if !self.terminals.is_empty() {
            self.cleanup_terminals();
        }
        self.watcher_stop.store(true, Ordering::Relaxed);
    }
}
