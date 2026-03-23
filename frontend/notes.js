// ── Notes View Module ──
// Unified notes view: lists all notes across board and archived tickets.

import { invoke } from '@tauri-apps/api/core';
import { esc, timeAgo } from './utils.js';
import { state, appendLog, switchView } from './app.js';
import { openDetailPanel } from './detail.js';
import { t } from './i18n.js';

/** Laedt alle Notizen des Projekts und rendert den Notizen-View. */
export async function loadNotesView() {
  const body = document.getElementById("notes-body");
  if (!body) return;
  body.innerHTML = '<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line medium"></div>';

  try {
    const notes = await invoke("get_all_notes");

    // Badge
    const badge = document.getElementById("notes-count");
    if (badge) {
      badge.textContent = notes.length;
      badge.classList.toggle("hidden", notes.length === 0);
    }

    renderNotes(notes);
    setupNotesSearch(notes);
  } catch (err) {
    appendLog("Notes error: " + err, true);
    body.innerHTML = '<p class="empty-state">' + esc(t('common.error')) + '</p>';
  }
}

function renderNotes(notes) {
  const body = document.getElementById("notes-body");
  if (!body) return;

  if (notes.length === 0) {
    body.innerHTML = '<p class="empty-state">' + esc(t('notes.empty')) + '</p>';
    return;
  }

  const NOTE_TRUNCATE = 200;

  body.innerHTML = notes.map((n, i) => {
    const colLabel = columnLabel(n.ticketColumn);
    const needsTruncate = n.text.length > NOTE_TRUNCATE;
    const displayText = needsTruncate ? n.text.slice(0, NOTE_TRUNCATE) + '…' : n.text;
    return `<div class="note-card" data-note-index="${i}">
      <div class="note-card-header note-open-ticket" data-ticket-id="${esc(n.ticketId)}">
        <span class="note-ticket-id">${esc(n.ticketId)}</span>
        <span class="note-ticket-title">${esc(n.ticketTitle)}</span>
        <div class="note-card-badges">
          <span class="badge badge-${esc(n.ticketType)}">${esc(n.ticketType)}</span>
          ${n.ticketColumn === 'archived' ? `<span class="badge badge-archived">${esc(t('nav.archive') || 'Archiv')}</span>` : ''}
          ${colLabel && n.ticketColumn !== 'archived' ? `<span class="badge badge-col">${esc(colLabel)}</span>` : ''}
        </div>
      </div>
      <div class="note-card-body">
        <div class="note-card-text${needsTruncate ? ' note-truncated' : ''}">${esc(displayText)}</div>
        ${needsTruncate ? `<button class="note-show-more" data-full-text="${esc(n.text)}" data-short-text="${esc(displayText)}">${esc(t('notes.showMore') || 'Mehr anzeigen')}</button>` : ''}
      </div>
      <div class="note-card-footer">
        <span class="note-card-date">${timeAgo(n.timestamp)}</span>
      </div>
    </div>`;
  }).join("");

  // Click handlers: open ticket detail
  body.querySelectorAll(".note-open-ticket").forEach(btn => {
    btn.addEventListener("click", async () => {
      const ticketId = btn.dataset.ticketId;
      let ticket = (state.board.tickets || []).find(tk => tk.id === ticketId);
      if (!ticket) {
        try {
          const archived = await invoke("get_archived_tickets");
          ticket = archived.find(tk => tk.id === ticketId);
        } catch (_) { /* ignore */ }
      }
      if (ticket) {
        switchView("board");
        openDetailPanel(ticket);
      }
    });
  });

  // Show more / show less toggle
  body.querySelectorAll(".note-show-more").forEach(btn => {
    btn.addEventListener("click", () => {
      const textEl = btn.previousElementSibling;
      const isExpanded = btn.dataset.expanded === "true";
      if (isExpanded) {
        textEl.textContent = btn.dataset.shortText;
        btn.textContent = t('notes.showMore') || 'Mehr anzeigen';
        btn.dataset.expanded = "false";
        textEl.classList.add("note-truncated");
      } else {
        textEl.textContent = btn.dataset.fullText;
        btn.textContent = t('notes.showLess') || 'Weniger anzeigen';
        btn.dataset.expanded = "true";
        textEl.classList.remove("note-truncated");
      }
    });
  });
}

function setupNotesSearch(allNotes) {
  const searchInput = document.getElementById("notes-search");
  if (!searchInput) return;
  searchInput.oninput = () => {
    const q = searchInput.value.toLowerCase().trim();
    if (!q) {
      renderNotes(allNotes);
      return;
    }
    const filtered = allNotes.filter(n =>
      n.text.toLowerCase().includes(q) ||
      n.ticketId.toLowerCase().includes(q) ||
      n.ticketTitle.toLowerCase().includes(q)
    );
    if (filtered.length === 0) {
      const body = document.getElementById("notes-body");
      if (body) body.innerHTML = '<p class="empty-state">' + esc(t('notes.noResults')) + '</p>';
    } else {
      renderNotes(filtered);
    }
  };
}

function columnLabel(col) {
  switch (col) {
    case 'backlog': return t('board.backlog');
    case 'progress': return t('board.progress');
    case 'review': return t('board.review');
    case 'done': return t('board.done');
    case 'archived': return t('nav.archive') || 'Archiv';
    default: return '';
  }
}
