// ── Activity Module ──
// Activity timeline view.

import { invoke } from '@tauri-apps/api/core';
import { esc, timeAgo } from './utils.js';

let activityFilter = "all";

export async function loadActivityView() {
  const list = document.getElementById("activity-list");
  list.innerHTML = `<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line medium"></div><div class="skeleton skeleton-line short"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line medium"></div>`;

  try {
    const entries = await invoke("get_activity", { limit: 200 });
    renderActivityList(entries);
  } catch (e) {
    list.innerHTML = `<p class="empty-state">Error: ${esc(String(e))}</p>`;
  }
}

function renderActivityList(entries) {
  const list = document.getElementById("activity-list");
  const filtered = activityFilter === "all"
    ? entries
    : entries.filter(e => e.action === activityFilter);

  if (filtered.length === 0) {
    list.innerHTML = '<p class="empty-state">No activity found</p>';
    return;
  }

  // Group by date
  const groups = {};
  const now = new Date();
  const today = now.toDateString();
  const weekAgo = new Date(now - 7 * 86400000);

  for (const entry of filtered) {
    const d = new Date(entry.timestamp);
    let label;
    if (d.toDateString() === today) label = "Today";
    else if (d > weekAgo) label = "This Week";
    else label = "Older";

    if (!groups[label]) groups[label] = [];
    groups[label].push(entry);
  }

  const iconMap = {
    ticket_created: "+", ticket_started: "&#9655;", ticket_completed: "&#10003;",
    ticket_merged: "&#8644;", ticket_failed: "&#10007;", ticket_deleted: "&#128465;",
    ticket_moved: "&#8596;", backup_restored: "&#8635;", settings_changed: "&#9881;",
  };
  const classMap = {
    ticket_created: "created", ticket_started: "started", ticket_completed: "completed",
    ticket_merged: "merged", ticket_failed: "failed", ticket_deleted: "deleted",
    ticket_moved: "moved", backup_restored: "backup_restored", settings_changed: "moved",
  };

  let html = "";
  for (const [label, items] of Object.entries(groups)) {
    html += `<div class="activity-group-label">${label}</div>`;
    for (const e of items) {
      const icon = iconMap[e.action] || "&#9679;";
      const cls = classMap[e.action] || "";
      const title = e.ticket_title ? ` \u2014 ${esc(e.ticket_title)}` : "";
      const detail = e.details ? esc(e.details) : "";
      const ticketId = e.ticket_id ? esc(e.ticket_id) : "";
      html += `
        <div class="activity-item">
          <span class="activity-icon ${cls}">${icon}</span>
          <div class="activity-body">
            <span class="activity-action">${esc(e.action.replace(/_/g, " "))}${title}</span>
            <div class="activity-detail">${ticketId}${detail ? " \u00B7 " + detail : ""}</div>
          </div>
          <span class="activity-time">${timeAgo(e.timestamp)}</span>
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
      loadActivityView();
    });
  });
}
