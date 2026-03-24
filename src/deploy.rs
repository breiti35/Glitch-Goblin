use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ── Structs ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployConfig {
    #[serde(default)]
    pub deploy_type: String,
    #[serde(default)]
    pub compose_files: Vec<String>,
    #[serde(default)]
    pub env_file: String,
    #[serde(default)]
    pub local_url: String,
    #[serde(default)]
    pub live_enabled: bool,
    #[serde(default)]
    pub ssh_host: String,
    #[serde(default)]
    pub ssh_key: String,
    #[serde(default)]
    pub ssh_port: u16,
    #[serde(default)]
    pub server_path: String,
    #[serde(default)]
    pub server_branch: String,
    #[serde(default)]
    pub pre_commands: Vec<String>,
    #[serde(default)]
    pub deploy_commands: Vec<String>,
    #[serde(default)]
    pub post_commands: Vec<String>,
    #[serde(default)]
    pub live_url: String,
}

impl Default for DeployConfig {
    fn default() -> Self {
        Self {
            deploy_type: "compose".into(),
            compose_files: Vec::new(),
            env_file: String::new(),
            local_url: String::new(),
            live_enabled: false,
            ssh_host: String::new(),
            ssh_key: String::new(),
            ssh_port: 22,
            server_path: String::new(),
            server_branch: "main".into(),
            pre_commands: Vec::new(),
            deploy_commands: Vec::new(),
            post_commands: Vec::new(),
            live_url: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    pub installed: bool,
    pub running: bool,
    pub compose_available: bool,
    pub version: String,
    pub compose_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployEnvironment {
    pub docker: DockerStatus,
    pub ssh_available: bool,
    pub ssh_keys: Vec<String>,
    pub compose_files: Vec<String>,
    pub env_files: Vec<String>,
    pub has_cargo_toml: bool,
    pub has_package_json: bool,
}

// ── Config Persistence ──

fn deploy_config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("deploy-config.json")
}

pub fn load_deploy_config(data_dir: &Path) -> DeployConfig {
    let path = deploy_config_path(data_dir);
    if !path.exists() {
        return DeployConfig::default();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_deploy_config(data_dir: &Path, config: &DeployConfig) -> Result<(), String> {
    let path = deploy_config_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create deploy config dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Serialize deploy config: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write deploy config: {e}"))
}

// ── Docker Detection ──

pub async fn check_docker(project_path: &Path) -> DockerStatus {
    let version = run_cmd("docker", &["--version"]).await.unwrap_or_default();
    let installed = !version.is_empty();

    let running = if installed {
        run_cmd("docker", &["info"]).await.is_ok()
    } else {
        false
    };

    let compose_version = run_cmd("docker", &["compose", "version"]).await;
    let compose_available = compose_version.is_ok();

    let compose_files = scan_compose_files(project_path);

    DockerStatus {
        installed,
        running,
        compose_available,
        version: version.trim().to_string(),
        compose_files,
    }
}

// ── Environment Detection ──

pub async fn detect_deploy_environment(project_path: &Path) -> DeployEnvironment {
    let docker = check_docker(project_path).await;

    let ssh_available = run_cmd("ssh", &["-V"]).await.is_ok();

    let ssh_keys = detect_ssh_keys();
    let compose_files = scan_compose_files(project_path);
    let env_files = scan_env_files(project_path);

    let has_cargo_toml = project_path.join("Cargo.toml").exists();
    let has_package_json = project_path.join("package.json").exists();

    DeployEnvironment {
        docker,
        ssh_available,
        ssh_keys,
        compose_files,
        env_files,
        has_cargo_toml,
        has_package_json,
    }
}

// ── Command Builders ──

pub fn build_compose_command(config: &DeployConfig, project_path: &Path, action: &str) -> Result<String, String> {
    let mut parts = vec!["docker".to_string(), "compose".to_string()];

    if config.compose_files.is_empty() {
        let detected = scan_compose_files(project_path);
        for f in &detected {
            parts.push("-f".into());
            parts.push(shell_escape(f));
        }
    } else {
        for f in &config.compose_files {
            validate_deploy_param("Compose file", f)?;
            parts.push("-f".into());
            parts.push(shell_escape(f));
        }
    }

    if !config.env_file.is_empty() {
        validate_deploy_param("Env file", &config.env_file)?;
        parts.push("--env-file".into());
        parts.push(shell_escape(&config.env_file));
    }

    parts.push(action.to_string());

    if action == "up" {
        parts.push("--build".into());
        parts.push("-d".into());
    }

    Ok(parts.join(" "))
}

/// Shell-escape a string for safe inclusion in shell commands.
fn shell_escape(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if s.chars().all(|c| c.is_alphanumeric() || "-_./~@:+".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Validate that a deploy parameter doesn't contain shell metacharacters.
fn validate_deploy_param(name: &str, value: &str) -> Result<(), String> {
    if value.contains('\0') {
        return Err(format!("{} must not contain null bytes", name));
    }
    let forbidden = [';', '|', '&', '$', '`', '\n', '\r'];
    for c in &forbidden {
        if value.contains(*c) {
            return Err(format!("{} contains forbidden character '{}'", name, c));
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub fn build_ssh_command(config: &DeployConfig, commands: &[String]) -> Result<String, String> {
    validate_deploy_param("SSH host", &config.ssh_host)?;
    validate_deploy_param("SSH key", &config.ssh_key)?;
    validate_deploy_param("Server path", &config.server_path)?;

    let mut parts = vec!["ssh".to_string()];

    if !config.ssh_key.is_empty() {
        parts.push("-i".into());
        parts.push(shell_escape(&config.ssh_key));
    }

    if config.ssh_port != 22 && config.ssh_port != 0 {
        parts.push("-p".into());
        parts.push(config.ssh_port.to_string());
    }

    parts.push(shell_escape(&config.ssh_host));

    // Build remote command string
    let mut remote_cmds = Vec::new();
    if !config.server_path.is_empty() {
        remote_cmds.push(format!("cd {}", shell_escape(&config.server_path)));
    }
    for cmd in commands {
        validate_deploy_param("Deploy command", cmd)?;
        remote_cmds.push(cmd.clone());
    }

    let joined = remote_cmds.join(" && ");
    parts.push(format!("\"{}\"", joined));

    Ok(parts.join(" "))
}

// ── Helpers ──

async fn run_cmd(program: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = crate::process_util::async_cmd_no_window(program);
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = cmd.output()
        .await
        .map_err(|e| format!("{e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn scan_compose_files(project_path: &Path) -> Vec<String> {
    let candidates = [
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml",
        "docker-compose.override.yml",
        "docker-compose.override.yaml",
        "docker-compose.prod.yml",
        "docker-compose.prod.yaml",
    ];
    candidates
        .iter()
        .filter(|f| project_path.join(f).exists())
        .map(|f| f.to_string())
        .collect()
}

fn scan_env_files(project_path: &Path) -> Vec<String> {
    let candidates = [".env", ".env.local", ".env.production", ".env.docker"];
    candidates
        .iter()
        .filter(|f| project_path.join(f).exists())
        .map(|f| f.to_string())
        .collect()
}

fn detect_ssh_keys() -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let ssh_dir = home.join(".ssh");
    if !ssh_dir.exists() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&ssh_dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with("id_") && !name.ends_with(".pub")
        })
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name != "config"
        })
        .map(|e| e.path().to_string_lossy().to_string())
        .collect()
}
