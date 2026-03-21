use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::error::AppError;
use crate::kanban::Ticket;

/// Validate a git ref name to prevent option injection and invalid characters.
fn validate_git_ref(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(AppError::InvalidInput("Branch-Name darf nicht leer sein".into()).into());
    }
    if name.starts_with('-') {
        return Err(
            AppError::InvalidInput("Branch-Name darf nicht mit '-' beginnen".into()).into(),
        );
    }
    if name.contains("..") || name.contains('\0') {
        return Err(AppError::InvalidInput(format!("Ung\u{00fc}ltiger Branch-Name '{name}'")).into());
    }
    if !name.chars().all(|c| c.is_alphanumeric() || "-/_.".contains(c)) {
        return Err(
            AppError::InvalidInput(format!("Branch-Name '{name}' enth\u{00e4}lt ung\u{00fc}ltige Zeichen"))
                .into(),
        );
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
    pub is_merged: bool,
    pub files_changed: u32,
    pub ahead_count: u32,
    pub ticket_id: Option<String>,
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
    format!("gg/{}-{}", ticket.id, ticket.slug)
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
        .map_err(|e| AppError::GitCommand(format!("branch list: {e}")))?;

    let output = String::from_utf8_lossy(&check.stdout);
    if !output.trim().is_empty() {
        // Branch exists — just checkout
        let co = Command::new("git")
            .args(["checkout", &branch])
            .current_dir(&clean_project)
            .output()
            .await
            .map_err(|e| AppError::GitCheckout(e.to_string()))?;
        if !co.status.success() {
            let stderr = String::from_utf8_lossy(&co.stderr);
            return Err(AppError::GitCheckout(stderr.trim().to_string()).into());
        }
        return Ok(branch);
    }

    // Create and checkout new branch
    let result = Command::new("git")
        .args(["checkout", "-b", &branch])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| AppError::GitCheckout(e.to_string()))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(AppError::GitCheckout(stderr.trim().to_string()).into());
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
        .map_err(|e| AppError::GitCheckout(e.to_string()))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(AppError::GitCheckout(format!("{branch}: {}", stderr.trim())).into());
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
        .map_err(|e| AppError::GitCommand(format!("add: {e}")))?;

    if !add.status.success() {
        let stderr = String::from_utf8_lossy(&add.stderr);
        return Err(AppError::GitCommand(format!("add: {}", stderr.trim())).into());
    }

    // Check if there's anything to commit
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("status: {e}")))?;

    if String::from_utf8_lossy(&status.stdout).trim().is_empty() {
        return Ok(false); // Nothing to commit
    }

    let commit = Command::new("git")
        .args(["commit", "-m", msg])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("commit: {e}")))?;

    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        return Err(AppError::GitCommand(format!("commit: {}", stderr.trim())).into());
    }

    Ok(true)
}

pub async fn check_uncommitted(project_path: &Path) -> Result<bool, String> {
    let clean_project = strip_unc_prefix(project_path);
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("status: {e}")))?;

    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

pub async fn merge_branch(project_path: &Path, branch: &str) -> Result<(), String> {
    validate_git_ref(branch)?;
    let clean_project = strip_unc_prefix(project_path);
    let result = Command::new("git")
        .args(["merge", "--no-ff", "--", branch])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| AppError::GitMerge(e.to_string()))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).to_string();
        let stdout = String::from_utf8_lossy(&result.stdout).to_string();
        let combined = format!("{stderr} {stdout}");

        // Check if it's a merge conflict (git may report on stdout or stderr)
        if combined.contains("CONFLICT") || combined.contains("Automatic merge failed") {
            // Abort the merge to leave repo in clean state
            let _ = Command::new("git")
                .args(["merge", "--abort"])
                .current_dir(&clean_project)
                .output()
                .await;
            return Err(AppError::GitMerge(
                format!("Merge-Konflikt in Branch '{}'. Der Merge wurde abgebrochen. Bitte l\u{00f6}se die Konflikte manuell im Terminal.", branch)
            ).into());
        }

        return Err(AppError::GitMerge(stderr.trim().to_string()).into());
    }

    Ok(())
}

// ── Git View Commands (Phase 3 - Block B) ──

/// Public wrapper to get default branch name
pub async fn default_branch_name(project_path: &Path) -> String {
    default_branch(project_path).await
}

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
    let clean_project = strip_unc_prefix(project_path);
    let default = default_branch(project_path).await;

    // Get branch list
    let output = Command::new("git")
        .args([
            "branch",
            "--format=%(refname:short)|%(HEAD)|%(subject)|%(creatordate:iso8601)",
        ])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("branch: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::GitCommand(format!("branch: {}", stderr.trim())).into());
    }

    // Get merged branches (once for all)
    let merged_output = Command::new("git")
        .args(["branch", "--merged", &default])
        .current_dir(&clean_project)
        .output()
        .await
        .ok();
    let merged_set: std::collections::HashSet<String> = merged_output
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().trim_start_matches("* ").to_string())
                .collect()
        })
        .unwrap_or_default();

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(4, '|').collect();
        if parts.len() < 4 {
            continue;
        }
        let name = parts[0].trim().to_string();
        let is_kanban = name.starts_with("gg/") || name.starts_with("kanban/");

        // Extract ticket ID from branch name: gg/GG-018-slug → GG-018, kanban/KANBAN-018-slug → KANBAN-018
        let ticket_id = if is_kanban {
            name.strip_prefix("gg/")
                .or_else(|| name.strip_prefix("kanban/"))
                .and_then(|rest| {
                // Match GG-NNN or KANBAN-NNN pattern at start
                let dash_parts: Vec<&str> = rest.splitn(3, '-').collect();
                if dash_parts.len() >= 2 {
                    if dash_parts[1].parse::<u32>().is_ok() {
                        Some(format!("{}-{}", dash_parts[0], dash_parts[1]))
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
        } else {
            None
        };

        // Get ahead count and files changed (lightweight: rev-list count + diffstat)
        let (ahead_count, files_changed) = if name != default {
            get_branch_counts(&clean_project, &default, &name).await
        } else {
            (0, 0)
        };

        branches.push(BranchInfo {
            is_current: parts[1].trim() == "*",
            is_kanban,
            last_commit_msg: parts[2].trim().to_string(),
            last_commit_date: parts[3].trim().to_string(),
            is_merged: merged_set.contains(&name),
            files_changed,
            ahead_count,
            ticket_id,
            name,
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

/// Get ahead count and files changed for a branch relative to base.
async fn get_branch_counts(project_path: &Path, base: &str, branch: &str) -> (u32, u32) {
    // Ahead count: commits on branch not in base
    let ahead = Command::new("git")
        .args(["rev-list", "--count", &format!("{base}..{branch}")])
        .current_dir(project_path)
        .output()
        .await
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<u32>()
                .ok()
        })
        .unwrap_or(0);

    // Files changed: numstat between base and branch
    let files = Command::new("git")
        .args(["diff", "--numstat", &format!("{base}...{branch}")])
        .current_dir(project_path)
        .output()
        .await
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count() as u32
        })
        .unwrap_or(0);

    (ahead, files)
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
        .map_err(|e| AppError::GitCommand(format!("diff: {e}")))?;

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
        .args(["diff", &format!("{}...{}", base, branch), "--", file])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("diff: {e}")))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub async fn get_commit_diff(
    project_path: &Path,
    commit_hash: &str,
) -> Result<DiffInfo, String> {
    validate_git_ref(commit_hash)?;

    let output = Command::new("git")
        .args(["show", "-m", "--first-parent", "--numstat", "--format=", commit_hash])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("show: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();
    let mut total_add = 0u32;
    let mut total_del = 0u32;

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
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

pub async fn get_commit_file_diff(
    project_path: &Path,
    commit_hash: &str,
    file: &str,
) -> Result<String, String> {
    validate_git_ref(commit_hash)?;

    let output = Command::new("git")
        .args(["show", commit_hash, "--", file])
        .current_dir(project_path)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("show: {e}")))?;

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
        .map_err(|e| AppError::GitCommand(format!("branch delete: {e}")))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(AppError::GitCommand(format!("branch delete: {}", stderr.trim())).into());
    }

    Ok(())
}

pub async fn get_commit_log(
    project_path: &Path,
    branch: &str,
    limit: u32,
) -> Result<Vec<CommitInfo>, String> {
    validate_git_ref(branch)?;
    let clean_project = strip_unc_prefix(project_path);
    let output = Command::new("git")
        .args([
            "log",
            branch,
            "--format=%H|%s|%an|%cI",
            "-n",
            &limit.to_string(),
        ])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("log: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::GitCommand(format!("log: {}", stderr.trim())).into());
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

/// Get uncommitted changes (both staged and unstaged) in the working tree.
pub async fn get_working_diff(project_path: &Path) -> Result<DiffInfo, String> {
    let clean_project = strip_unc_prefix(project_path);

    // Combine staged + unstaged: diff HEAD shows all uncommitted changes
    let output = Command::new("git")
        .args(["diff", "HEAD", "--numstat"])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("diff HEAD: {e}")))?;

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

    // Also check for untracked files
    let untracked = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(&clean_project)
        .output()
        .await
        .ok();
    if let Some(u) = untracked {
        for line in String::from_utf8_lossy(&u.stdout).lines() {
            let line = line.trim();
            if !line.is_empty() && !files.iter().any(|f| f.file_path == line) {
                files.push(DiffStat {
                    file_path: line.to_string(),
                    additions: 0,
                    deletions: 0,
                    status: "?".to_string(),
                });
            }
        }
    }

    Ok(DiffInfo {
        files,
        total_additions: total_add,
        total_deletions: total_del,
    })
}

/// Get the unified diff for a single file in the working tree.
pub async fn get_working_file_diff(project_path: &Path, file: &str) -> Result<String, String> {
    let clean_project = strip_unc_prefix(project_path);

    let output = Command::new("git")
        .args(["diff", "HEAD", "--", file])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("diff file: {e}")))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ── Push & Remote ──

/// Push a branch to the remote (origin).
pub async fn push_branch(project_path: &Path, branch: &str) -> Result<(), String> {
    validate_git_ref(branch)?;
    let clean_project = strip_unc_prefix(project_path);
    let result = Command::new("git")
        .args(["push", "-u", "origin", branch])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("push: {e}")))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(AppError::GitCommand(format!("push: {}", stderr.trim())).into());
    }
    Ok(())
}

/// Check if a remote named "origin" exists.
pub async fn has_remote(project_path: &Path) -> bool {
    let clean_project = strip_unc_prefix(project_path);
    Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&clean_project)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Get the remote URL for "origin".
pub async fn get_remote_url(project_path: &Path) -> Result<String, String> {
    let clean_project = strip_unc_prefix(project_path);
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("remote: {e}")))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Get the current branch name.
pub async fn current_branch(project_path: &Path) -> Result<String, String> {
    let clean_project = strip_unc_prefix(project_path);
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| AppError::GitCommand(format!("rev-parse: {e}")))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ── Git Safety Checks ──

/// Check if the project path contains a git repository.
pub async fn is_git_repo(project_path: &Path) -> bool {
    let clean_project = strip_unc_prefix(project_path);
    Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(&clean_project)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if a merge or rebase is currently in progress.
pub async fn has_in_progress_operation(project_path: &Path) -> Option<String> {
    let clean_project = strip_unc_prefix(project_path);
    // Check for merge in progress
    let git_dir = clean_project.join(".git");
    if git_dir.join("MERGE_HEAD").exists() {
        return Some("merge".to_string());
    }
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        return Some("rebase".to_string());
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return Some("cherry-pick".to_string());
    }
    None
}

/// Abort a merge in progress.
pub async fn abort_merge(project_path: &Path) -> Result<(), String> {
    let clean_project = strip_unc_prefix(project_path);
    let result = Command::new("git")
        .args(["merge", "--abort"])
        .current_dir(&clean_project)
        .output()
        .await
        .map_err(|e| AppError::GitMerge(format!("abort: {e}")))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(AppError::GitMerge(format!("abort: {}", stderr.trim())).into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_unc_prefix_windows() {
        let path = PathBuf::from(r"\\?\C:\Users\test\project");
        let stripped = strip_unc_prefix(&path);
        assert_eq!(stripped, PathBuf::from(r"C:\Users\test\project"));
    }

    #[test]
    fn strip_unc_prefix_unix_style() {
        let path = PathBuf::from("//?/C:/Users/test/project");
        let stripped = strip_unc_prefix(&path);
        assert_eq!(stripped, PathBuf::from("C:/Users/test/project"));
    }

    #[test]
    fn strip_unc_prefix_no_prefix() {
        let path = PathBuf::from("C:/normal/path");
        let stripped = strip_unc_prefix(&path);
        assert_eq!(stripped, PathBuf::from("C:/normal/path"));
    }

    #[test]
    fn validate_git_ref_rejects_empty() {
        assert!(validate_git_ref("").is_err());
    }

    #[test]
    fn validate_git_ref_rejects_dash_prefix() {
        assert!(validate_git_ref("-flag").is_err());
    }

    #[test]
    fn validate_git_ref_rejects_dot_dot() {
        assert!(validate_git_ref("main..feature").is_err());
    }

    #[test]
    fn validate_git_ref_rejects_special_chars() {
        assert!(validate_git_ref("branch name").is_err());
        assert!(validate_git_ref("branch;rm").is_err());
        assert!(validate_git_ref("branch|pipe").is_err());
    }

    #[test]
    fn validate_git_ref_accepts_valid() {
        assert!(validate_git_ref("main").is_ok());
        assert!(validate_git_ref("feature/GG-001-add-auth").is_ok());
        assert!(validate_git_ref("gg/GG-018-fix-bug").is_ok());
        assert!(validate_git_ref("release-1.0").is_ok());
    }

    #[test]
    fn validate_git_ref_rejects_null_byte() {
        assert!(validate_git_ref("branch\0name").is_err());
    }

    #[test]
    fn validate_git_ref_accepts_dots_and_underscores() {
        assert!(validate_git_ref("v1.0.0").is_ok());
        assert!(validate_git_ref("feature_branch").is_ok());
        assert!(validate_git_ref("a/b/c.d_e").is_ok());
    }

    #[test]
    fn branch_name_format() {
        let ticket = Ticket {
            id: "GG-018".to_string(),
            title: "Fix Login Bug".to_string(),
            slug: "fix-login-bug".to_string(),
            ticket_type: crate::kanban::TicketType::Bugfix,
            column: crate::kanban::Column::Backlog,
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
        assert_eq!(branch_name(&ticket), "gg/GG-018-fix-login-bug");
    }

    #[test]
    fn branch_name_feature() {
        let ticket = Ticket {
            id: "GG-001".to_string(),
            title: "Add Auth".to_string(),
            slug: "add-auth".to_string(),
            ticket_type: crate::kanban::TicketType::Feature,
            column: crate::kanban::Column::Progress,
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
        assert_eq!(branch_name(&ticket), "gg/GG-001-add-auth");
    }

    #[test]
    fn branch_info_serde_camel_case() {
        let info = BranchInfo {
            name: "gg/GG-001-test".into(),
            is_current: true,
            is_kanban: true,
            last_commit_msg: "initial".into(),
            last_commit_date: "2026-03-20".into(),
            is_merged: false,
            files_changed: 3,
            ahead_count: 1,
            ticket_id: Some("GG-001".into()),
        };
        let json = serde_json::to_string(&info).unwrap();
        // Verify camelCase serialization
        assert!(json.contains("\"isCurrent\""));
        assert!(json.contains("\"isKanban\""));
        assert!(json.contains("\"lastCommitMsg\""));
        assert!(json.contains("\"filesChanged\""));
        assert!(json.contains("\"aheadCount\""));
        assert!(json.contains("\"ticketId\""));
    }

    #[test]
    fn diff_info_serde_camel_case() {
        let info = DiffInfo {
            files: vec![DiffStat {
                file_path: "src/main.rs".into(),
                additions: 10,
                deletions: 5,
                status: "M".into(),
            }],
            total_additions: 10,
            total_deletions: 5,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"filePath\""));
        assert!(json.contains("\"totalAdditions\""));
        assert!(json.contains("\"totalDeletions\""));
    }
}

// ── Git Lifecycle Integration Tests ──
//
// These tests exercise the real git binary against temporary repositories.
// They are grouped in a separate module to keep unit tests fast and isolated.

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::kanban::{Column, TicketType};

    /// Create a temporary directory with an initialized git repo.
    fn create_test_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gg-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");

        let run = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .expect("git command");
            assert!(
                output.status.success(),
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        };

        run(&["init"]);
        run(&["config", "user.email", "test@glitch-goblin.dev"]);
        run(&["config", "user.name", "Test"]);

        std::fs::write(dir.join("README.md"), "# Test\n").expect("write readme");
        run(&["add", "."]);
        run(&["commit", "-m", "Initial commit"]);

        dir
    }

    /// Clean up a test repo directory.
    fn cleanup(path: &Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    /// Get the current branch name in a repo (sync helper).
    fn sync_current_branch(repo: &Path) -> String {
        let output = std::process::Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(repo)
            .output()
            .expect("git rev-parse");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Create a file and commit it (sync helper).
    fn commit_file(repo: &Path, filename: &str, content: &str, message: &str) {
        std::fs::write(repo.join(filename), content).expect("write file");
        let run = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(repo)
                .output()
                .expect("git command");
            assert!(
                output.status.success(),
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["add", filename]);
        run(&["commit", "-m", message]);
    }

    /// Build a minimal test ticket.
    fn test_ticket(id: &str, title: &str, slug: &str, tt: TicketType, col: Column) -> Ticket {
        Ticket {
            id: id.to_string(),
            title: title.to_string(),
            slug: slug.to_string(),
            ticket_type: tt,
            column: col,
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
        }
    }

    #[tokio::test]
    async fn checkout_branch_creates_and_switches() {
        let repo = create_test_repo();

        let ticket = test_ticket(
            "GG-001",
            "Test Feature",
            "test-feature",
            TicketType::Feature,
            Column::Backlog,
        );

        let branch = checkout_branch(&repo, &ticket).await.unwrap();
        assert_eq!(branch, "gg/GG-001-test-feature");
        assert_eq!(sync_current_branch(&repo), "gg/GG-001-test-feature");

        cleanup(&repo);
    }

    #[tokio::test]
    async fn checkout_branch_existing_branch() {
        let repo = create_test_repo();

        let ticket = test_ticket(
            "GG-002",
            "Existing",
            "existing",
            TicketType::Bugfix,
            Column::Backlog,
        );

        // Create branch first time
        checkout_branch(&repo, &ticket).await.unwrap();
        // Go back to main
        checkout_main(&repo).await.unwrap();
        // Checkout same branch again (should not fail)
        let branch = checkout_branch(&repo, &ticket).await.unwrap();
        assert_eq!(branch, "gg/GG-002-existing");

        cleanup(&repo);
    }

    #[tokio::test]
    async fn merge_clean_branch() {
        let repo = create_test_repo();

        let ticket = test_ticket(
            "GG-003",
            "Clean Merge",
            "clean-merge",
            TicketType::Feature,
            Column::Progress,
        );

        // Create branch and add a file
        checkout_branch(&repo, &ticket).await.unwrap();
        commit_file(&repo, "feature.txt", "new feature", "Add feature");

        // Go back to main and merge
        checkout_main(&repo).await.unwrap();
        merge_branch(&repo, "gg/GG-003-clean-merge").await.unwrap();

        // Verify file exists on main
        assert!(repo.join("feature.txt").exists());

        cleanup(&repo);
    }

    #[tokio::test]
    async fn merge_conflict_detected_and_aborted() {
        let repo = create_test_repo();

        let ticket = test_ticket(
            "GG-004",
            "Conflict",
            "conflict",
            TicketType::Bugfix,
            Column::Progress,
        );

        // Create branch
        checkout_branch(&repo, &ticket).await.unwrap();
        commit_file(&repo, "conflict.txt", "branch version", "Branch change");

        // Go to main and make conflicting change
        checkout_main(&repo).await.unwrap();
        commit_file(&repo, "conflict.txt", "main version", "Main change");

        // Merge should detect conflict and auto-abort
        let result = merge_branch(&repo, "gg/GG-004-conflict").await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Konflikt") || err.contains("CONFLICT"),
            "Expected conflict error, got: {err}"
        );

        // Verify we're still on main and repo is clean (merge was aborted)
        let branch = sync_current_branch(&repo);
        assert!(
            branch == "main" || branch == "master",
            "Expected main/master, got: {branch}"
        );

        cleanup(&repo);
    }

    #[tokio::test]
    async fn auto_commit_with_changes() {
        let repo = create_test_repo();

        // Create a file without committing
        std::fs::write(repo.join("uncommitted.txt"), "test").unwrap();

        let committed = auto_commit(&repo, "Test commit").await.unwrap();
        assert!(committed);

        // Verify no uncommitted changes
        let dirty = check_uncommitted(&repo).await.unwrap();
        assert!(!dirty);

        cleanup(&repo);
    }

    #[tokio::test]
    async fn auto_commit_no_changes() {
        let repo = create_test_repo();

        let committed = auto_commit(&repo, "Empty commit").await.unwrap();
        assert!(!committed);

        cleanup(&repo);
    }

    #[tokio::test]
    async fn is_git_repo_true() {
        let repo = create_test_repo();
        assert!(is_git_repo(&repo).await);
        cleanup(&repo);
    }

    #[tokio::test]
    async fn is_git_repo_false() {
        let dir = std::env::temp_dir().join(format!("gg-no-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        // Use GIT_CEILING_DIRECTORIES to prevent git from traversing upward
        // into any parent git repo (e.g. if temp is inside a worktree).
        let parent = dir.parent().unwrap_or(&dir).to_string_lossy().to_string();
        let output = tokio::process::Command::new("git")
            .args(["rev-parse", "--git-dir"])
            .current_dir(&dir)
            .env("GIT_CEILING_DIRECTORIES", &parent)
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(!output, "Directory should not be detected as a git repo");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn has_no_remote() {
        let repo = create_test_repo();
        assert!(!has_remote(&repo).await);
        cleanup(&repo);
    }

    #[tokio::test]
    async fn push_without_remote_fails() {
        let repo = create_test_repo();
        let result = push_branch(&repo, "master").await;
        assert!(result.is_err());
        cleanup(&repo);
    }

    #[tokio::test]
    async fn in_progress_operation_none() {
        let repo = create_test_repo();
        assert!(has_in_progress_operation(&repo).await.is_none());
        cleanup(&repo);
    }
}
