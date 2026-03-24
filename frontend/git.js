// ── Git View Module ──
// Card-based branch listing with grouped branches, lazy-loading details.

import { invoke } from '@tauri-apps/api/core';
import { esc, timeAgo } from './utils.js';
import { state, appendLog, showToast, updateGitWarnings } from './app.js';
import { openBoardTerminal } from './terminal.js';
import { t } from './i18n.js';

// ── Git Status ──

/** Prüft auf nicht committete Änderungen und aktualisiert das Git-Status-Badge im Header. */
export async function checkGitStatus() {
  try {
    const dirty = await invoke("check_uncommitted");
    const badge = document.getElementById("git-status");
    if (dirty) {
      badge.textContent = "\u25CF " + t('board.uncommitted');
      badge.classList.add("dirty");
      badge.classList.remove("clean");
    } else {
      badge.textContent = "\u25CF " + t('board.clean');
      badge.classList.add("clean");
      badge.classList.remove("dirty");
    }
  } catch {
    // No project selected
  }
}

// ── Git View (Card-based) ──

/** Lädt und rendert die Git-Branch-Ansicht mit gruppierten Branches, Commit-Historie und Diff-Details. */
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
      container.innerHTML = '<p class="empty-state">' + esc(t('git.noBranches')) + '</p>';
      return;
    }

    // Categorize branches
    const current = branches.find(b => b.isCurrent);
    const activeBranches = branches.filter(b => !b.isCurrent && !b.isMerged);
    const mergedBranches = branches.filter(b => !b.isCurrent && b.isMerged);

    // Current branch — Stitch: branch badge + commit table
    if (current) {
      // Set branch badge and project ID in header
      const branchBadge = document.getElementById("git-active-branch");
      if (branchBadge) branchBadge.textContent = current.name;
      const projIdEl = document.getElementById("git-project-id");
      if (projIdEl) {
        const projId = state.project?.id || state.project?.name || '';
        projIdEl.textContent = projId ? `Project ID: ${projId}` : '';
      }

      const recentCommits = await invoke("get_commit_log", { branch: current.name, limit: 5 }).catch(() => []);

      let commitsTableHtml = "";
      if (recentCommits.length > 0) {
        commitsTableHtml = `
          <div class="git-commits-section">
            <div class="git-section-header">
              <div class="git-section-title">
                <span class="material-symbols-outlined" style="font-size:20px">history</span>
                LETZTE COMMITS
              </div>
              <span class="dash-view-all">VIEW ALL HISTORY</span>
            </div>
            <div class="git-commits-table">
              <div class="git-commits-thead">
                <span>HASH</span><span>MESSAGE</span><span>TIME</span>
              </div>
              ${recentCommits.map(c => `
                <div class="git-commit-table-row">
                  <span class="git-commit-hash-badge">${esc(c.hash)}</span>
                  <div class="git-commit-msg-col">
                    <div class="git-commit-msg-text">${esc(c.message)}</div>
                    ${c.author ? `<div class="git-commit-author">Author: @${esc(c.author)}</div>` : ''}
                  </div>
                  <span class="git-commit-time">${timeAgo(c.date)}</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }

      // Push button for current branch
      let pushHtml = "";
      try {
        const status = await invoke("get_git_status");
        if (status.hasRemote) {
          pushHtml = `
            <div class="git-current-actions">
              <button class="btn-primary" id="btn-push-current" style="padding:6px 16px;font-size:12px">
                <span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle">cloud_upload</span>
                Push ${esc(current.name)}
              </button>
              <span style="font-size:11px;color:var(--text-muted)"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle">link</span> ${esc(status.remoteUrl || '')}</span>
            </div>`;
        }
      } catch {}

      document.getElementById("git-current-branch").innerHTML = commitsTableHtml + pushHtml;

      // Wire push button
      document.getElementById("btn-push-current")?.addEventListener("click", async () => {
        try {
          showToast(t('git.pushing', {branch: current.name}), "info");
          await invoke("push_current_branch");
          showToast(t('git.pushSuccess', {branch: current.name}), "success");
          loadGitView();
        } catch (e) {
          appendLog("Push failed: " + e, true);
          showToast(t('git.pushFailed'), "error");
        }
      });
    }

    let html = "";

    // Active branches (not merged)
    if (activeBranches.length > 0) {
      const kanbanActive = activeBranches.filter(b => b.isKanban);
      const otherActive = activeBranches.filter(b => !b.isKanban);

      if (kanbanActive.length > 0) {
        html += `<div class="git-group-title">${esc(t('git.activeBranches'))} <span class="git-group-count">${kanbanActive.length}</span></div>`;
        html += kanbanActive.map(b => renderBranchCard(b, false)).join("");
      }
      if (otherActive.length > 0) {
        html += `<div class="git-group-title">${esc(t('git.otherBranches'))} <span class="git-group-count">${otherActive.length}</span></div>`;
        html += otherActive.map(b => renderBranchCard(b, false)).join("");
      }
    }

    // Merged branches — Stitch: open grid with merge icons
    if (mergedBranches.length > 0) {
      html += `
        <div class="git-merged-section-title">
          <span class="material-symbols-outlined">verified</span>
          ERLEDIGTE BRANCHES (BEREITS IN MASTER EINGEBAUT)
          <button class="btn-cleanup-merged" id="btn-cleanup-merged" title="${esc(t('git.cleanupMergedTitle'))}">
            <span class="material-symbols-outlined" style="font-size:16px">cleaning_services</span>
            ${esc(t('git.cleanupMerged'))}
          </button>
        </div>
        <div class="git-merged-list">
          ${mergedBranches.map(b => renderMergedBranchRow(b)).join("")}
        </div>
      `;
    }

    if (!html) {
      html = '<p class="empty-state">' + esc(t('git.onlyCurrentBranch')) + '</p>';
    }

    container.innerHTML = html;

    // Event delegation on container (remove first to prevent accumulation on repeated loads)
    container.removeEventListener("click", handleCardClick);
    container.addEventListener("click", handleCardClick);

    // Cleanup merged branches button
    document.getElementById("btn-cleanup-merged")?.addEventListener("click", cleanupMergedBranches);
  } catch (e) {
    container.innerHTML = `<p class="empty-state">Error: ${esc(String(e))}</p>`;
  }
}

function renderBranchCard(branch, compact) {
  // Match ticket title from board
  let ticketTitle = "";
  if (branch.ticketId) {
    const ticket = (state.board.tickets || []).find(tk => tk.id === branch.ticketId);
    if (ticket) ticketTitle = ticket.title;
  }

  const statusClass = branch.isKanban ? "kanban" : "other";
  const aheadLabel = branch.aheadCount > 0 ? `${branch.aheadCount} \u2191` : "";
  const filesLabel = branch.filesChanged > 0 ? `${branch.filesChanged} ${t('git.files')}` : "";
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
        <button class="git-card-btn details" data-action="details" data-branch="${esc(branch.name)}"><span class="material-symbols-outlined" style="font-size:14px">expand_more</span> ${esc(t('git.details'))}</button>
        ${branch.isKanban ? `<button class="git-card-btn merge" data-action="merge" data-branch="${esc(branch.name)}"><span class="material-symbols-outlined" style="font-size:14px">merge</span> ${esc(t('git.merge'))}</button>` : ""}
        <button class="git-card-btn delete" data-action="delete" data-branch="${esc(branch.name)}"><span class="material-symbols-outlined" style="font-size:14px">delete</span> ${esc(t('git.deleteBranch'))}</button>
        <button class="git-card-btn push" data-action="push" data-branch="${esc(branch.name)}"><span class="material-symbols-outlined" style="font-size:14px">cloud_upload</span> ${esc(t('git.push'))}</button>
      </div>
      <div class="git-card-details hidden" data-details-for="${esc(branch.name)}"></div>
    </div>
  `;
}

// Stitch merged branch card
function renderMergedBranchRow(branch) {
  let ticketTitle = "";
  if (branch.ticketId) {
    const ticket = (state.board.tickets || []).find(tk => tk.id === branch.ticketId);
    if (ticket) ticketTitle = ticket.title;
  }
  const description = ticketTitle || branch.lastCommitMsg || "";

  return `
    <div class="git-merged-card" data-branch="${esc(branch.name)}">
      <div class="git-merged-icon">
        <span class="material-symbols-outlined">merge</span>
      </div>
      <div class="git-merged-info">
        <div class="git-merged-name">${esc(branch.name)}</div>
        ${description ? `<div class="git-merged-meta">${esc(description)}</div>` : ''}
      </div>
      <button class="git-card-btn delete git-merged-delete" data-action="delete" data-branch="${esc(branch.name)}" title="${esc(t('git.deleteBranchTitle'))}">
        <span class="material-symbols-outlined" style="font-size:16px">delete</span>
      </button>
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
  } else if (action === "push") {
    await pushBranch(branch);
  }
}

async function toggleDetails(branch, btn) {
  const panel = document.querySelector(`[data-details-for="${CSS.escape(branch)}"]`);
  if (!panel) return;

  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    btn.textContent = "\u25BC " + t('git.details');
    return;
  }

  // Lazy load on first open
  if (!panel.dataset.loaded) {
    panel.innerHTML = '<p class="empty-state" style="font-size:12px">Loading...</p>';
    panel.classList.remove("hidden");
    btn.textContent = "\u25B2 " + t('git.details');

    try {
      const [commits, diff] = await Promise.all([
        invoke("get_commit_log", { branch, limit: 10 }).catch(() => []),
        invoke("get_branch_diff", { branch }).catch(() => ({ files: [], totalAdditions: 0, totalDeletions: 0 })),
      ]);

      let html = "";

      // Diff stats
      html += `<div class="git-detail-stats">
        <span class="stat-add">+${diff.totalAdditions}</span> / <span class="stat-del">-${diff.totalDeletions}</span> ${esc(t('git.inFiles', {count: diff.files.length}))}
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
        html += `<div class="git-detail-section"><h4>${esc(t('git.changedFiles'))}</h4>`;
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
    btn.textContent = "\u25B2 " + t('git.details');
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
      body.textContent = t('git.noDiff');
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
      <span class="stat-add">+${diff.totalAdditions}</span> / <span class="stat-del">-${diff.totalDeletions}</span> ${esc(t('git.inFiles', {count: diff.files.length}))}
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
            : t('git.noDiff');
        } catch (e2) {
          document.getElementById("git-diff-body").textContent = "Error: " + e2;
        }
      });
    });
  } catch (e) {
    document.getElementById("git-diff-body").textContent = "Error: " + e;
  }
}

// ── Git Confirm Dialog ──

/**
 * Zeigt einen modalen Bestätigungsdialog und gibt eine Promise zurück.
 * Ersatz für window.confirm(), das in Tauri/WebView2 nicht zuverlässig blockiert.
 */
function gitConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("modal-git-confirm");
    document.getElementById("git-confirm-message").textContent = message;
    modal.classList.remove("hidden");

    const yesBtn = document.getElementById("btn-git-confirm-yes");
    const noBtn = document.getElementById("btn-git-confirm-no");
    const backdrop = modal.querySelector(".modal-backdrop");

    function finish(result) {
      modal.classList.add("hidden");
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      backdrop.removeEventListener("click", onNo);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onYes() { finish(true); }
    function onNo() { finish(false); }
    function onKey(e) { if (e.key === "Escape") finish(false); }

    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    backdrop.addEventListener("click", onNo);
    document.addEventListener("keydown", onKey);
  });
}

// ── Branch Actions ──

async function mergeBranch(branch) {
  if (!await gitConfirm(t('git.confirmMerge', {branch}))) return;
  try {
    const ticket = state.board.tickets.find(tk => tk.branch === branch);
    if (ticket) {
      await invoke("merge_ticket", { ticketId: ticket.id });
      appendLog(`Merged ${branch}`);
      showToast(`${branch} ${t('git.merged')}`, "success");
    } else {
      appendLog("No ticket found for this branch", true);
    }
    loadGitView();
  } catch (e) {
    appendLog("Merge failed: " + e, true);
  }
}

async function deleteBranch(branch) {
  if (!await gitConfirm(t('git.confirmDelete', {branch}))) return;
  try {
    await invoke("delete_branch_cmd", { branch, force: false });
    appendLog(`Deleted branch: ${branch}`);
    showToast(`${branch} ${t('git.deleted')}`, "success");
    loadGitView();
  } catch (e) {
    const notMerged = String(e).toLowerCase().includes("not fully merged");
    if (notMerged) {
      if (!await gitConfirm(t('git.confirmForceDelete', {branch}))) return;
      try {
        await invoke("delete_branch_cmd", { branch, force: true });
        appendLog(`Force-deleted branch: ${branch}`);
        showToast(`${branch} ${t('git.deleted')}`, "success");
        loadGitView();
      } catch (e2) {
        appendLog("Delete failed: " + e2, true);
      }
    } else {
      appendLog("Delete failed: " + e, true);
    }
  }
}

async function pushBranch(branch) {
  try {
    showToast(t('git.pushing', {branch}), "info");
    await invoke("push_branch", { branch });
    showToast(t('git.pushSuccess', {branch}), "success");
    loadGitView();
  } catch (e) {
    appendLog("Push failed: " + e, true);
    showToast(t('git.pushFailed'), "error");
  }
}

async function cleanupMergedBranches() {
  if (!await gitConfirm(t('git.confirmCleanup'))) return;
  try {
    const deleted = await invoke("cleanup_merged_branches");
    if (deleted.length === 0) {
      showToast(t('git.noMergedToClean'), "info");
    } else {
      appendLog(`Cleaned up ${deleted.length} merged branch(es): ${deleted.join(", ")}`);
      showToast(t('git.cleanupSuccess', {count: deleted.length}), "success");
    }
    loadGitView();
  } catch (e) {
    appendLog("Cleanup failed: " + e, true);
    showToast(t('git.cleanupFailed'), "error");
  }
}

// ── Git Event Listeners ──

/** Registriert Event-Listener für die Schaltflächen der Git-Ansicht (Refresh, Close Diff). */
export function setupGitListeners() {
  document.getElementById("btn-refresh-branches")?.addEventListener("click", loadGitView);

  document.getElementById("btn-close-diff")?.addEventListener("click", () => {
    document.getElementById("git-diff-content").classList.add("hidden");
  });
}
