// ── Dashboard Module ──
// Dashboard view, templates, import/export, build status.

import { invoke } from '@tauri-apps/api/core';
import { esc, timeAgo, formatDuration, logError } from './utils.js';
import { state, appendLog, switchView, confirmExecute } from './app.js';
import { renderBoard } from './board.js';
import { t } from './i18n.js';
import { renderMarkdown } from './markdown.js';

let buildPollTimer = null;

// ── Dashboard ──

/** Lädt und rendert die Dashboard-Ansicht mit Tech-Stack, Ticket-Statistiken, Commits und Aktivitäten. */
export async function loadDashboard() {
  const projectNameEl = document.getElementById("dashboard-project-name");
  if (!state.project) {
    if (projectNameEl) projectNameEl.textContent = t('dashboard.noProject');
    return;
  }
  if (projectNameEl) projectNameEl.textContent = state.project.name;

  // Breadcrumb — preserve material icon, update text
  const breadcrumb = document.getElementById("dash-breadcrumb");
  if (breadcrumb && state.project) {
    const icon = breadcrumb.querySelector('.material-symbols-outlined');
    const iconHtml = icon ? icon.outerHTML + ' ' : '';
    breadcrumb.innerHTML = iconHtml + `${esc(state.project.name)} / <span style="font-weight:700">main</span>`;
  }

  // Render action cards
  renderDashActions();

  // Build status (async, non-blocking)
  loadBuildStatus();
  startBuildPoll();

  try {
    const info = await invoke("get_project_info");

    // Tech stack (optional element)
    const techEl = document.getElementById("dash-tech-badges");
    if (techEl) {
      techEl.innerHTML = info.techStack.length > 0
        ? info.techStack.map(tech => `<span class="tech-badge">${esc(tech)}</span>`).join("")
        : '';
    }

    // Quick stats (optional element)
    const statsEl = document.getElementById("dash-stats-body");
    if (statsEl) {
      const tc = info.ticketCounts || {};
      statsEl.innerHTML = `
        <div class="dash-stat-row"><span>Backlog</span><span class="dash-stat-val">${tc.backlog || 0}</span></div>
        <div class="dash-stat-row"><span>${esc(t('dashboard.inProgress'))}</span><span class="dash-stat-val">${tc.progress || 0}</span></div>
        <div class="dash-stat-row"><span>Review</span><span class="dash-stat-val">${tc.review || 0}</span></div>
        <div class="dash-stat-row"><span>Done</span><span class="dash-stat-val">${tc.done || 0}</span></div>
      `;
    }

    // README — render as Markdown
    const readmeEl = document.getElementById("dash-readme-body");
    if (readmeEl) {
      if (info.readmePreview) {
        readmeEl.innerHTML = renderMarkdown(info.readmePreview);
      } else {
        readmeEl.textContent = t('dashboard.noReadme');
      }
    }

    // Recent commits — timeline style
    const commitsEl = document.getElementById("dash-commits-body");
    if (commitsEl) commitsEl.innerHTML =
      info.recentCommits.length > 0
        ? '<div class="dash-commit-timeline">' + info.recentCommits.map((c, i) => {
            const isMerge = c.message.startsWith("Merge ");
            const dotClass = i === 0 ? "dash-timeline-dot active" : "dash-timeline-dot";
            return `
            <div class="dash-timeline-entry${isMerge ? " merge-commit" : ""}">
              <div class="${dotClass}"></div>
              <div class="dash-timeline-content">
                <div class="dash-timeline-header">
                  <span class="hash">${esc(c.hash)}</span>
                  <span class="date">${timeAgo(c.date)}</span>
                </div>
                <div class="msg">${esc(c.message)}</div>
                ${c.author ? `<div class="author">${esc(c.author)}</div>` : ""}
              </div>
            </div>`;
          }).join("") + '</div>'
        : '<span style="color:var(--muted)">' + esc(t('dashboard.noCommits')) + '</span>';

    // Recent activity — Stitch style with colored icons
    const activityIconMap = {
      created: { icon: 'add_circle', color: 'var(--accent)' },
      completed: { icon: 'check_circle', color: 'var(--success)' },
      merged: { icon: 'merge', color: 'var(--tertiary)' },
      started: { icon: 'play_circle', color: 'var(--accent)' },
      moved: { icon: 'swap_horiz', color: 'var(--warning)' },
      failed: { icon: 'error', color: 'var(--danger)' },
      deleted: { icon: 'delete', color: 'var(--danger)' },
      backup_restored: { icon: 'restore', color: 'var(--info)' },
    };
    const activityEl = document.getElementById("dash-activity-body");
    if (activityEl) activityEl.innerHTML =
      info.recentActivity.length > 0
        ? info.recentActivity.map(a => {
            const actionKey = a.action.toLowerCase().replace(/ /g, '_');
            const iconInfo = activityIconMap[actionKey] || { icon: 'info', color: 'var(--text-muted)' };
            const actionLabel = a.action.replace(/_/g, " ");
            const ticketRef = a.ticket_id ? `<span class="mono" style="color:var(--accent)">${esc(a.ticket_id)}</span>` : '';
            return `
            <div class="dash-activity-item-stitch">
              <div class="dash-act-icon" style="background:${iconInfo.color}20;color:${iconInfo.color}">
                <span class="material-symbols-outlined" style="font-size:18px">${iconInfo.icon}</span>
              </div>
              <div class="dash-act-body">
                <div class="dash-act-text"><strong>${esc(actionLabel)}</strong>${a.ticket_title ? ' \u2014 ' + esc(a.ticket_title) : ''} ${ticketRef}</div>
                <div class="dash-act-time">${timeAgo(a.timestamp)}</div>
              </div>
            </div>`;
          }).join("")
        : '<span style="color:var(--text-muted)">' + esc(t('dashboard.noActivity')) + '</span>';

  } catch (e) {
    logError("Dashboard error", e);
  }
}

// ── Build Status ──

async function loadBuildStatus() {
  const card = document.getElementById("dash-build-status");
  const valueEl = document.getElementById("dash-build-value");
  const metaEl = document.getElementById("dash-build-meta");
  if (!card || !valueEl) return;

  try {
    const bs = await invoke("get_build_status");

    if (bs.status === "unconfigured") {
      valueEl.innerHTML = `<span class="material-symbols-outlined">settings</span> <span>${esc(t('dashboard.buildUnconfigured'))}</span>`;
      card.className = "dash-kpi dash-kpi-surface";
      if (metaEl) metaEl.innerHTML = "";
      return;
    }
    if (bs.status === "no_runs") {
      valueEl.innerHTML = `<span class="material-symbols-outlined">info</span> <span>${esc(t('dashboard.buildNoRuns'))}</span>`;
      card.className = "dash-kpi dash-kpi-surface";
      if (metaEl) metaEl.innerHTML = "";
      return;
    }

    // Determine display state from status + conclusion
    let icon, label, kpiClass;
    if (bs.status === "completed") {
      if (bs.conclusion === "success") {
        icon = "check_circle"; label = t('dashboard.buildSuccess'); kpiClass = "dash-kpi dash-kpi-build-success";
      } else if (bs.conclusion === "failure") {
        icon = "cancel"; label = t('dashboard.buildFailure'); kpiClass = "dash-kpi dash-kpi-build-failure";
      } else {
        icon = "help"; label = bs.conclusion || "unknown"; kpiClass = "dash-kpi dash-kpi-surface";
      }
    } else if (bs.status === "in_progress" || bs.status === "queued" || bs.status === "waiting" || bs.status === "pending") {
      icon = "pending"; label = t('dashboard.buildPending'); kpiClass = "dash-kpi dash-kpi-build-pending";
    } else {
      icon = "help"; label = bs.status; kpiClass = "dash-kpi dash-kpi-surface";
    }

    valueEl.innerHTML = `<span class="material-symbols-outlined">${icon}</span> <span>${esc(label)}</span>`;
    card.className = kpiClass;

    // Meta: commit, duration, workflow
    if (metaEl) {
      const parts = [];
      if (bs.commitSha) parts.push(`<span class="mono">${esc(bs.commitSha)}</span>`);
      if (bs.durationSecs != null && bs.durationSecs > 0) parts.push(formatDuration(bs.durationSecs * 1000));
      if (bs.workflowName) parts.push(esc(bs.workflowName));
      metaEl.innerHTML = parts.join(" &middot; ");
    }
  } catch (e) {
    valueEl.innerHTML = `<span class="material-symbols-outlined">cloud_off</span> <span>${esc(t('dashboard.buildError'))}</span>`;
    card.className = "dash-kpi dash-kpi-surface";
    if (metaEl) metaEl.innerHTML = "";
    logError("Build status error", e);
  }
}

function startBuildPoll() {
  stopBuildPoll();
  const interval = (state.settings?.github?.poll_interval_secs || 60) * 1000;
  buildPollTimer = setInterval(loadBuildStatus, interval);
}

export function stopBuildPoll() {
  if (buildPollTimer) {
    clearInterval(buildPollTimer);
    buildPollTimer = null;
  }
}

// ── Templates ──

/** Befüllt das Template-Dropdown im "Neues Ticket"-Modal mit den verfügbaren Templates. */
export async function loadTemplatesForModal() {
  const select = document.getElementById("new-task-template");
  if (!select) return;
  try {
    const templates = await invoke("list_templates");
    select.innerHTML = '<option value="">' + esc(t('dashboard.noTemplate')) + '</option>' +
      templates.map(tpl => `<option value="${esc(tpl.name)}">${esc(tpl.name)}</option>`).join("");
  } catch (e) {
    logError("Failed to load templates", e);
  }
}

/** Registriert den Change-Handler für das Template-Dropdown, der Formularfelder automatisch befüllt. */
export function setupTemplateListener() {
  document.getElementById("new-task-template")?.addEventListener("change", async (e) => {
    const name = e.target.value;
    if (!name) return;
    try {
      const templates = await invoke("list_templates");
      const tpl = templates.find(tmpl => tmpl.name === name);
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
      logError("Template load error", e);
    }
  });
}

// ── Import/Export ──

/** Registriert die Event-Handler für Import-/Export-Schaltflächen und den "Zum Board"-Link. */
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
    const mode = confirm(t('dashboard.replaceBoard'))
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

  // README edit button — open in default editor
  document.querySelector(".dash-readme-edit")?.addEventListener("click", async () => {
    try {
      await invoke("open_readme");
    } catch (e) {
      appendLog("README öffnen fehlgeschlagen: " + e, true);
    }
  });
}

function pickExportFormat() {
  return new Promise(resolve => {
    const choice = confirm(t('dashboard.exportFormat'));
    resolve(choice ? "json" : "csv");
  });
}

// ── Dashboard Action Cards ──

function renderDashActions() {
  const container = document.getElementById("dash-actions");
  if (!container) return;

  const tickets = state.board.tickets || [];
  const now = new Date();
  const cards = [];

  // 1. "Weitermachen" — running ticket or last started
  if (state.runningTicket) {
    const tk = tickets.find(tk => tk.id === state.runningTicket);
    if (tk) {
      cards.push(`
        <div class="dash-action-card accent">
          <div class="dash-action-icon">\u25B6</div>
          <div class="dash-action-body">
            <div class="dash-action-title">${esc(t('dashboard.continueWork'))}</div>
            <div class="dash-action-desc">${esc(tk.id)} \u2014 ${esc(tk.title)}</div>
          </div>
          <button class="btn-primary dash-action-btn" data-dash-action="resume">${esc(t('dashboard.toTerminal'))}</button>
        </div>
      `);
    }
  } else {
    // Last worked on: most recently started ticket in progress
    const inProgress = tickets.filter(tk => tk.column === "progress" && tk.started_at)
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    if (inProgress.length > 0) {
      const tk = inProgress[0];
      cards.push(`
        <div class="dash-action-card">
          <div class="dash-action-icon">\u25B6</div>
          <div class="dash-action-body">
            <div class="dash-action-title">${esc(t('dashboard.lastEdited'))}</div>
            <div class="dash-action-desc">${esc(tk.id)} \u2014 ${esc(tk.title)}</div>
          </div>
          <button class="btn-secondary dash-action-btn" data-dash-action="start" data-ticket-id="${tk.id}">${esc(t('dashboard.startTask'))}</button>
        </div>
      `);
    }
  }

  // 2. "Naechste Aufgabe" — oldest high-prio backlog ticket
  const backlog = tickets.filter(tk => tk.column === "backlog");
  const highPrio = backlog.filter(tk => tk.prio === "high");
  const nextTicket = highPrio.length > 0 ? highPrio[0] : (backlog.length > 0 ? backlog[0] : null);
  if (nextTicket && !state.runningTicket) {
    const titleKey = nextTicket.prio === "high" ? 'dashboard.nextTaskHighPrio' : 'dashboard.nextTask';
    cards.push(`
      <div class="dash-action-card">
        <div class="dash-action-icon">\u{1F4CB}</div>
        <div class="dash-action-body">
          <div class="dash-action-title">${esc(t(titleKey))}</div>
          <div class="dash-action-desc">${esc(nextTicket.id)} \u2014 ${esc(nextTicket.title)}</div>
        </div>
        <button class="btn-secondary dash-action-btn" data-dash-action="start" data-ticket-id="${nextTicket.id}">${esc(t('dashboard.startTask'))}</button>
      </div>
    `);
  }

  // 3. Review-Erinnerung
  const inReview = tickets.filter(tk => tk.column === "review");
  if (inReview.length > 0) {
    const oldest = inReview
      .filter(tk => tk.review_at)
      .sort((a, b) => new Date(a.review_at) - new Date(b.review_at))[0];
    const age = oldest ? formatDuration(now - new Date(oldest.review_at)) : "";
    cards.push(`
      <div class="dash-action-card ${inReview.length >= 3 ? 'warn' : ''}">
        <div class="dash-action-icon">\u{1F50D}</div>
        <div class="dash-action-body">
          <div class="dash-action-title">${esc(t('dashboard.ticketsWaitingReview', {count: inReview.length}))}</div>
          <div class="dash-action-desc">${age ? esc(t('dashboard.oldestSince', {time: age})) : esc(t('dashboard.switchToBoard'))}</div>
        </div>
        <button class="btn-secondary dash-action-btn" data-dash-action="board">${esc(t('dashboard.goToBoard'))}</button>
      </div>
    `);
  }

  container.innerHTML = cards.join("");

  // Event handlers
  container.querySelectorAll("[data-dash-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.dashAction;
      if (action === "resume" || action === "board") {
        switchView("board");
      } else if (action === "start") {
        const ticket = tickets.find(tk => tk.id === btn.dataset.ticketId);
        if (ticket) confirmExecute(ticket);
      }
    });
  });
}
