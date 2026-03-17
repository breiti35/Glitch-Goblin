use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Serialize, Deserialize)]
pub struct ActivityEntry {
    pub timestamp: String,
    pub action: String,
    pub ticket_id: Option<String>,
    pub ticket_title: Option<String>,
    pub details: Option<String>,
}

const MAX_ENTRIES: usize = 500;

fn activity_path(project_path: &Path) -> std::path::PathBuf {
    project_path.join(".claude").join("activity-log.json")
}

fn load_entries(project_path: &Path) -> Vec<ActivityEntry> {
    let path = activity_path(project_path);
    if !path.exists() {
        return Vec::new();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_entries(project_path: &Path, entries: &[ActivityEntry]) -> Result<(), String> {
    let path = activity_path(project_path);
    let json =
        serde_json::to_string_pretty(entries).map_err(|e| format!("Serialize activity: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write activity log: {e}"))
}

/// Append an activity entry (called internally, not a Tauri command)
pub fn log_activity(
    project_path: &Path,
    action: &str,
    ticket_id: Option<&str>,
    ticket_title: Option<&str>,
    details: Option<&str>,
) {
    let mut entries = load_entries(project_path);
    entries.push(ActivityEntry {
        timestamp: chrono::Utc::now().to_rfc3339(),
        action: action.to_string(),
        ticket_id: ticket_id.map(|s| s.to_string()),
        ticket_title: ticket_title.map(|s| s.to_string()),
        details: details.map(|s| s.to_string()),
    });

    // Prune to max
    while entries.len() > MAX_ENTRIES {
        entries.remove(0);
    }

    let _ = save_entries(project_path, &entries);
}

/// Get recent activity entries (newest first)
pub fn get_activity(project_path: &Path, limit: usize) -> Vec<ActivityEntry> {
    let entries = load_entries(project_path);
    let start = entries.len().saturating_sub(limit);
    entries[start..].iter().rev().cloned().collect()
}
