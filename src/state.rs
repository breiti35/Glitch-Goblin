use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::error;

use crate::config::ProjectEntry;
use crate::kanban::KanbanBoard;
use crate::undo::UndoManager;
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

fn default_language() -> String {
    "de".to_string()
}

fn default_card_expand_mode() -> String {
    "click".to_string()
}

fn default_ticket_sort_mode() -> String {
    "priority".to_string()
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

fn default_github_poll_interval() -> u64 {
    60
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnthropicOAuth {
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// ISO-8601 timestamp when the access token expires.
    #[serde(default)]
    pub expires_at: String,
    /// Display name of the connected Anthropic account.
    #[serde(default)]
    pub account_name: String,
}

impl Default for AnthropicOAuth {
    fn default() -> Self {
        Self {
            access_token: String::new(),
            refresh_token: String::new(),
            expires_at: String::new(),
            account_name: String::new(),
        }
    }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default = "default_github_poll_interval")]
    pub poll_interval_secs: u64,
}

impl Default for GitHubSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            token: String::new(),
            owner: String::new(),
            repo: String::new(),
            poll_interval_secs: 60,
        }
    }
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
    #[serde(default)]
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
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_card_expand_mode")]
    pub card_expand_mode: String,
    #[serde(default = "default_ticket_sort_mode")]
    pub ticket_sort_mode: String,
    #[serde(default)]
    pub auto_push_after_merge: bool,
    #[serde(default)]
    pub bug_sync: BugSyncSettings,
    #[serde(default)]
    pub github: GitHubSettings,
    #[serde(default)]
    pub anthropic_oauth: AnthropicOAuth,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_execute_types: vec!["docs".into(), "security".into()],
            commit_prefix: String::new(),
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
            language: "de".into(),
            card_expand_mode: "click".into(),
            ticket_sort_mode: "priority".into(),
            auto_push_after_merge: false,
            bug_sync: BugSyncSettings::default(),
            github: GitHubSettings::default(),
            anthropic_oauth: AnthropicOAuth::default(),
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
    pub undo_manager: UndoManager,
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
            undo_manager: UndoManager::new(),
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
        let conn = self
            .db
            .as_ref()
            .ok_or("Keine aktive Datenbankverbindung")?;
        crate::db::save_board(conn, &self.board)?;
        if self.settings.backups_enabled {
            if let Some(dd) = self.data_dir() {
                if let Err(e) = crate::db::backup(conn, &dd, self.settings.max_backups) {
                    error!(error = %e, "Backup failed");
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_values() {
        let s = Settings::default();
        assert_eq!(s.language, "de");
        assert!(!s.auto_push_after_merge);
        assert!(s.commit_prefix.is_empty());
        assert_eq!(s.max_backups, 10);
        assert_eq!(s.terminal_font_size, 14);
        assert!(s.notifications_enabled);
        assert!(s.sounds_enabled);
        assert!(s.backups_enabled);
        assert_eq!(s.theme, "dark");
        assert_eq!(s.accent_color, "#F97316");
        assert_eq!(s.claude_cli_path, "claude");
        assert_eq!(s.claude_model, "claude-sonnet-4-6");
        assert!((s.cost_per_input_mtok - 3.0).abs() < f64::EPSILON);
        assert!((s.cost_per_output_mtok - 15.0).abs() < f64::EPSILON);
        assert!(s.default_shell.is_empty());
    }

    #[test]
    fn settings_default_auto_execute_types() {
        let s = Settings::default();
        assert!(s.auto_execute_types.contains(&"docs".to_string()));
        assert!(s.auto_execute_types.contains(&"security".to_string()));
        assert_eq!(s.auto_execute_types.len(), 2);
    }

    #[test]
    fn settings_serde_with_missing_fields() {
        // Simulate loading an old settings file without new fields
        let json = r##"{
            "auto_execute_types": ["docs"],
            "commit_prefix": "fix:",
            "claude_cli_path": "claude",
            "accent_color": "#FF0000",
            "theme": "light"
        }"##;
        let s: Settings = serde_json::from_str(json).unwrap();
        // New fields should have defaults
        assert_eq!(s.language, "de");
        assert!(!s.auto_push_after_merge);
        assert_eq!(s.max_backups, 10);
        assert!(s.notifications_enabled);
        assert!(s.sounds_enabled);
        assert!(s.backups_enabled);
        assert_eq!(s.terminal_font_size, 14);
        assert_eq!(s.claude_model, "claude-sonnet-4-6");
        // Explicitly set fields should be preserved
        assert_eq!(s.commit_prefix, "fix:");
        assert_eq!(s.accent_color, "#FF0000");
        assert_eq!(s.theme, "light");
        assert_eq!(s.auto_execute_types, vec!["docs"]);
    }

    #[test]
    fn settings_serde_roundtrip() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        let s2: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s2.language, s.language);
        assert_eq!(s2.commit_prefix, s.commit_prefix);
        assert_eq!(s2.claude_model, s.claude_model);
        assert_eq!(s2.max_backups, s.max_backups);
        assert_eq!(s2.terminal_font_size, s.terminal_font_size);
        assert_eq!(s2.theme, s.theme);
        assert_eq!(s2.accent_color, s.accent_color);
    }

    #[test]
    fn bugsync_settings_default() {
        let bs = BugSyncSettings::default();
        assert!(!bs.enabled);
        assert!(bs.api_url.is_empty());
        assert!(bs.api_token.is_empty());
        assert_eq!(bs.interval_secs, 300);
    }

    #[test]
    fn bugsync_settings_serde_with_defaults() {
        let json = r#"{}"#;
        let bs: BugSyncSettings = serde_json::from_str(json).unwrap();
        assert!(!bs.enabled);
        assert!(bs.api_url.is_empty());
        assert_eq!(bs.interval_secs, 300);
    }

    #[test]
    fn bugsync_settings_serde_roundtrip() {
        let bs = BugSyncSettings {
            enabled: true,
            api_url: "https://api.example.com".into(),
            api_token: "secret-token".into(),
            interval_secs: 600,
        };
        let json = serde_json::to_string(&bs).unwrap();
        let parsed: BugSyncSettings = serde_json::from_str(&json).unwrap();
        assert!(parsed.enabled);
        assert_eq!(parsed.api_url, "https://api.example.com");
        assert_eq!(parsed.api_token, "secret-token");
        assert_eq!(parsed.interval_secs, 600);
    }

    #[test]
    fn github_settings_default() {
        let gh = GitHubSettings::default();
        assert!(!gh.enabled);
        assert!(gh.token.is_empty());
        assert!(gh.owner.is_empty());
        assert!(gh.repo.is_empty());
        assert_eq!(gh.poll_interval_secs, 60);
    }

    #[test]
    fn github_settings_serde_with_defaults() {
        let json = r#"{}"#;
        let gh: GitHubSettings = serde_json::from_str(json).unwrap();
        assert!(!gh.enabled);
        assert!(gh.owner.is_empty());
        assert_eq!(gh.poll_interval_secs, 60);
    }

    #[test]
    fn github_settings_serde_roundtrip() {
        let gh = GitHubSettings {
            enabled: true,
            token: "ghp_test123".into(),
            owner: "myorg".into(),
            repo: "myrepo".into(),
            poll_interval_secs: 120,
        };
        let json = serde_json::to_string(&gh).unwrap();
        let parsed: GitHubSettings = serde_json::from_str(&json).unwrap();
        assert!(parsed.enabled);
        assert_eq!(parsed.token, "ghp_test123");
        assert_eq!(parsed.owner, "myorg");
        assert_eq!(parsed.repo, "myrepo");
        assert_eq!(parsed.poll_interval_secs, 120);
    }

    #[test]
    fn settings_with_github_defaults_from_old_json() {
        // Simulate loading an old settings file without github field
        let json = r##"{
            "auto_execute_types": ["docs"],
            "commit_prefix": "",
            "claude_cli_path": "claude",
            "accent_color": "#F97316",
            "theme": "dark"
        }"##;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert!(!s.github.enabled);
        assert!(s.github.token.is_empty());
        assert_eq!(s.github.poll_interval_secs, 60);
    }

    #[test]
    fn app_state_new_defaults() {
        let state = AppState::new();
        assert!(state.board.project_name.is_empty());
        assert!(state.board.tickets.is_empty());
        assert_eq!(state.board.next_ticket_id, 1);
        assert!(state.project.is_none());
        assert!(state.projects.is_empty());
        assert!(state.running_ticket.is_none());
        assert!(state.log_lines.is_empty());
        assert!(state.kanban_path.as_os_str().is_empty());
        assert!(state.terminals.is_empty());
        assert!(state.db.is_none());
    }

    #[test]
    fn app_state_log_appends_messages() {
        let mut state = AppState::new();
        state.log("first".into());
        state.log("second".into());
        assert_eq!(state.log_lines.len(), 2);
        assert_eq!(state.log_lines[0], "first");
        assert_eq!(state.log_lines[1], "second");
    }

    #[test]
    fn app_state_log_prunes_at_500() {
        let mut state = AppState::new();
        for i in 0..510 {
            state.log(format!("msg-{}", i));
        }
        assert_eq!(state.log_lines.len(), 500);
        // Oldest messages should be pruned
        assert_eq!(state.log_lines[0], "msg-10");
        assert_eq!(*state.log_lines.back().unwrap(), "msg-509");
    }

    #[test]
    fn app_state_project_path_none_when_no_project() {
        let state = AppState::new();
        assert!(state.project_path().is_none());
    }

    #[test]
    fn app_state_project_path_some_when_set() {
        let mut state = AppState::new();
        state.project = Some(ProjectEntry {
            name: "test".into(),
            path: PathBuf::from("/home/user/project"),
            ticket_prefix: "GG".into(),
            github: GitHubSettings::default(),
            bug_sync: BugSyncSettings::default(),
        });
        assert_eq!(state.project_path(), Some(PathBuf::from("/home/user/project")));
    }

    #[test]
    fn app_state_data_dir_none_when_empty() {
        let state = AppState::new();
        assert!(state.data_dir().is_none());
    }

    #[test]
    fn app_state_data_dir_some_when_set() {
        let mut state = AppState::new();
        state.data_dir = PathBuf::from("/home/user/.config/glitch-goblin/projects/test");
        assert!(state.data_dir().is_some());
    }

    #[test]
    fn app_state_watcher_stop_initial_false() {
        let state = AppState::new();
        assert!(!state.watcher_stop.load(Ordering::Relaxed));
    }
}
