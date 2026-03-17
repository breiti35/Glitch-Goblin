use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::kanban::Ticket;

/// Validate a git ref name to prevent option injection and invalid characters.
fn validate_git_ref(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name must not be empty".to_string());
    }
    if name.starts_with('-') {
        return Err("Branch name must not start with '-'".to_string());
    }
    if name.contains("..") || name.contains('\0') {
        return Err(format!("Invalid branch name '{}'", name));
    }
    if !name.chars().all(|c| c.is_alphanumeric() || "-/_. ".contains(c)) {
        return Err(format!("Branch name '{}' contains invalid characters", name));
    }
    Ok(())
}

/// Strip Windows UNC prefix (\\?\ or //?/) that git cannot handle.
pub fn strip_unc_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    let stripped = s
        .strip_prefix(r"\\?\")
        .or_else(|| s.strip_prefix("//?/"))
        .unwrap_or(&s);
    PathBuf::from(stripped.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_kanban: bool,
    pub last_commit_msg: String,
    pub last_commit_date: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStat {
    pub file_path: String,
    pub additions: u32,
    pub deletions: u32,
    pub status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffInfo {
    pub files: Vec<DiffStat>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
}

pub fn branch_name(ticket: &Ticket) -> String {
    format!("kanban/{}-{}", ticket.id, ticket.slug)
}

pub async fn checkout_branch(project_path: &Path, ticket: &Ticket) -> Result<String, String> {
    let branch = branch_name(ticket);
    let clean_project = strip_unc_prefix(project_path);

    // Check if branch already exists
    let check = Command::new("git")
        .args(["branch", "--list", &branch])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| format!("Failed to check branch: {e}"))?;

    let output = String::from_utf8_lossy(&check.stdout);
    if !output.trim().is_empty() {
        // Branch exists — just checkout
        let co = Command::new("git")
            .args(["checkout", &branch])
            .current_dir(&clean_project)
            .output()
            .await
            .map_err(|e| format!("git checkout failed: {e}"))?;
        if !co.status.success() {
            let stderr = String::from_utf8_lossy(&co.stderr);
            return Err(format!("git checkout failed: {stderr}"));
        }
        return Ok(branch);
    }

    // Create and checkout new branch
    let result = Command::new("git")
        .args(["checkout", "-b", &branch])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| format!("Failed to create branch: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!("git checkout -b failed: {stderr}"));
    }

    Ok(branch)
}

pub async fn checkout_main(project_path: &Path) -> Result<(), String> {
    let branch = default_branch(project_path).await;
    let clean_project = strip_unc_prefix(project_path);
    let result = Command::new("git")
        .args(["checkout", &branch])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| format!("git checkout failed: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!("git checkout {branch} failed: {stderr}"));
    }

    Ok(())
}

pub async fn auto_commit(project_path: &Path, msg: &str) -> Result<bool, String> {
    // Stage all changes
    let add = Command::new("git")
        .args(["add", "-A"])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| format!("git add failed: {e}"))?;

    if !add.status.success() {
        let stderr = String::from_utf8_lossy(&add.stderr);
        return Err(format!("git add failed: {stderr}"));
    }

    // Check if there's anything to commit
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| format!("git status failed: {e}"))?;

    if String::from_utf8_lossy(&status.stdout).trim().is_empty() {
        return Ok(false); // Nothing to commit
    }

    let commit = Command::new("git")
        .args(["commit", "-m", msg])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| format!("git commit failed: {e}"))?;

    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        return Err(format!("git commit failed: {stderr}"));
    }

    Ok(true)
}

pub async fn check_uncommitted(project_path: &Path) -> Result<bool, String> {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| format!("git status failed: {e}"))?;

    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

pub async fn merge_branch(project_path: &Path, branch: &str) -> Result<(), String> {
    validate_git_ref(branch)?;
    let result = Command::new("git")
        .args(["merge", "--no-ff", "--", branch])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| format!("git merge failed: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!("git merge failed: {stderr}"));
    }

    Ok(())
}

// ── Git View Commands (Phase 3 - Block B) ──

/// Detect the default branch name (main or master)
async fn default_branch(project_path: &Path) -> String {
    let output = Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
        .current_dir(project_path)
        .output()
        .await;

    if let Ok(o) = output {
        let branch = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !branch.is_empty() {
            // "origin/main" -> "main"
            return branch.rsplit('/').next().unwrap_or("main").to_string();
        }
    }

    // Fallback: check if "main" exists, else "master"
    let check = Command::new("git")
        .args(["branch", "--list", "main"])
        .current_dir(project_path)
        .output()
        .await;

    if let Ok(o) = check {
        if !String::from_utf8_lossy(&o.stdout).trim().is_empty() {
            return "main".to_string();
        }
    }

    "master".to_string()
}

pub async fn list_branches(project_path: &Path) -> Result<Vec<BranchInfo>, String> {
    let output = Command::new("git")
        .args([
            "branch",
            "--format=%(refname:short)|%(HEAD)|%(subject)|%(creatordate:iso8601)",
        ])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| format!("git branch failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branch failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(4, '|').collect();
        if parts.len() < 4 {
            continue;
        }
        branches.push(BranchInfo {
            name: parts[0].trim().to_string(),
            is_current: parts[1].trim() == "*",
            is_kanban: parts[0].trim().starts_with("kanban/"),
            last_commit_msg: parts[2].trim().to_string(),
            last_commit_date: parts[3].trim().to_string(),
        });
    }

    // Sort: current first, then kanban branches, then alphabetical
    branches.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(b.is_kanban.cmp(&a.is_kanban))
            .then(a.name.cmp(&b.name))
    });

    Ok(branches)
}

pub async fn get_branch_diff(
    project_path: &Path,
    branch: &str,
) -> Result<DiffInfo, String> {
    validate_git_ref(branch)?;
    let base = default_branch(project_path).await;

    let output = Command::new("git")
        .args(["diff", "--numstat", &format!("{}...{}", base, branch)])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| format!("git diff failed: {e}"))?;

    // --numstat output: "additions\tdeletions\tfilepath"
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();
    let mut total_add = 0u32;
    let mut total_del = 0u32;

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let additions = parts[0].parse::<u32>().unwrap_or(0);
        let deletions = parts[1].parse::<u32>().unwrap_or(0);
        let file_path = parts[2].to_string();

        let status = if additions > 0 && deletions > 0 {
            "M"
        } else if additions > 0 {
            "A"
        } else {
            "D"
        }
        .to_string();

        total_add += additions;
        total_del += deletions;

        files.push(DiffStat {
            file_path,
            additions,
            deletions,
            status,
        });
    }

    Ok(DiffInfo {
        files,
        total_additions: total_add,
        total_deletions: total_del,
    })
}

pub async fn get_file_diff(
    project_path: &Path,
    branch: &str,
    file: &str,
) -> Result<String, String> {
    validate_git_ref(branch)?;
    let base = default_branch(project_path).await;

    let output = Command::new("git")
        .args([
            "diff",
            &format!("{}...{}", base, branch),
            "--",
            file,
        ])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| format!("git diff failed: {e}"))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub async fn delete_branch(
    project_path: &Path,
    branch: &str,
    force: bool,
) -> Result<(), String> {
    validate_git_ref(branch)?;
    let flag = if force { "-D" } else { "-d" };
    let result = Command::new("git")
        .args(["branch", flag, "--", branch])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| format!("git branch delete failed: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!("git branch delete failed: {stderr}"));
    }

    Ok(())
}

pub async fn get_commit_log(
    project_path: &Path,
    branch: &str,
    limit: u32,
) -> Result<Vec<CommitInfo>, String> {
    validate_git_ref(branch)?;
    let output = Command::new("git")
        .args([
            "log",
            branch,
            "--format=%H|%s|%an|%ci",
            "-n",
            &limit.to_string(),
        ])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| format!("git log failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git log failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut commits = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(4, '|').collect();
        if parts.len() < 4 {
            continue;
        }
        commits.push(CommitInfo {
            hash: parts[0][..8.min(parts[0].len())].to_string(),
            message: parts[1].to_string(),
            author: parts[2].to_string(),
            date: parts[3].to_string(),
        });
    }

    Ok(commits)
}
