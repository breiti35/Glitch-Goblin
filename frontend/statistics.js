// ── Statistics Module ──
// Charts, metrics, recent completed — Stitch Design.

import { esc, formatDuration } from './utils.js';
import { state } from './app.js';
import { t } from './i18n.js';
import { invoke } from '@tauri-apps/api/core';

export async function loadStatistics() {
  // Board-Tickets + archivierte Tickets fuer vollstaendige Statistik
  const boardTickets = state.board.tickets || [];
  let archivedTickets = [];
  try {
    archivedTickets = await invoke("get_archived_tickets");
  } catch { /* ignore */ }
  const tickets = [...boardTickets, ...archivedTickets];
  const done = tickets.filter(tk => tk.column === "done" || tk.column === "archived");

  // KPI stats
  const statTotal = document.getElementById("stat-total");
  const statDone  = document.getElementById("stat-done");
  if (statTotal) statTotal.textContent = tickets.length;
  if (statDone)  statDone.textContent  = done.length;

  // Avg cycle time
  const cycleTimes = done
    .filter(tk => tk.created_at && tk.done_at)
    .map(tk => new Date(tk.done_at) - new Date(tk.created_at))
    .filter(d => d > 0);
  const statCycle = document.getElementById("stat-cycle");
  if (statCycle) statCycle.textContent =
    cycleTimes.length > 0 ? formatDuration(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) : "-";

  // Efficiency score (done / total %)
  const costEl = document.getElementById("stat-total-cost");
  if (costEl) {
    costEl.textContent = tickets.length > 0
      ? (done.length / tickets.length * 100).toFixed(1) + "%"
      : "\u2014";
  }

  // Stats badge
  const statsBadge = document.getElementById("stats-badge");
  if (statsBadge) statsBadge.textContent = done.length + "/" + tickets.length;

  renderTypePieChart(tickets);
  renderColumnBarChart(tickets);
  renderWeeklyVelocity(done);
  renderRecentCompleted(done);
}

function renderTypePieChart(tickets) {
  const counts = { feature: 0, bugfix: 0, security: 0, docs: 0 };
  tickets.forEach(tk => { if (counts[tk.ticket_type] !== undefined) counts[tk.ticket_type]++; });
  const total = tickets.length || 1;
  const colors = { feature: "#3B82F6", bugfix: "#f4a460", security: "#e04f5e", docs: "#a855f7" };
  const segments = [];
  let offset = 0;

  for (const [type, count] of Object.entries(counts)) {
    if (count === 0) continue;
    const pct = (count / total) * 100;
    segments.push(`${colors[type]} ${offset}% ${offset + pct}%`);
    offset += pct;
  }

  const pie = document.getElementById("pie-chart");
  if (!pie) return;
  const typeCount = Object.values(counts).filter(c => c > 0).length;
  if (segments.length === 0) {
    pie.style.background = "var(--surface-hover)";
    pie.innerHTML = '';
  } else {
    pie.style.background = `conic-gradient(${segments.join(", ")})`;
    pie.innerHTML = `<div class="pie-center-text"><span class="pie-center-num">${typeCount}</span><span class="pie-center-label">${t('stats.categories')}</span></div>`;
  }
  pie.style.position = "relative";

  const legend = document.getElementById("pie-legend");
  if (!legend) return;
  legend.innerHTML = Object.entries(counts)
    .filter(([_, c]) => c > 0)
    .map(([type, count]) => {
      const pct = Math.round((count / total) * 100);
      return `<div class="legend-item"><span class="legend-dot" style="background:${colors[type]}"></span>${type} <span class="legend-pct">${pct}%</span></div>`;
    }).join("");
}

function renderColumnBarChart(tickets) {
  const cols = ["backlog", "progress", "review", "done"];
  const labels = { backlog: "BACKLOG", progress: "IN PROGRESS", review: "REVIEW", done: "DONE" };
  const counts = {};
  cols.forEach(c => counts[c] = tickets.filter(tk => tk.column === c).length);
  const max = Math.max(...Object.values(counts), 1);
  const colors = { backlog: "var(--accent)", progress: "var(--accent)", review: "var(--tertiary)", done: "var(--tertiary)" };

  const chart = document.getElementById("bar-chart");
  if (!chart) return;
  chart.innerHTML = cols.map(col => `
    <div class="hbar-row">
      <span class="hbar-label">${labels[col]}</span>
      <div class="hbar-track">
        <div class="hbar-fill" style="width: ${(counts[col] / max) * 100}%; background: ${colors[col]}"></div>
      </div>
      <span class="hbar-value">${counts[col]}</span>
    </div>
  `).join("");
}

function renderRecentCompleted(doneTickets) {
  const sorted = doneTickets
    .filter(tk => tk.done_at)
    .sort((a, b) => new Date(b.done_at) - new Date(a.done_at))
    .slice(0, 5);

  const container = document.getElementById("recent-completed");
  if (!container) return;
  if (sorted.length === 0) {
    container.innerHTML = '<span class="empty-state" style="padding:8px 0">' + esc(t('stats.noCompleted')) + '</span>';
    return;
  }

  const typeColors = { feature: "#3B82F6", bugfix: "#f4a460", security: "#e04f5e", docs: "#a855f7" };

  container.innerHTML = sorted.map(ticket => {
    const dur = ticket.created_at && ticket.done_at
      ? formatDuration(new Date(ticket.done_at) - new Date(ticket.created_at))
      : "-";
    const color = typeColors[ticket.ticket_type] || "var(--text-muted)";
    return `<div class="recent-item">
      <span class="recent-check"><span class="material-symbols-outlined">check_circle</span></span>
      <div class="recent-body">
        <div class="card-ticket-id" style="margin-bottom:2px">${esc(ticket.id)}</div>
        <div class="recent-title">${esc(ticket.title)}</div>
        <div class="recent-meta">
          <span class="recent-type-badge" style="background:${color}">${ticket.ticket_type.toUpperCase()}</span>
          <span class="recent-dur">${dur}</span>
        </div>
      </div>
    </div>`;
  }).join("");
}

function renderWeeklyVelocity(doneTickets) {
  const container = document.getElementById("velocity-chart");
  if (!container) return;

  const now = new Date();
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - (i * 7));
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const count = doneTickets.filter(tk => {
      if (!tk.done_at) return false;
      const d = new Date(tk.done_at);
      return d >= weekStart && d < weekEnd;
    }).length;

    // ISO week number
    const temp = new Date(weekStart);
    temp.setHours(0, 0, 0, 0);
    temp.setDate(temp.getDate() + 3 - (temp.getDay() + 6) % 7);
    const week1 = new Date(temp.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(((temp - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    const label = `KW ${weekNum}`;
    weeks.push({ label, count });
  }

  const max = Math.max(...weeks.map(w => w.count), 1);

  container.innerHTML = weeks.map(w => `
    <div class="velocity-bar-group">
      <div class="velocity-bar" style="height: ${(w.count / max) * 100}%">
        ${w.count > 0 ? `<span class="velocity-val">${w.count}</span>` : ""}
      </div>
      <span class="velocity-label">${w.label}</span>
    </div>
  `).join("");
}
