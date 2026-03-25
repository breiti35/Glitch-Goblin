// ── Activity Module ── Stitch Redesign
// Activity timeline view with Material Icons, source links, badges.

import { invoke } from '@tauri-apps/api/core';
import { esc } from './utils.js';
import { state } from './app.js';
import { t } from './i18n.js';

let activityFilter = "all";
let activityEntries = [];

export async function loadActivityView() {
  const list = document.getElementById("activity-list");
  list.innerHTML = `<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line medium"></div><div class="skeleton skeleton-line short"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line medium"></div>`;

  // Set subtitle
  const subtitle = document.getElementById("activity-subtitle");
  if (subtitle && state.project) {
    subtitle.textContent = t('dashboard.activityStreamSubtitle', {project: state.project.name});
  }

  try {
    activityEntries = await invoke("get_activity", { limit: 200 });
    renderActivityList(activityEntries);
  } catch (e) {
    list.innerHTML = `<p class="empty-state">Error: ${esc(String(e))}</p>`;
  }
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function renderActivityList(entries) {
  const list = document.getElementById("activity-list");
  const filtered = activityFilter === "all"
    ? entries
    : entries.filter(e => e.action === activityFilter);

  if (filtered.length === 0) {
    list.innerHTML = '<p class="empty-state">' + esc(t('dashboard.noActivity')) + '</p>';
    return;
  }

  // Group by date
  const groups = {};
  const now = new Date();
  const today = now.toDateString();
  const yesterday = new Date(now - 86400000).toDateString();
  const weekAgo = new Date(now - 7 * 86400000);

  for (const entry of filtered) {
    const d = new Date(entry.timestamp);
    let label;
    if (d.toDateString() === today) label = t('dashboard.activityToday');
    else if (d.toDateString() === yesterday) label = t('dashboard.activityYesterday');
    else if (d > weekAgo) label = t('dashboard.activityThisWeek');
    else label = t('dashboard.activityOlder');

    if (!groups[label]) groups[label] = [];
    groups[label].push(entry);
  }

  // Material Symbol icon map
  const iconMap = {
    ticket_created: "add", ticket_started: "play_arrow", ticket_completed: "check_circle",
    ticket_merged: "merge", ticket_failed: "warning", ticket_deleted: "delete",
    ticket_moved: "swap_horiz", backup_restored: "restore", settings_changed: "settings",
  };
  const classMap = {
    ticket_created: "created", ticket_started: "started", ticket_completed: "completed",
    ticket_merged: "merged", ticket_failed: "failed", ticket_deleted: "deleted",
    ticket_moved: "moved", backup_restored: "backup_restored", settings_changed: "moved",
  };
  // Source labels
  const sourceMap = {
    ticket_created: "Terminal", ticket_started: "Terminal", ticket_completed: "Kanban Board",
    ticket_merged: "Git", ticket_failed: "Terminal", ticket_deleted: "Bug-Sync",
    ticket_moved: "Kanban Board", backup_restored: "System", settings_changed: "Settings",
  };

  let html = "";
  for (const [label, items] of Object.entries(groups)) {
    html += `<div class="activity-group-label">${label}</div>`;
    for (const e of items) {
      const icon = iconMap[e.action] || "info";
      const cls = classMap[e.action] || "";
      const source = sourceMap[e.action] || "";
      const actionLabel = e.action.replace(/ticket_/g, "").replace(/_/g, " ");
      const title = e.ticket_title ? ` \u2014 ${esc(e.ticket_title)}` : "";
      const detail = e.details ? esc(e.details) : "";
      const ticketId = e.ticket_id ? esc(e.ticket_id) : "";

      // Build description line
      let descParts = [];
      if (detail) descParts.push(detail);
      if (ticketId && !detail) descParts.push(ticketId);
      const descHtml = descParts.join(" \u00B7 ");

      // Badges (ticket ID + prio if available)
      let badgesHtml = "";
      if (e.ticket_id) {
        let badges = `<span class="activity-badge">#${esc(e.ticket_id)}</span>`;
        if (e.ticket_prio) {
          badges += `<span class="activity-badge activity-badge-prio">PRIO:${e.ticket_prio.toUpperCase()}</span>`;
        }
        badgesHtml = `<div class="activity-badges">${badges}</div>`;
      }

      html += `
        <div class="activity-item">
          <div class="activity-icon ${cls}">
            <span class="material-symbols-outlined">${icon}</span>
          </div>
          <div class="activity-body">
            <div class="activity-action">${actionLabel}${title}${source ? ' &mdash; <span class="activity-source">' + source + '</span>' : ''}</div>
            ${descHtml ? `<div class="activity-detail">${descHtml}</div>` : ''}
            ${badgesHtml}
          </div>
          <span class="activity-time">${formatTime(e.timestamp)}</span>
        </div>`;
    }
  }

  list.innerHTML = html;
}

export function setupActivityListeners() {
  document.querySelectorAll(".activity-filter").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".activity-filter").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activityFilter = btn.dataset.activityFilter;
      if (activityEntries.length > 0) {
        renderActivityList(activityEntries);
      } else {
        loadActivityView();
      }
    });
  });
}
