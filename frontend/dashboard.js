// ── Dashboard Module ──
// Dashboard view, templates, import/export.

import { invoke } from '@tauri-apps/api/core';
import { esc, timeAgo } from './utils.js';
import { state, appendLog, switchView } from './app.js';
import { renderBoard } from './board.js';

// ── Dashboard ──

export async function loadDashboard() {
  if (!state.project) {
    document.getElementById("dashboard-project-name").textContent = "No Project";
    return;
  }
  document.getElementById("dashboard-project-name").textContent = state.project.name;

  try {
    const info = await invoke("get_project_info");

    // Tech stack
    document.getElementById("dash-tech-badges").innerHTML =
      info.techStack.length > 0
        ? info.techStack.map(t => `<span class="tech-badge">${esc(t)}</span>`).join("")
        : '<span style="color:var(--muted)">Unknown</span>';

    // Quick stats
    const tc = info.ticketCounts || {};
    document.getElementById("dash-stats-body").innerHTML = `
      <div class="dash-stat-row"><span>Backlog</span><span class="dash-stat-val">${tc.backlog || 0}</span></div>
      <div class="dash-stat-row"><span>In Progress</span><span class="dash-stat-val">${tc.progress || 0}</span></div>
      <div class="dash-stat-row"><span>Review</span><span class="dash-stat-val">${tc.review || 0}</span></div>
      <div class="dash-stat-row"><span>Done</span><span class="dash-stat-val">${tc.done || 0}</span></div>
      <div class="dash-stat-row"><span>Branches</span><span class="dash-stat-val">${info.branchCount}</span></div>
      <div class="dash-stat-row"><span>Agents</span><span class="dash-stat-val">${info.agentCount}</span></div>
      <div class="dash-stat-row"><span>Commands</span><span class="dash-stat-val">${info.commandCount}</span></div>
    `;

    // README
    document.getElementById("dash-readme-body").textContent =
      info.readmePreview || "(no README found)";

    // Recent commits
    document.getElementById("dash-commits-body").innerHTML =
      info.recentCommits.length > 0
        ? info.recentCommits.map(c => {
            const isMerge = c.message.startsWith("Merge ");
            return `
            <div class="dash-commit-item${isMerge ? " merge-commit" : ""}">
              <span class="hash">${esc(c.hash)}</span>
              ${isMerge ? '<span class="commit-badge merge">M</span>' : ""}
              <span class="msg">${esc(c.message)}</span>
              <span class="date">${timeAgo(c.date)}</span>
            </div>`;
          }).join("")
        : '<span style="color:var(--muted)">No commits</span>';

    // Recent activity
    document.getElementById("dash-activity-body").innerHTML =
      info.recentActivity.length > 0
        ? info.recentActivity.map(a => `
            <div class="dash-activity-item">
              <span class="act-label">${esc(a.action.replace(/_/g, " "))}${a.ticket_title ? " \u2014 " + esc(a.ticket_title) : ""}</span>
              <span class="act-time">${timeAgo(a.timestamp)}</span>
            </div>`).join("")
        : '<span style="color:var(--muted)">No activity</span>';

  } catch (e) {
    console.error("Dashboard error:", e);
  }
}

// ── Templates ──

export async function loadTemplatesForModal() {
  const select = document.getElementById("new-task-template");
  if (!select) return;
  try {
    const templates = await invoke("list_templates");
    select.innerHTML = '<option value="">Kein Template</option>' +
      templates.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
  } catch (e) {
    console.error("Failed to load templates:", e);
  }
}

export function setupTemplateListener() {
  document.getElementById("new-task-template")?.addEventListener("change", async (e) => {
    const name = e.target.value;
    if (!name) return;
    try {
      const templates = await invoke("list_templates");
      const tpl = templates.find(t => t.name === name);
      if (tpl) {
        document.getElementById("new-task-type").value = tpl.ticket_type;
        document.getElementById("new-task-prio").value = tpl.default_prio;
        document.getElementById("new-task-desc").value = tpl.description_template;
        if (tpl.title_prefix) {
          const titleInput = document.getElementById("new-task-title");
          if (!titleInput.value) titleInput.value = tpl.title_prefix;
        }
      }
    } catch (e) {
      console.error("Template load error:", e);
    }
  });
}

// ── Import/Export ──

export function setupImportExportListeners() {
  document.getElementById("btn-export-tickets")?.addEventListener("click", async () => {
    const format = await pickExportFormat();
    if (!format) return;
    try {
      await invoke("export_tickets", { format });
      appendLog("Tickets exported as " + format);
    } catch (e) {
      if (String(e) !== "Cancelled") appendLog("Export error: " + e, true);
    }
  });

  document.getElementById("btn-import-tickets")?.addEventListener("click", async () => {
    const mode = confirm("Replace entire board? OK = Replace, Cancel = Append to Backlog")
      ? "replace" : "append";
    try {
      state.board = await invoke("import_tickets", { mode });
      renderBoard();
      appendLog("Tickets imported (" + mode + ")");
    } catch (e) {
      if (String(e) !== "Cancelled") appendLog("Import error: " + e, true);
    }
  });

  document.getElementById("dash-goto-board")?.addEventListener("click", () => switchView("board"));
}

function pickExportFormat() {
  return new Promise(resolve => {
    const choice = confirm("Export as JSON? OK = JSON, Cancel = CSV");
    resolve(choice ? "json" : "csv");
  });
}
