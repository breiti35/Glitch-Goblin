use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::state::Settings;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectsConfig {
    pub projects: Vec<ProjectEntry>,
    pub default_project: Option<String>,
}

pub fn config_path() -> Result<PathBuf, String> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| "Could not determine config directory".to_string())?;
    Ok(config_dir.join("kanban-runner").join("projects.json"))
}

pub fn load_projects() -> Result<ProjectsConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(ProjectsConfig::default());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {e}"))
}

pub fn save_projects(config: &ProjectsConfig) -> Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write config: {e}"))
}

pub fn add_project(name: &str, path: &str) -> Result<(), String> {
    let mut config = load_projects()?;

    let abs_path =
        std::fs::canonicalize(path).map_err(|e| format!("Invalid path '{}': {e}", path))?;

    // Auto-create .claude/kanban.json if it doesn't exist
    let claude_dir = abs_path.join(".claude");
    let kanban_file = claude_dir.join("kanban.json");
    if !kanban_file.exists() {
        std::fs::create_dir_all(&claude_dir)
            .map_err(|e| format!("Failed to create .claude dir: {e}"))?;
        let default_board = serde_json::json!({
            "project_name": name,
            "tickets": []
        });
        let json = serde_json::to_string_pretty(&default_board)
            .map_err(|e| format!("Failed to serialize default board: {e}"))?;
        std::fs::write(&kanban_file, json)
            .map_err(|e| format!("Failed to write kanban.json: {e}"))?;
        eprintln!("[kanban-runner] Created default kanban.json at {}", kanban_file.display());
    }

    config.projects.retain(|p| p.name != name);

    config.projects.push(ProjectEntry {
        name: name.to_string(),
        path: abs_path,
    });

    if config.default_project.is_none() {
        config.default_project = Some(name.to_string());
    }

    save_projects(&config)?;
    Ok(())
}

pub fn resolve_default_project() -> Result<Option<ProjectEntry>, String> {
    let config = load_projects()?;

    if let Some(default_name) = &config.default_project {
        return Ok(config.projects.iter().find(|p| &p.name == default_name).cloned());
    }

    Ok(None)
}

pub fn settings_path() -> Result<PathBuf, String> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| "Could not determine config directory".to_string())?;
    Ok(config_dir.join("kanban-runner").join("settings.json"))
}

pub fn load_settings() -> Result<Settings, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {e}"))
}

pub fn save_settings_to_disk(settings: &Settings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write settings: {e}"))
}

pub fn list_agents(project_path: &std::path::Path) -> Vec<String> {
    let agents_dir = project_path.join(".claude").join("agents");
    read_md_filenames(&agents_dir)
}

pub fn list_commands(project_path: &std::path::Path) -> Vec<String> {
    let commands_dir = project_path.join(".claude").join("commands");
    read_md_filenames(&commands_dir)
}

// ── Ticket Templates (Phase 3 - Block D) ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketTemplate {
    pub name: String,
    pub ticket_type: String,
    pub default_prio: String,
    pub title_prefix: String,
    pub description_template: String,
}

fn templates_path(project_path: &std::path::Path) -> PathBuf {
    project_path.join(".claude").join("ticket-templates.json")
}

fn default_templates() -> Vec<TicketTemplate> {
    vec![
        TicketTemplate {
            name: "Neues Feature".into(),
            ticket_type: "feature".into(),
            default_prio: "medium".into(),
            title_prefix: String::new(),
            description_template: "## Ziel\n\n## Akzeptanzkriterien\n- [ ] \n- [ ] \n\n## Technische Details\n".into(),
        },
        TicketTemplate {
            name: "Bug-Fix".into(),
            ticket_type: "bugfix".into(),
            default_prio: "high".into(),
            title_prefix: "[FIX] ".into(),
            description_template: "## Symptom\n\n## Ursache\n\n## Fix\n".into(),
        },
        TicketTemplate {
            name: "Security Audit".into(),
            ticket_type: "security".into(),
            default_prio: "high".into(),
            title_prefix: "[SEC] ".into(),
            description_template: "## Prüfbereiche\n- [ ] Input Validation\n- [ ] Auth/AuthZ\n- [ ] SQL Injection\n- [ ] XSS\n".into(),
        },
        TicketTemplate {
            name: "Doku Update".into(),
            ticket_type: "docs".into(),
            default_prio: "low".into(),
            title_prefix: "[DOC] ".into(),
            description_template: "## Zu dokumentieren\n\n## Zielgruppe\n".into(),
        },
    ]
}

pub fn load_templates(project_path: &std::path::Path) -> Vec<TicketTemplate> {
    let path = templates_path(project_path);
    if !path.exists() {
        // Create default templates on first access
        let defaults = default_templates();
        let _ = save_templates(project_path, &defaults);
        return defaults;
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(default_templates)
}

pub fn save_templates(
    project_path: &std::path::Path,
    templates: &[TicketTemplate],
) -> Result<(), String> {
    let path = templates_path(project_path);
    let json =
        serde_json::to_string_pretty(templates).map_err(|e| format!("Serialize templates: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write templates: {e}"))
}

fn read_md_filenames(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
        .filter_map(|e| {
            e.path()
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
        })
        .collect()
}
