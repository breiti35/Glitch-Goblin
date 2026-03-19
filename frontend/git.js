// ── Git View Module ──
// Card-based branch listing with grouped branches, lazy-loading details.

import { invoke } from '@tauri-apps/api/core';
import { esc, timeAgo } from './utils.js';
import { state, appendLog, showToast } from './app.js';
import { openBoardTerminal } from './terminal.js';

// ── Git Status ──

export async function checkGitStatus() {
  try {
    const dirty = await invoke("check_uncommitted");
    const badge = document.getElementById("git-status");
    if (dirty) {
      badge.textContent = "\u25CF uncommitted changes";
      badge.classList.add("dirty");
      badge.classList.remove("clean");
    } else {
      badge.textContent = "\u25CF clean";
      badge.classList.add("clean");
      badge.classList.remove("dirty");
    }
  } catch {
    // No project selected
  }
}

// ── Git View (Card-based) ──

export async function loadGitView() {
  const container = document.getElementById("git-branch-cards");
  container.innerHTML = `<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>`;
  document.getElementById("git-current-branch").innerHTML = "";

  try {
    const branches = await invoke("list_branches");
    // Update branch count in both sidebar badge and git-view header
    const countStr = String(branches.length);
    const sidebarBadge = document.getElementById("branch-count");
    const viewBadge = document.getElementById("git-branch-count");
    if (sidebarBadge) sidebarBadge.textContent = countStr;
    if (viewBadge) viewBadge.textContent = countStr;

    if (branches.length === 0) {
      container.innerHTML = '<p class="empty-state">No branches found</p>';
      return;
    }

    // Categorize branches
    const current = branches.find(b => b.isCurrent);
    const activeBranches = branches.filter(b => !b.isCurrent && !b.isMerged);
    const mergedBranches = branches.filter(b => !b.isCurrent && b.isMerged);

    // Current branch info (enhanced)
    if (current) {
      const dirty = await invoke("check_uncommitted").catch(() => false);
      document.getElementById("git-current-branch").innerHTML = `
        <div class="git-current-card">
          <span class="git-current-dot ${dirty ? 'dirty' : 'clean'}"></span>
          <div class="git-current-info">
            <span class="git-current-name">${esc(current.name)}</span>
            <span class="git-current-label">(aktuell)</span>
          </div>
          <span class="git-current-status">${dirty ? 'uncommitted changes' : '\u2713 clean'}</span>
        </div>
      `;
    }

    let html = "";

    // Active branches (not merged)
    if (activeBranches.length > 0) {
      const kanbanActive = activeBranches.filter(b => b.isKanban);
      const otherActive = activeBranches.filter(b => !b.isKanban);

      if (kanbanActive.length > 0) {
        html += `<div class="git-group-title">Aktive Kanban-Branches <span class="git-group-count">${kanbanActive.length}</span></div>`;
        html += kanbanActive.map(b => renderBranchCard(b, false)).join("");
      }
      if (otherActive.length > 0) {
        html += `<div class="git-group-title">Andere aktive Branches <span class="git-group-count">${otherActive.length}</span></div>`;
        html += otherActive.map(b => renderBranchCard(b, false)).join("");
      }
    }

    // Merged branches (compact, collapsible — open by default if no active branches)
    if (mergedBranches.length > 0) {
      const autoOpen = activeBranches.length === 0 ? " open" : "";
      html += `
        <details class="git-merged-group"${autoOpen}>
          <summary class="git-group-title git-group-collapsible">
            Merged Branches <span class="git-group-count">${mergedBranches.length}</span>
          </summary>
          <div class="git-merged-list">
            ${mergedBranches.map(b => renderMergedBranchRow(b)).join("")}
          </div>
        </details>
      `;
    }

    if (!html) {
      html = '<p class="empty-state">Nur der aktuelle Branch vorhanden</p>';
    }

    container.innerHTML = html;

    // Event delegation on container
    container.addEventListener("click", handleCardClick);
  } catch (e) {
    container.innerHTML = `<p class="empty-state">Error: ${esc(String(e))}</p>`;
  }
}

function renderBranchCard(branch, compact) {
  // Match ticket title from board
  let ticketTitle = "";
  if (branch.ticketId) {
    const ticket = (state.board.tickets || []).find(t => t.id === branch.ticketId);
    if (ticket) ticketTitle = ticket.title;
  }

  const statusClass = branch.isKanban ? "kanban" : "other";
  const aheadLabel = branch.aheadCount > 0 ? `${branch.aheadCount} \u2191` : "";
  const filesLabel = branch.filesChanged > 0 ? `${branch.filesChanged} Dateien` : "";
  const metaParts = [filesLabel, aheadLabel].filter(Boolean).join(" | ");

  return `
    <div class="git-branch-card" data-branch="${esc(branch.name)}">
      <div class="git-card-header">
        <span class="status-dot ${statusClass}"></span>
        <div class="git-card-info">
          <span class="git-card-name">${esc(branch.name)}</span>
          ${ticketTitle ? `<span class="git-card-ticket">"${esc(ticketTitle)}"</span>` : ""}
          ${branch.lastCommitMsg ? `<span class="git-card-commit-msg">${esc(branch.lastCommitMsg)}</span>` : ""}
        </div>
        ${metaParts ? `<span class="git-card-meta">${metaParts}</span>` : ""}
      </div>
      <div class="git-card-actions">
        <button class="git-card-btn details" data-action="details" data-branch="${esc(branch.name)}">\u25BC Details</button>
        ${branch.isKanban ? `<button class="git-card-btn merge" data-action="merge" data-branch="${esc(branch.name)}">\u{1F500} Merge</button>` : ""}
        <button class="git-card-btn delete" data-action="delete" data-branch="${esc(branch.name)}">\u{1F5D1} L\u00F6schen</button>
      </div>
      <div class="git-card-details hidden" data-details-for="${esc(branch.name)}"></div>
    </div>
  `;
}

// Compact row for merged branches
function renderMergedBranchRow(branch) {
  let ticketTitle = "";
  if (branch.ticketId) {
    const ticket = (state.board.tickets || []).find(t => t.id === branch.ticketId);
    if (ticket) ticketTitle = ticket.title;
  }
  // Fallback: use last commit message if no ticket title
  const description = ticketTitle || branch.lastCommitMsg || "";

  return `
    <div class="git-merged-row" data-branch="${esc(branch.name)}">
      <span class="status-dot merged"></span>
      <span class="git-merged-name">${esc(branch.name)}</span>
      ${description ? `<span class="git-merged-ticket">${esc(description)}</span>` : ""}
      <span class="git-card-merged">\u2713</span>
      <button class="git-card-btn delete git-merged-delete" data-action="delete" data-branch="${esc(branch.name)}" title="Branch l\u00F6schen">\u{1F5D1}</button>
    </div>
  `;
}

async function handleCardClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  const branch = btn.dataset.branch;

  if (action === "details") {
    await toggleDetails(branch, btn);
  } else if (action === "merge") {
    await mergeBranch(branch);
  } else if (action === "delete") {
    await deleteBranch(branch);
  }
}

async function toggleDetails(branch, btn) {
  const panel = document.querySelector(`[data-details-for="${CSS.escape(branch)}"]`);
  if (!panel) return;

  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    btn.textContent = "\u25BC Details";
    return;
  }

  // Lazy load on first open
  if (!panel.dataset.loaded) {
    panel.innerHTML = '<p class="empty-state" style="font-size:12px">Loading...</p>';
    panel.classList.remove("hidden");
    btn.textContent = "\u25B2 Details";

    try {
      const [commits, diff] = await Promise.all([
        invoke("get_commit_log", { branch, limit: 10 }).catch(() => []),
        invoke("get_branch_diff", { branch }).catch(() => ({ files: [], totalAdditions: 0, totalDeletions: 0 })),
      ]);

      let html = "";

      // Diff stats
      html += `<div class="git-detail-stats">
        <span class="stat-add">+${diff.totalAdditions}</span> / <span class="stat-del">-${diff.totalDeletions}</span> in ${diff.files.length} files
      </div>`;

      // Commits
      if (commits.length > 0) {
        html += `<div class="git-detail-section"><h4>Commits</h4>`;
        html += commits.map(c => {
          const isMerge = c.message.startsWith("Merge ");
          return `<div class="git-commit-item${isMerge ? " merge-commit" : ""}" data-commit="${esc(c.hash)}" style="cursor:pointer">
            <span class="commit-hash">${esc(c.hash)}</span>
            ${isMerge ? '<span class="commit-badge merge">M</span>' : ""}
            <span class="commit-msg">${esc(c.message)}</span>
            <span class="commit-date">${timeAgo(c.date)}</span>
          </div>`;
        }).join("");
        html += `</div>`;
      }

      // Files
      if (diff.files.length > 0) {
        html += `<div class="git-detail-section"><h4>Ge\u00E4nderte Dateien</h4>`;
        html += diff.files.map(f => `
          <div class="git-file-item" data-file="${esc(f.filePath)}" data-branch="${esc(branch)}">
            <span class="file-status ${esc(f.status)}">${esc(f.status)}</span>
            <span class="file-path">${esc(f.filePath)}</span>
            <span class="file-changes">+${f.additions} -${f.deletions}</span>
          </div>
        `).join("");
        html += `</div>`;
      }

      panel.innerHTML = html;
      panel.dataset.loaded = "true";

      // Attach click handlers
      panel.querySelectorAll(".git-file-item").forEach(el => {
        el.addEventListener("click", () => showFileDiff(el.dataset.branch, el.dataset.file));
      });
      panel.querySelectorAll(".git-commit-item").forEach(el => {
        el.addEventListener("click", () => showCommitDiff(el.dataset.commit));
      });
    } catch (e) {
      panel.innerHTML = `<p class="empty-state" style="font-size:12px">Error: ${esc(String(e))}</p>`;
    }
  } else {
    panel.classList.remove("hidden");
    btn.textContent = "\u25B2 Details";
  }
}

// ── Diff Display ──

function renderDiffLines(diff) {
  return diff.split("\n").map(line => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return `<span class="diff-line-add">${esc(line)}</span>`;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      return `<span class="diff-line-del">${esc(line)}</span>`;
    } else if (line.startsWith("@@")) {
      return `<span class="diff-line-hdr">${esc(line)}</span>`;
    }
    return esc(line);
  }).join("\n");
}

async function showFileDiff(branch, filePath) {
  const container = document.getElementById("git-diff-content");
  container.classList.remove("hidden");
  document.getElementById("git-diff-filename").textContent = filePath;
  document.getElementById("git-diff-body").innerHTML = "Loading...";

  try {
    const diff = await invoke("get_file_diff", { branch, filePath });
    const body = document.getElementById("git-diff-body");
    if (!diff.trim()) {
      body.textContent = "(no diff available)";
      return;
    }
    body.innerHTML = renderDiffLines(diff);
  } catch (e) {
    document.getElementById("git-diff-body").textContent = "Error: " + e;
  }
}

async function showCommitDiff(commitHash) {
  const container = document.getElementById("git-diff-content");
  container.classList.remove("hidden");
  document.getElementById("git-diff-filename").textContent = "Commit: " + commitHash;
  document.getElementById("git-diff-body").innerHTML = "Loading...";

  try {
    const diff = await invoke("get_commit_diff", { commitHash });
    let html = `<div class="git-detail-stats" style="margin-bottom:8px">
      <span class="stat-add">+${diff.totalAdditions}</span> / <span class="stat-del">-${diff.totalDeletions}</span> in ${diff.files.length} files
    </div>`;

    html += diff.files.map(f => `
      <div class="git-file-item" data-commit="${esc(commitHash)}" data-file="${esc(f.filePath)}" style="cursor:pointer">
        <span class="file-status ${esc(f.status)}">${esc(f.status)}</span>
        <span class="file-path">${esc(f.filePath)}</span>
        <span class="file-changes">+${f.additions} -${f.deletions}</span>
      </div>
    `).join("");

    document.getElementById("git-diff-body").innerHTML = html;

    document.getElementById("git-diff-body").querySelectorAll(".git-file-item").forEach(el => {
      el.addEventListener("click", async () => {
        try {
          const fileDiff = await invoke("get_commit_file_diff", { commitHash: el.dataset.commit, filePath: el.dataset.file });
          document.getElementById("git-diff-filename").textContent = el.dataset.file;
          document.getElementById("git-diff-body").innerHTML = fileDiff.trim()
            ? renderDiffLines(fileDiff)
            : "(no diff available)";
        } catch (e2) {
          document.getElementById("git-diff-body").textContent = "Error: " + e2;
        }
      });
    });
  } catch (e) {
    document.getElementById("git-diff-body").textContent = "Error: " + e;
  }
}

// ── Branch Actions ──

async function mergeBranch(branch) {
  if (!confirm(`Merge "${branch}" nach main?`)) return;
  try {
    const ticket = state.board.tickets.find(t => t.branch === branch);
    if (ticket) {
      await invoke("merge_ticket", { ticketId: ticket.id });
      appendLog(`Merged ${branch}`);
      showToast(`${branch} gemergt`, "success");
    } else {
      appendLog("No ticket found for this branch", true);
    }
    loadGitView();
  } catch (e) {
    appendLog("Merge failed: " + e, true);
  }
}

async function deleteBranch(branch) {
  if (!confirm(`Branch "${branch}" l\u00F6schen?`)) return;
  try {
    await invoke("delete_branch_cmd", { branch, force: true });
    appendLog(`Deleted branch: ${branch}`);
    showToast(`${branch} gel\u00F6scht`, "success");
    loadGitView();
  } catch (e) {
    appendLog("Delete failed: " + e, true);
  }
}

// ── Git Event Listeners ──

export function setupGitListeners() {
  document.getElementById("btn-refresh-branches")?.addEventListener("click", loadGitView);

  document.getElementById("btn-close-diff")?.addEventListener("click", () => {
    document.getElementById("git-diff-content").classList.add("hidden");
  });
}
