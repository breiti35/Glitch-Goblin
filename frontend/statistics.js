// ── Statistics Module ──
// Charts, metrics, recent completed — Stitch Design.

import { esc, formatDuration } from './utils.js';
import { state } from './app.js';
import { t } from './i18n.js';

export function loadStatistics() {
  const tickets = state.board.tickets || [];
  const done = tickets.filter(t => t.column === "done");

  // KPI stats
  document.getElementById("stat-total").textContent = tickets.length;
  document.getElementById("stat-done").textContent = done.length;

  // Avg cycle time
  const cycleTimes = done
    .filter(t => t.created_at && t.done_at)
    .map(t => new Date(t.done_at) - new Date(t.created_at))
    .filter(d => d > 0);
  document.getElementById("stat-cycle").textContent =
    cycleTimes.length > 0 ? formatDuration(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) : "-";

  // Cost stats
  const ticketsWithCost = tickets.filter(t => t.cost_usd);
  const totalCost = ticketsWithCost.reduce((sum, t) => sum + (t.cost_usd || 0), 0);
  const costEl = document.getElementById("stat-total-cost");
  if (costEl) costEl.textContent = totalCost > 0 ? "$" + totalCost.toFixed(2) : "-";

  // Stats badge
  document.getElementById("stats-badge").textContent = done.length + "/" + tickets.length;

  renderTypePieChart(tickets);
  renderColumnBarChart(tickets);
  renderWeeklyVelocity(done);
  renderRecentCompleted(done);
}

function renderTypePieChart(tickets) {
  const counts = { feature: 0, bugfix: 0, security: 0, docs: 0 };
  tickets.forEach(t => { if (counts[t.ticket_type] !== undefined) counts[t.ticket_type]++; });
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
  if (segments.length === 0) {
    pie.style.background = "var(--border)";
  } else {
    pie.style.background = `conic-gradient(${segments.join(", ")})`;
  }
  // Center hole for donut effect
  pie.style.position = "relative";

  const legend = document.getElementById("pie-legend");
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
  cols.forEach(c => counts[c] = tickets.filter(t => t.column === c).length);
  const max = Math.max(...Object.values(counts), 1);
  const colors = { backlog: "var(--text-muted)", progress: "var(--accent)", review: "var(--info)", done: "var(--success)" };

  const chart = document.getElementById("bar-chart");
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
    .filter(t => t.done_at)
    .sort((a, b) => new Date(b.done_at) - new Date(a.done_at))
    .slice(0, 5);

  const container = document.getElementById("recent-completed");
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
      <span class="recent-check">\u2713</span>
      <div class="recent-body">
        <div class="recent-title">${esc(ticket.id)} ${esc(ticket.title)}</div>
        <div class="recent-meta">
          <span class="recent-type-badge" style="background:${color}">${esc(ticket.ticket_type)}</span>
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

    const count = doneTickets.filter(t => {
      if (!t.done_at) return false;
      const d = new Date(t.done_at);
      return d >= weekStart && d < weekEnd;
    }).length;

    const label = weekStart.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
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
