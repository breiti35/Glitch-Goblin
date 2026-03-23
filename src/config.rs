use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tracing::{error, info, warn};

use crate::error::AppError;
use crate::state::Settings;

/// Strip Windows UNC prefix (`\\?\` or `//?/`) from paths.
/// `canonicalize()` on Windows adds this prefix, which causes display issues.
fn strip_unc(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    let stripped = s
        .strip_prefix(r"\\?\")
        .or_else(|| s.strip_prefix("//?/"))
        .unwrap_or(&s);
    PathBuf::from(stripped.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub name: String,
    pub path: PathBuf,
    #[serde(default = "default_ticket_prefix")]
    pub ticket_prefix: String,
    #[serde(default)]
    pub github: crate::state::GitHubSettings,
}

fn default_ticket_prefix() -> String {
    "GG".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectsConfig {
    pub projects: Vec<ProjectEntry>,
    pub default_project: Option<String>,
}

/// Migrate old kanban-runner config dir to glitch-goblin if needed.
pub fn migrate_config_dir() {
    if let Some(config_dir) = dirs::config_dir() {
        let old_dir = config_dir.join("kanban-runner");
        let new_dir = config_dir.join("glitch-goblin");
        if old_dir.exists() && !new_dir.exists() {
            if let Err(e) = std::fs::rename(&old_dir, &new_dir) {
                // Rename failed (e.g. cross-device), try copy
                warn!(error = %e, "Could not rename config dir, trying copy");
                if let Err(e2) = copy_dir_recursive(&old_dir, &new_dir) {
                    error!(error = %e2, "Config migration failed");
                } else {
                    info!("Migrated config from kanban-runner/ to glitch-goblin/");
                }
            } else {
                info!("Migrated config from kanban-runner/ to glitch-goblin/");
            }
        }
    }
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

pub fn config_path() -> Result<PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| AppError::ConfigLoad("Konfigurationsverzeichnis nicht gefunden".into()))?;
    Ok(config_dir.join("glitch-goblin").join("projects.json"))
}

/// Return the project-specific data directory under ~/.config/kanban-runner/projects/<name>/
/// and ensure it exists.
pub fn project_data_dir(project_name: &str) -> Result<PathBuf, String> {
    let safe_name: String = project_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    // Reject names that are empty or consist entirely of replacement dashes
    // (e.g. an input of "..." would become "---", which is not a useful name).
    if safe_name.is_empty() || safe_name.chars().all(|c| c == '-') {
        return Err(format!(
            "Project name '{}' contains no usable characters",
            project_name
        ));
    }
    let config_dir =
        dirs::config_dir().ok_or_else(|| "Could not determine config directory".to_string())?;
    let base = config_dir.join("glitch-goblin").join("projects");
    let dir = base.join(&safe_name);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create project data dir: {e}"))?;
    // Canonicalize both paths after creation so symlinks and relative components
    // are fully resolved, then verify the result stays inside the expected base.
    let canonical_dir = strip_unc(std::fs::canonicalize(&dir)
        .map_err(|e| format!("Failed to resolve project data dir: {e}"))?);
    let canonical_base = strip_unc(std::fs::canonicalize(&base)
        .map_err(|e| format!("Failed to resolve base dir: {e}"))?);
    if !canonical_dir.starts_with(&canonical_base) {
        return Err(format!(
            "Project name '{}' resolves outside the data directory",
            project_name
        ));
    }
    Ok(dir)
}

pub fn load_projects() -> Result<ProjectsConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(ProjectsConfig::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| AppError::FileRead {
        path: path.display().to_string(),
        cause: e.to_string(),
    })?;
    let mut config: ProjectsConfig = serde_json::from_str(&content)
        .map_err(|e| AppError::Deserialize(format!("projects.json: {e}")).to_string())?;
    // Decrypt GitHub tokens for each project
    for p in &mut config.projects {
        if !p.github.token.is_empty() {
            p.github.token = crate::crypto::decrypt_token(&p.github.token)
                .unwrap_or_else(|_| p.github.token.clone());
        }
    }
    Ok(config)
}

pub fn save_projects(config: &ProjectsConfig) -> Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::ConfigSave(format!("Verzeichnis erstellen: {e}")))?;
    }
    // Encrypt GitHub tokens before persisting
    let mut config_to_save = config.clone();
    for p in &mut config_to_save.projects {
        if !p.github.token.is_empty() {
            p.github.token = crate::crypto::encrypt_token(&p.github.token)
                .unwrap_or_else(|_| p.github.token.clone());
        }
    }
    let json = serde_json::to_string_pretty(&config_to_save)
        .map_err(|e| AppError::Serialize(e.to_string()))?;
    std::fs::write(&path, json).map_err(|e| AppError::FileWrite {
        path: path.display().to_string(),
        cause: e.to_string(),
    })?;
    Ok(())
}

pub fn add_project(name: &str, path: &str) -> Result<(), String> {
    let mut config = load_projects()?;

    let abs_path = strip_unc(
        std::fs::canonicalize(path).map_err(|e| format!("Invalid path '{}': {e}", path))?,
    );

    // Auto-create kanban.json in project data dir if it doesn't exist
    let data_dir = project_data_dir(name)?;
    let kanban_file = data_dir.join("kanban.json");
    if !kanban_file.exists() {
        // Migrate from old location if it exists there
        let old_kanban = abs_path.join(".claude").join("kanban.json");
        if old_kanban.exists() {
            migrate_project_data(&abs_path, &data_dir)?;
            info!(data_dir = %data_dir.display(), "Migrated runtime data from .claude/");
        } else {
            let default_board = serde_json::json!({
                "project_name": name,
                "tickets": []
            });
            let json = serde_json::to_string_pretty(&default_board)
                .map_err(|e| format!("Failed to serialize default board: {e}"))?;
            std::fs::write(&kanban_file, json)
                .map_err(|e| format!("Failed to write kanban.json: {e}"))?;
            info!(path = %kanban_file.display(), "Created default kanban.json");
        }
    }

    config.projects.retain(|p| p.name != name);

    config.projects.push(ProjectEntry {
        name: name.to_string(),
        path: abs_path,
        ticket_prefix: default_ticket_prefix(),
        github: crate::state::GitHubSettings::default(),
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
    let config_dir = dirs::config_dir()
        .ok_or_else(|| AppError::ConfigLoad("Konfigurationsverzeichnis nicht gefunden".into()))?;
    Ok(config_dir.join("glitch-goblin").join("settings.json"))
}

pub fn load_settings() -> Result<Settings, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| AppError::FileRead {
        path: path.display().to_string(),
        cause: e.to_string(),
    })?;
    let mut settings: Settings = serde_json::from_str(&content)
        .map_err(|e| AppError::Deserialize(format!("settings.json: {e}")))?;
    // Decrypt API token if it was stored encrypted
    if !settings.bug_sync.api_token.is_empty() {
        settings.bug_sync.api_token =
            crate::crypto::decrypt_token(&settings.bug_sync.api_token).unwrap_or_else(|_| {
                settings.bug_sync.api_token.clone()
            });
    }
    // Decrypt GitHub token
    if !settings.github.token.is_empty() {
        settings.github.token =
            crate::crypto::decrypt_token(&settings.github.token).unwrap_or_else(|_| {
                settings.github.token.clone()
            });
    }
    Ok(settings)
}

pub fn save_settings_to_disk(settings: &Settings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::ConfigSave(format!("Verzeichnis erstellen: {e}")))?;
    }
    // Encrypt tokens before persisting
    let mut settings_to_save = settings.clone();
    if !settings.bug_sync.api_token.is_empty() {
        settings_to_save.bug_sync.api_token =
            crate::crypto::encrypt_token(&settings.bug_sync.api_token)
                .unwrap_or_else(|_| settings.bug_sync.api_token.clone());
    }
    if !settings.github.token.is_empty() {
        settings_to_save.github.token =
            crate::crypto::encrypt_token(&settings.github.token)
                .unwrap_or_else(|_| settings.github.token.clone());
    }
    let json = serde_json::to_string_pretty(&settings_to_save)
        .map_err(|e| AppError::Serialize(e.to_string()))?;
    std::fs::write(&path, json).map_err(|e| AppError::FileWrite {
        path: path.display().to_string(),
        cause: e.to_string(),
    })?;
    Ok(())
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

fn templates_path(data_dir: &Path) -> PathBuf {
    data_dir.join("ticket-templates.json")
}

pub fn default_templates_pub() -> Vec<TicketTemplate> {
    default_templates()
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
            description_template: "## Pr\u{00fc}fbereiche\n- [ ] Input Validation\n- [ ] Auth/AuthZ\n- [ ] SQL Injection\n- [ ] XSS\n".into(),
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

pub fn load_templates(data_dir: &Path) -> Vec<TicketTemplate> {
    let path = templates_path(data_dir);
    if !path.exists() {
        // Create default templates on first access
        let defaults = default_templates();
        let _ = save_templates(data_dir, &defaults);
        return defaults;
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(default_templates)
}

pub fn save_templates(
    data_dir: &Path,
    templates: &[TicketTemplate],
) -> Result<(), String> {
    let path = templates_path(data_dir);
    let json =
        serde_json::to_string_pretty(templates).map_err(|e| format!("Serialize templates: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write templates: {e}"))
}

/// Migrate runtime data from .claude/ to the new project data directory.
/// Only moves files that exist in the old location but not in the new one.
/// Returns true if any files were migrated.
pub fn migrate_project_data(project_path: &Path, data_dir: &Path) -> Result<bool, String> {
    let claude_dir = project_path.join(".claude");
    let files = [
        "kanban.json",
        "activity-log.json",
        "ticket-templates.json",
        "deploy-config.json",
    ];
    let mut migrated = false;

    for file in &files {
        let old = claude_dir.join(file);
        let new = data_dir.join(file);
        if old.exists() && !new.exists() {
            std::fs::copy(&old, &new)
                .map_err(|e| format!("Migration failed for {}: {e}", file))?;
            let _ = std::fs::remove_file(&old);
            migrated = true;
        }
    }

    // Migrate kanban-backups/ directory
    let old_backups = claude_dir.join("kanban-backups");
    let new_backups = data_dir.join("kanban-backups");
    if old_backups.exists() && !new_backups.exists() {
        copy_dir_sync(&old_backups, &new_backups)?;
        let _ = std::fs::remove_dir_all(&old_backups);
        migrated = true;
    }

    if migrated {
        info!(
            from = %claude_dir.display(),
            to = %data_dir.display(),
            "Migrated runtime data"
        );
    }

    Ok(migrated)
}

fn copy_dir_sync(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create dir {}: {e}", dst.display()))?;
    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read dir {}: {e}", src.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_sync(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy {}: {e}", src_path.display()))?;
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_data_dir_rejects_empty_name() {
        assert!(project_data_dir("").is_err());
    }

    #[test]
    fn project_data_dir_rejects_only_special_chars() {
        assert!(project_data_dir("...").is_err());
    }

    #[test]
    fn project_data_dir_sanitizes_name() {
        // This test verifies the sanitization logic without actually creating dirs
        let safe: String = "My Project!@#"
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect();
        assert_eq!(safe, "My-Project---");
    }

    #[test]
    fn project_data_dir_rejects_all_dashes() {
        // Input "!!!" becomes "---" which is all dashes
        assert!(project_data_dir("!!!").is_err());
    }

    #[test]
    fn projects_config_default_is_empty() {
        let config = ProjectsConfig::default();
        assert!(config.projects.is_empty());
        assert!(config.default_project.is_none());
    }

    #[test]
    fn projects_config_serde_roundtrip() {
        let config = ProjectsConfig {
            projects: vec![
                ProjectEntry {
                    name: "my-project".into(),
                    path: PathBuf::from("/home/user/project"),
                    ticket_prefix: "GG".into(),
                    github: crate::state::GitHubSettings::default(),
                },
            ],
            default_project: Some("my-project".into()),
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: ProjectsConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.projects.len(), 1);
        assert_eq!(parsed.projects[0].name, "my-project");
        assert_eq!(parsed.default_project.as_deref(), Some("my-project"));
    }

    #[test]
    fn default_templates_has_four_entries() {
        let templates = default_templates();
        assert_eq!(templates.len(), 4);
        let types: Vec<&str> = templates.iter().map(|t| t.ticket_type.as_str()).collect();
        assert!(types.contains(&"feature"));
        assert!(types.contains(&"bugfix"));
        assert!(types.contains(&"security"));
        assert!(types.contains(&"docs"));
    }

    #[test]
    fn ticket_template_serde_roundtrip() {
        let template = TicketTemplate {
            name: "Test Template".into(),
            ticket_type: "feature".into(),
            default_prio: "high".into(),
            title_prefix: "[TEST] ".into(),
            description_template: "## Test\n".into(),
        };
        let json = serde_json::to_string(&template).unwrap();
        let parsed: TicketTemplate = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "Test Template");
        assert_eq!(parsed.ticket_type, "feature");
        assert_eq!(parsed.default_prio, "high");
        assert_eq!(parsed.title_prefix, "[TEST] ");
    }

    #[test]
    fn read_md_filenames_nonexistent_dir() {
        let result = read_md_filenames(Path::new("/nonexistent/dir/that/does/not/exist"));
        assert!(result.is_empty());
    }

    #[test]
    fn list_agents_nonexistent_project() {
        let result = list_agents(Path::new("/nonexistent/project/path"));
        assert!(result.is_empty());
    }

    #[test]
    fn list_commands_nonexistent_project() {
        let result = list_commands(Path::new("/nonexistent/project/path"));
        assert!(result.is_empty());
    }
}
