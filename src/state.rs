use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::config::ProjectEntry;
use crate::kanban::{self, KanbanBoard};
use crate::terminal::TerminalSession;

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
    "sonnet".to_string()
}

fn default_cost_input() -> f64 {
    3.0
}

fn default_cost_output() -> f64 {
    15.0
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
            claude_model: "sonnet".into(),
            cost_per_input_mtok: 3.0,
            cost_per_output_mtok: 15.0,
        }
    }
}

pub struct AppState {
    pub board: KanbanBoard,
    pub project: Option<ProjectEntry>,
    pub projects: Vec<ProjectEntry>,
    pub running_ticket: Option<String>,
    pub log_lines: Vec<String>,
    pub kanban_path: PathBuf,
    pub settings: Settings,
    pub watcher_stop: Arc<AtomicBool>,
    pub terminals: HashMap<String, TerminalSession>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            board: KanbanBoard {
                project_name: String::new(),
                tickets: Vec::new(),
            },
            project: None,
            projects: Vec::new(),
            running_ticket: None,
            log_lines: Vec::new(),
            kanban_path: PathBuf::new(),
            settings: Settings::default(),
            watcher_stop: Arc::new(AtomicBool::new(false)),
            terminals: HashMap::new(),
        }
    }

    pub fn log(&mut self, msg: String) {
        self.log_lines.push(msg);
        if self.log_lines.len() > 500 {
            self.log_lines.remove(0);
        }
    }

    pub fn project_path(&self) -> Option<PathBuf> {
        self.project.as_ref().map(|p| p.path.clone())
    }

    pub fn save_and_backup(&self) -> Result<(), String> {
        kanban::save_board(&self.kanban_path, &self.board)?;
        if self.settings.backups_enabled {
            let _ = kanban::backup_board(&self.kanban_path, self.settings.max_backups);
        }
        Ok(())
    }
}
