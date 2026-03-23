// ── Detail Panel Module ──
// Ticket detail panel, timeline, comments.

import { invoke } from '@tauri-apps/api/core';
import { esc, formatDuration, formatTimeShort, timeAgo } from './utils.js';
import { state, appendLog } from './app.js';
import { renderBoard } from './board.js';
import { t } from './i18n.js';

// ── Detail Panel ──

export function openDetailPanel(ticket) {
  state.detailTicket = ticket;

  document.getElementById("detail-title").textContent = ticket.id;
  document.getElementById("detail-edit-title").value = ticket.title;
  document.getElementById("detail-edit-type").value = ticket.ticket_type;
  document.getElementById("detail-edit-prio").value = ticket.prio || "";
  document.getElementById("detail-edit-desc").value = ticket.description || "";
  document.getElementById("detail-id").textContent = ticket.id;
  document.getElementById("detail-column").textContent = ticket.column;
  document.getElementById("detail-branch").textContent = ticket.branch || "\u2014";

  // Cost info
  const costInfo = document.getElementById("detail-cost-info");
  if (ticket.tokens_used || ticket.cost_usd || ticket.model_used) {
    costInfo.classList.remove("hidden");
    document.getElementById("detail-model").textContent = ticket.model_used || "-";
    document.getElementById("detail-tokens").textContent = ticket.tokens_used ? ticket.tokens_used.toLocaleString() : "-";
    document.getElementById("detail-cost").textContent = ticket.cost_usd ? "$" + ticket.cost_usd.toFixed(4) : "-";
  } else {
    costInfo.classList.add("hidden");
  }

  // Portal Bug info (only when bug_sync is enabled)
  const portalInfo = document.getElementById("detail-portal-info");
  if (portalInfo) {
    if (state.settings.bug_sync?.enabled && ticket.portal_bug_id) {
      portalInfo.classList.remove("hidden");
      document.getElementById("detail-portal-id").textContent = "#" + ticket.portal_bug_id;
      const urlEl = document.getElementById("detail-portal-url");
      const rawUrl = ticket.portal_bug_url || "";
      const safeUrl = /^https?:\/\//.test(rawUrl) ? rawUrl : "";
      urlEl.textContent = safeUrl || "-";
      urlEl.href = safeUrl || "#";
    } else {
      portalInfo.classList.add("hidden");
    }
  }

  // Render timeline
  renderTimeline(ticket);

  // Render comments
  renderComments(ticket);

  document.getElementById("panel-detail").classList.remove("hidden");
}

export function closeDetailPanel() {
  document.getElementById("panel-detail").classList.add("hidden");
  state.detailTicket = null;
}

// ── Timeline ──

export function renderTimeline(ticket) {
  const container = document.getElementById("detail-timeline");
  const entries = [];

  if (ticket.created_at) {
    entries.push({ icon: "\u2795", label: "Created", time: ticket.created_at });
  }
  if (ticket.started_at) {
    entries.push({ icon: "\u25B6", label: "Started", time: ticket.started_at });
    if (ticket.created_at) {
      const dur = new Date(ticket.started_at) - new Date(ticket.created_at);
      entries[entries.length - 1].duration = formatDuration(dur);
    }
  }
  if (ticket.review_at) {
    entries.push({ icon: "\u2714", label: "Review", time: ticket.review_at });
    if (ticket.started_at) {
      const dur = new Date(ticket.review_at) - new Date(ticket.started_at);
      entries[entries.length - 1].duration = formatDuration(dur);
    }
  }
  if (ticket.done_at) {
    entries.push({ icon: "\u2605", label: "Done", time: ticket.done_at });
    if (ticket.review_at) {
      const dur = new Date(ticket.done_at) - new Date(ticket.review_at);
      entries[entries.length - 1].duration = formatDuration(dur);
    }
  }

  if (entries.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `<div class="timeline-title">${esc(t('detail.timeline'))}</div>` +
    entries.map(e => `
      <div class="timeline-entry">
        <span class="timeline-icon">${e.icon}</span>
        <span class="timeline-label">${e.label}</span>
        <span class="timeline-time">${formatTimeShort(e.time)}</span>
        ${e.duration ? `<span class="timeline-duration">(${e.duration})</span>` : ""}
      </div>
    `).join("");
}

// ── Save & Delete ──

export async function saveDetailTicket() {
  if (!state.detailTicket) return;

  const updated = {
    ...state.detailTicket,
    title: document.getElementById("detail-edit-title").value.trim(),
    ticket_type: document.getElementById("detail-edit-type").value,
    prio: document.getElementById("detail-edit-prio").value || null,
    description: document.getElementById("detail-edit-desc").value.trim(),
  };

  try {
    await invoke("update_ticket", { ticket: updated });
    state.board = await invoke("get_board");
    renderBoard();
    closeDetailPanel();
  } catch (err) {
    appendLog("Update error: " + err, true);
  }
}

export async function deleteDetailTicket() {
  if (!state.detailTicket) return;
  const id = state.detailTicket.id;

  try {
    await invoke("delete_ticket", { ticketId: id });
    state.board = await invoke("get_board");
    renderBoard();
    closeDetailPanel();
  } catch (err) {
    appendLog("Delete error: " + err, true);
  }
}

// ── Comments ──

export function renderComments(ticket) {
  const list = document.getElementById("detail-comments-list");
  const comments = ticket.comments || [];

  if (comments.length === 0) {
    list.innerHTML = '<p class="empty-state" style="font-size:12px;margin:4px 0">' + esc(t('detail.noComments')) + '</p>';
    return;
  }

  list.innerHTML = comments.map((c, i) => `
    <div class="comment-item">
      <div class="comment-header">
        <span>${timeAgo(c.timestamp)}</span>
        <span class="comment-delete" data-comment-index="${i}" data-ticket-id="${esc(ticket.id)}">&times;</span>
      </div>
      <div>${esc(c.text)}</div>
    </div>
  `).join("");

  list.querySelectorAll(".comment-delete").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        await invoke("delete_comment", {
          ticketId: btn.dataset.ticketId,
          commentIndex: parseInt(btn.dataset.commentIndex),
        });
        state.board = await invoke("get_board");
        const updated = state.board.tickets.find(t => t.id === btn.dataset.ticketId);
        if (updated) renderComments(updated);
      } catch (e) {
        appendLog("Delete comment error: " + e, true);
      }
    });
  });
}

export function setupCommentListeners() {
  document.getElementById("btn-add-comment")?.addEventListener("click", async () => {
    const input = document.getElementById("detail-comment-input");
    const text = input.value.trim();
    if (!text || !state.detailTicket) return;

    try {
      await invoke("add_comment", { ticketId: state.detailTicket.id, text });
      input.value = "";
      state.board = await invoke("get_board");
      const updated = state.board.tickets.find(t => t.id === state.detailTicket.id);
      if (updated) {
        state.detailTicket = updated;
        renderComments(updated);
        renderBoard();
      }
    } catch (e) {
      appendLog("Add comment error: " + e, true);
    }
  });
}
