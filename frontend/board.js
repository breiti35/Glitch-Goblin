// ── Board Module ──
// Kanban board rendering, cards, drag & drop, filters, context menu.

import { invoke } from '@tauri-apps/api/core';
import { esc, formatDuration } from './utils.js';
import { t } from './i18n.js';
import { state, appendLog, showToast, openModal, closeModal, confirmExecute, finishTicket, mergeTicket, refreshBoard, refreshUndoState } from './app.js';
import { openDetailPanel } from './detail.js';

let contextTicket = null;

// ── Board Rendering ──

function emptyStateText(col) {
  const keys = { backlog: 'board.emptyBacklog', progress: 'board.emptyProgress', review: 'board.emptyReview', done: 'board.emptyDone' };
  return t(keys[col] || 'board.emptyBacklog');
}

let renderBoardPending = false;

/** Rendert das Kanban-Board neu. Führt schnell aufeinanderfolgende Aufrufe via requestAnimationFrame zusammen. */
export function renderBoard() {
  // Coalesce rapid consecutive calls via requestAnimationFrame
  if (renderBoardPending) return;
  renderBoardPending = true;
  requestAnimationFrame(() => {
    renderBoardPending = false;
    renderBoardImpl();
  });
}

function renderBoardImpl() {
  const columns = ["backlog", "progress", "review", "done"];
  const tickets = state.board.tickets || [];

  // Set card mode for CSS
  document.body.dataset.cardMode = state.settings.card_expand_mode || "click";

  columns.forEach(col => {
    const body = document.querySelector(`[data-drop="${col}"]`);
    const countEl = document.querySelector(`[data-count="${col}"]`);
    const colTickets = tickets.filter(tk => tk.column === col);
    countEl.textContent = "(" + colTickets.length + ")";
    body.innerHTML = "";

    // Sort tickets by mode
    const sortMode = state.settings.ticket_sort_mode || "priority";
    if (sortMode === "priority") {
      const prioOrder = { high: 0, medium: 1, low: 2 };
      colTickets.sort((a, b) => {
        const pa = prioOrder[a.prio] ?? 3;
        const pb = prioOrder[b.prio] ?? 3;
        if (pa !== pb) return pa - pb;
        return (parseInt(a.id.replace(/\D/g, ""), 10) || 0) - (parseInt(b.id.replace(/\D/g, ""), 10) || 0);
      });
    } else {
      colTickets.sort((a, b) =>
        (parseInt(a.id.replace(/\D/g, ""), 10) || 0) - (parseInt(b.id.replace(/\D/g, ""), 10) || 0)
      );
    }

    if (colTickets.length === 0) {
      // Empty state
      const empty = document.createElement("div");
      empty.className = "column-empty-state";
      empty.textContent = emptyStateText(col);
      body.appendChild(empty);
    } else {
      colTickets.forEach(ticket => {
        body.appendChild(createCard(ticket, col));
      });
    }
  });

  // Column statistics
  updateColumnStats(tickets);

  // Update badge counts
  document.getElementById("ticket-count").textContent = tickets.length;
  document.getElementById("board-title").textContent = state.board.project_name || "Kanban Board";

  // Running badge
  const runBadge = document.getElementById("running-badge");
  if (state.runningTicket) {
    runBadge.textContent = t('board.runningTicket', {id: state.runningTicket});
    runBadge.classList.remove("hidden");
  } else {
    runBadge.classList.add("hidden");
  }

  updateHealthBar(tickets);
  setupDragDrop();
  applyFilters();
  refreshUndoState();
  // Update header username from current project
  const _projName = state.project?.name || "";
  const _usernameEl = document.getElementById("header-username");
  const _avatarEl   = document.getElementById("header-avatar");
  if (_usernameEl) _usernameEl.textContent = _projName || "User";
  if (_avatarEl)   _avatarEl.textContent = (_projName[0] || "U").toUpperCase();
}

function updateColumnStats(tickets) {
  const now = new Date();

  // Backlog: total count (already shown in count badge)
  const statBacklog = document.querySelector('[data-stat="backlog"]');
  if (statBacklog) statBacklog.textContent = "";

  // Progress: average age
  const progTickets = tickets.filter(tk => tk.column === "progress" && tk.started_at);
  const statProgress = document.querySelector('[data-stat="progress"]');
  if (statProgress) {
    if (progTickets.length > 0) {
      const avgAge = progTickets.reduce((sum, tk) => sum + (now - new Date(tk.started_at)), 0) / progTickets.length;
      statProgress.textContent = "\u00D8 " + formatDuration(avgAge);
    } else {
      statProgress.textContent = "";
    }
  }

  // Review: oldest ticket age
  const revTickets = tickets.filter(tk => tk.column === "review" && tk.review_at);
  const statReview = document.querySelector('[data-stat="review"]');
  if (statReview) {
    if (revTickets.length > 0) {
      const oldest = Math.max(...revTickets.map(tk => now - new Date(tk.review_at)));
      statReview.textContent = "\u{1F552} " + formatDuration(oldest);
    } else {
      statReview.textContent = "";
    }
  }

  // Done: completion rate
  const statDone = document.querySelector('[data-stat="done"]');
  if (statDone) {
    const total = tickets.length;
    const doneCount = tickets.filter(tk => tk.column === "done").length;
    statDone.textContent = total > 0 ? Math.round((doneCount / total) * 100) + "%" : "";
  }
}

/** Aktualisiert die farbige Health-Bar basierend auf dem Done- und Review-Anteil aller Tickets.
 * @param {Array} tickets - Alle Tickets des aktuellen Boards.
 */
export function updateHealthBar(tickets) {
  const total = tickets.length || 1;
  const done    = tickets.filter(tk => tk.column === "done").length;
  const review  = tickets.filter(tk => tk.column === "review").length;
  const tealPct   = Math.round((done / total) * 100);
  const yellowPct = Math.round((review / total) * 100);
  const emptyPct  = Math.max(0, 100 - tealPct - yellowPct);
  const tealEl   = document.getElementById("health-teal");
  const yellowEl = document.getElementById("health-yellow");
  const emptyEl  = document.getElementById("health-empty");
  if (tealEl)   tealEl.style.width   = tealPct + "%";
  if (yellowEl) yellowEl.style.width = yellowPct + "%";
  if (emptyEl)  emptyEl.style.width  = emptyPct + "%";
}

function createCard(ticket, col) {
  const card = document.createElement("div");
  card.className = "ticket-card compact";
  card.dataset.ticketId = ticket.id;
  card.dataset.ticketType = ticket.ticket_type;
  card.dataset.ticketPrio = ticket.prio || "";
  card.draggable = true;

  const isRunning = state.runningTicket === ticket.id;
  if (isRunning) card.classList.add("running");

  // Workflow progress per column (0% → 33% → 66% → 100%)
  const colProgress = { backlog: 0, progress: 33, review: 66, done: 100 };

  // Date string
  const dateStr = ticket.created_at
    ? new Date(ticket.created_at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" })
    : "";

  // Action button
  let actionHTML = "";
  if (col === "backlog" && !state.runningTicket) {
    actionHTML = `<button class="card-action start" data-execute="${ticket.id}">\u25B7 ${esc(t('board.start'))}</button>`;
  } else if (col === "progress") {
    actionHTML = `<button class="card-action finish" data-finish="${ticket.id}">\u2714 ${esc(t('board.finishTicket'))}</button>`;
  } else if (col === "review") {
    actionHTML = `<button class="card-action review-diff" data-review-diff="${ticket.id}">\u{1F50D} ${esc(t('board.showChanges'))}</button>
      <button class="card-action merge" data-merge="${ticket.id}">\u2714 ${esc(t('board.merge'))}</button>`;
  }

  // Header right: Typ-Badge + Prio-Badge
  const badgesRight = [];
  if (ticket.ticket_type) badgesRight.push(`<span class="badge badge-${ticket.ticket_type}">${esc(ticket.ticket_type)}</span>`);
  if (ticket.prio) badgesRight.push(`<span class="badge badge-${ticket.prio}">${esc(ticket.prio)}</span>`);
  const badgesRightHTML = badgesRight.length > 0 ? `<div class="card-badges-right">${badgesRight.join("")}</div>` : "";

  // Meta-Zeile: Branch, Kommentare, Kosten, Portal-Bug — nur wenn vorhanden
  const metaParts = [];
  if (ticket.branch) metaParts.push(`<span class="card-branch-badge">${esc(ticket.branch)}</span>`);
  if (ticket.comments && ticket.comments.length > 0) metaParts.push(`<span class="card-comment-count"><span class="material-symbols-outlined" style="font-size:14px">chat_bubble</span> ${ticket.comments.length}</span>`);
  if (ticket.cost_usd) metaParts.push(`<span class="cost-badge">$${ticket.cost_usd.toFixed(2)}</span>`);
  if (state.settings.bug_sync?.enabled && ticket.portal_bug_id) metaParts.push(`<span class="badge badge-portal-bug" title="Portal-Bug #${esc(ticket.portal_bug_id)}${ticket.portal_bug_url ? ' - ' + esc(ticket.portal_bug_url) : ''}">\u{1F41B} Portal-Bug</span>`);
  const metaRowHTML = metaParts.length > 0 ? `<div class="card-meta-row">${metaParts.join("")}</div>` : "";

  // Karten-Layout: ID+Badges oben, Titel, Beschreibung, Meta — Actions im Expand
  card.innerHTML = `
    <div class="card-header-row">
      <span class="card-ticket-id">${esc(ticket.id)}</span>
      ${badgesRightHTML}
    </div>
    <div class="card-title">${esc(ticket.title)}</div>
    ${ticket.description ? `<div class="card-desc">${esc(ticket.description)}</div>` : ""}
    ${metaRowHTML}
    <div class="card-expand">
      ${actionHTML ? `<div class="card-action-row">${actionHTML}</div>` : ""}
    </div>
    <div class="card-workflow-bar"><div class="card-workflow-fill" style="width:${colProgress[col]}%"></div></div>
  `;

  // Card expand mode
  const cardMode = state.settings.card_expand_mode || "click";

  if (cardMode === "always") {
    card.classList.add("expanded");
  } else if (cardMode === "click") {
    card.addEventListener("click", (e) => {
      if (isDragging) return;
      if (e.target.closest("button") || e.target.closest("select") || e.target.closest("a")) return;
      card.classList.toggle("expanded");
    });
  }
  // "hover" mode: CSS handles it via [data-card-mode="hover"]

  // Detail panel via double-click (all modes)
  card.addEventListener("dblclick", (e) => {
    if (e.target.closest("button") || e.target.closest("select")) return;
    openDetailPanel(ticket);
  });

  // Right-click context menu
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e, ticket);
  });

  // Execute button
  const execBtn = card.querySelector("[data-execute]");
  if (execBtn) {
    execBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmExecute(ticket);
    });
  }

  // Finish button
  const finishBtn = card.querySelector("[data-finish]");
  if (finishBtn) {
    finishBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      finishTicket(ticket.id);
    });
  }

  // Review diff button
  const reviewDiffBtn = card.querySelector("[data-review-diff]");
  if (reviewDiffBtn) {
    reviewDiffBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openReviewDiffModal(ticket);
    });
  }

  // Merge button
  const mergeBtn = card.querySelector("[data-merge]");
  if (mergeBtn) {
    mergeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      mergeTicket(ticket.id);
    });
  }

  return card;
}

// ── Context Menu ──

/** Zeigt das Rechtsklick-Kontextmenü für ein Ticket an der Mausposition an.
 * @param {MouseEvent} e - Das contextmenu-Ereignis.
 * @param {object} ticket - Das Ticket, auf dem rechts geklickt wurde.
 */
export function showContextMenu(e, ticket) {
  contextTicket = ticket;
  const menu = document.getElementById("context-menu");

  const startItem = menu.querySelector('[data-action="start"]');
  const mergeItem = menu.querySelector('[data-action="merge"]');
  const archiveItem = menu.querySelector('[data-action="archive"]');
  startItem.classList.toggle("hidden", ticket.column !== "backlog" || !!state.runningTicket);
  mergeItem.classList.toggle("hidden", ticket.column !== "review");
  if (archiveItem) archiveItem.classList.toggle("hidden", ticket.column !== "done");

  // Hide current column in move submenu
  menu.querySelectorAll("[data-move]").forEach(item => {
    item.classList.toggle("hidden", item.dataset.move === ticket.column);
  });

  // Populate project submenu
  const projSub = document.getElementById("ctx-project-submenu");
  projSub.innerHTML = "";
  state.projects
    .filter(p => !state.project || p.name !== state.project.name)
    .forEach(p => {
      const item = document.createElement("div");
      item.className = "ctx-sub-item";
      item.dataset.targetProject = p.name;
      item.textContent = p.name;
      projSub.appendChild(item);
    });

  // Position
  menu.style.left = e.clientX + "px";
  menu.style.top = e.clientY + "px";
  menu.classList.remove("hidden");

  // Ensure menu stays within viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + "px";
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + "px";
  });
}

/** Schließt das Kontextmenü und setzt den gespeicherten Ticket-Verweis zurück. */
export function closeContextMenu() {
  document.getElementById("context-menu").classList.add("hidden");
  contextTicket = null;
}

/** Verarbeitet Klicks auf Menüeinträge des Kontextmenüs (Start, Edit, Merge, Delete, Move, Copy).
 * @param {MouseEvent} e - Das click-Ereignis auf dem Kontextmenü.
 */
export async function handleContextMenuAction(e) {
  const item = e.target.closest("[data-action], [data-move], [data-target-project]");
  if (!item || !contextTicket) return;

  const ticket = contextTicket;
  closeContextMenu();

  if (item.dataset.action === "start") {
    confirmExecute(ticket);
  } else if (item.dataset.action === "edit") {
    openDetailPanel(ticket);
  } else if (item.dataset.action === "merge") {
    mergeTicket(ticket.id);
  } else if (item.dataset.action === "delete") {
    const msg = document.getElementById("git-confirm-message");
    msg.textContent = t('detail.confirmDelete', {id: ticket.id, title: ticket.title});
    document.getElementById("btn-git-confirm-yes").onclick = async () => {
      closeModal("modal-git-confirm");
      try {
        await invoke("delete_ticket", { ticketId: ticket.id });
        state.board = await invoke("get_board");
        renderBoard();
      } catch (err) {
        appendLog("Delete error: " + err, true);
      }
    };
    openModal("modal-git-confirm");
  } else if (item.dataset.action === "archive") {
    archiveTicket(ticket.id);
  } else if (item.dataset.action === "copy") {
    copyTicketToClipboard(ticket);
  } else if (item.dataset.action === "export-log") {
    exportLogForTicket(ticket.id);
  } else if (item.dataset.move) {
    try {
      await invoke("move_ticket", { ticketId: ticket.id, targetColumn: item.dataset.move });
      state.board = await invoke("get_board");
      renderBoard();
    } catch (err) {
      appendLog("Move error: " + err, true);
    }
  } else if (item.dataset.targetProject) {
    try {
      await invoke("move_ticket_to_project", { ticketId: ticket.id, targetProject: item.dataset.targetProject });
      state.board = await invoke("get_board");
      renderBoard();
      appendLog(`Ticket ${ticket.id} moved to project "${item.dataset.targetProject}"`);
    } catch (err) {
      appendLog("Move to project error: " + err, true);
    }
  }
}

function copyTicketToClipboard(ticket) {
  const text = `[${ticket.id}] ${ticket.title}\nType: ${ticket.ticket_type}\nPrio: ${ticket.prio || "none"}\nColumn: ${ticket.column}\n${ticket.description || ""}`;
  navigator.clipboard.writeText(text).then(() => {
    appendLog("Ticket copied to clipboard");
    showToast(t('board.copiedToClipboard'), "success");
  });
}

/** Exportiert den aktuellen Log-Inhalt als Datei für ein bestimmtes Ticket.
 * @param {string} ticketId - ID des Tickets, für das der Log exportiert wird.
 */
export async function exportLogForTicket(ticketId) {
  const logLines = Array.from(document.querySelectorAll("#log-body .log-line"))
    .map(l => l.textContent)
    .join("\n");
  if (!logLines) {
    appendLog("No log content to export");
    return;
  }
  try {
    await invoke("export_log", { ticketId, content: logLines });
    appendLog("Log exported");
  } catch (err) {
    if (err !== "Dialog error") appendLog("Export error: " + err, true);
  }
}

/** Exportiert den Log des aktuell laufenden Tickets (oder "general" wenn kein Ticket läuft). */
export async function exportCurrentLog() {
  const ticketId = state.runningTicket || "general";
  await exportLogForTicket(ticketId);
}

// ── Filter ──

/** Schaltet die Filter-Leiste ein/aus und setzt bei Öffnung den Fokus auf das Eingabefeld. */
export function toggleFilterBar() {
  const bar = document.getElementById("filter-bar");
  bar.classList.toggle("hidden");
  if (!bar.classList.contains("hidden")) {
    document.getElementById("filter-input").focus();
  }
}

/** Filtert Board-Karten nach Text, Ticket-Typ und Priorität. Aktualisiert den Filter-Badge. */
export function applyFilters() {
  const text = document.getElementById("filter-input").value.toLowerCase();
  const activeTypes = Array.from(document.querySelectorAll("[data-filter-type].active")).map(b => b.dataset.filterType);
  const activePrios = Array.from(document.querySelectorAll("[data-filter-prio].active")).map(b => b.dataset.filterPrio);

  // Persist filter state to localStorage
  try {
    localStorage.setItem("gg-filter-state", JSON.stringify({ text, types: activeTypes, prios: activePrios }));
  } catch (_) { /* quota exceeded or private mode — ignore */ }

  let filteredCount = 0;
  document.querySelectorAll(".ticket-card").forEach(card => {
    const title = card.querySelector(".card-title")?.textContent.toLowerCase() || "";
    const desc = card.querySelector(".card-desc")?.textContent.toLowerCase() || "";
    const type = card.dataset.ticketType;
    const prio = card.dataset.ticketPrio;

    let show = true;
    if (text && !title.includes(text) && !desc.includes(text)) show = false;
    if (activeTypes.length > 0 && !activeTypes.includes(type)) show = false;
    if (activePrios.length > 0 && !activePrios.includes(prio)) show = false;

    card.classList.toggle("filtered-out", !show);
    if (!show) filteredCount++;
  });

  const badge = document.getElementById("filter-badge");
  if (filteredCount > 0) {
    badge.textContent = filteredCount + " " + t('board.hidden');
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

/** Stellt den gespeicherten Filter-State aus localStorage wieder her (DOM-Elemente setzen). */
export function restoreFilters() {
  try {
    const raw = localStorage.getItem("gg-filter-state");
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.text) {
      document.getElementById("filter-input").value = saved.text;
    }
    if (saved.types && saved.types.length > 0) {
      document.querySelectorAll("[data-filter-type]").forEach(btn => {
        btn.classList.toggle("active", saved.types.includes(btn.dataset.filterType));
      });
    }
    if (saved.prios && saved.prios.length > 0) {
      document.querySelectorAll("[data-filter-prio]").forEach(btn => {
        btn.classList.toggle("active", saved.prios.includes(btn.dataset.filterPrio));
      });
    }
    // Show filter bar if any filter is active
    if (saved.text || (saved.types && saved.types.length > 0) || (saved.prios && saved.prios.length > 0)) {
      document.getElementById("filter-bar").classList.remove("hidden");
    }
  } catch (_) { /* corrupt data — ignore */ }
}

/** Setzt alle aktiven Filter (Text, Typ, Priorität) zurück und aktualisiert die Karten-Anzeige. */
export function clearFilters() {
  document.getElementById("filter-input").value = "";
  document.querySelectorAll(".filter-toggle.active").forEach(b => b.classList.remove("active"));
  try { localStorage.removeItem("gg-filter-state"); } catch (_) { /* ignore */ }
  applyFilters();
}

// ── Drag & Drop (Event Delegation -- listeners registered once) ──

let dragDropInitialized = false;
let dragDropped = false;
let isDragging = false;

/** Registriert Drag-&-Drop-Event-Listener am Board-Container (wird nur beim ersten Aufruf ausgeführt). */
export function setupDragDrop() {
  if (dragDropInitialized) return;
  dragDropInitialized = true;

  const board = document.getElementById("board");
  if (!board) return;

  // Delegated dragstart/dragend on board container
  board.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".ticket-card");
    if (!card) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.ticketId);
    card.classList.add("dragging");
    isDragging = true;
    dragDropped = false;

    // Save expanded state, collapse for cleaner drag visual
    card.dataset.wasExpanded = card.classList.contains("expanded") ? "1" : "";
    card.classList.remove("expanded");

    const ghost = card.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.style.position = "absolute";
    ghost.style.top = "-9999px";
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 20, 20);
    setTimeout(() => ghost.remove(), 100);
  });

  board.addEventListener("dragend", (e) => {
    const card = e.target.closest(".ticket-card");
    if (card) {
      card.classList.remove("dragging");
      // Restore expanded state if drag was cancelled (no successful drop)
      if (!dragDropped && card.dataset.wasExpanded === "1") {
        card.classList.add("expanded");
      }
      delete card.dataset.wasExpanded;
    }
    dragDropped = false;
    // Clear isDragging after pending click events
    setTimeout(() => { isDragging = false; }, 0);
    document.querySelectorAll(".column").forEach(c => c.classList.remove("drag-over"));
    document.querySelectorAll(".drop-indicator").forEach(ind => ind.remove());
  });

  // Column-body listeners (registered once)
  document.querySelectorAll(".column-body").forEach(body => {
    body.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      body.closest(".column").classList.add("drag-over");

      const afterElement = getDragAfterElement(body, e.clientY);
      let indicator = body.querySelector(".drop-indicator");
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.className = "drop-indicator";
      }
      if (afterElement) {
        body.insertBefore(indicator, afterElement);
      } else {
        body.appendChild(indicator);
      }
    });
    body.addEventListener("dragleave", (e) => {
      if (!body.contains(e.relatedTarget)) {
        body.closest(".column").classList.remove("drag-over");
        body.querySelector(".drop-indicator")?.remove();
      }
    });
    body.addEventListener("drop", async (e) => {
      e.preventDefault();
      dragDropped = true;
      body.closest(".column").classList.remove("drag-over");
      body.querySelector(".drop-indicator")?.remove();
      const ticketId = e.dataTransfer.getData("text/plain");
      const targetColumn = body.dataset.drop;

      try {
        await invoke("move_ticket", { ticketId, targetColumn });
        state.board = await invoke("get_board");
        renderBoard();
      } catch (err) {
        appendLog("Error: " + err, true);
      }
    });
  });
}

// ── Review Diff Modal (for Review column tickets) ──

async function openReviewDiffModal(ticket) {
  if (!ticket.branch) {
    showToast(t('board.noBranch'), "error");
    return;
  }

  const title = `Review: ${ticket.id} \u2014 ${ticket.title}`;
  document.getElementById("review-title").textContent = title;

  const fileList = document.getElementById("review-file-list");
  const diffPreview = document.getElementById("review-diff-preview");
  fileList.innerHTML = '<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line medium"></div><div class="skeleton skeleton-line short"></div>';
  diffPreview.innerHTML = '<p class="empty-state">' + esc(t('board.clickFileForDiff')) + '</p>';

  // Hide confirm button, show only close
  const confirmBtn = document.getElementById("btn-review-confirm");
  const cancelBtn = document.getElementById("btn-review-cancel");
  confirmBtn.textContent = "\u2714 " + t('board.merge');
  confirmBtn.onclick = () => {
    closeModal("modal-review");
    mergeTicket(ticket.id);
  };
  cancelBtn.textContent = t('board.close');
  cancelBtn.onclick = () => closeModal("modal-review");

  openModal("modal-review");

  try {
    const diff = await invoke("get_branch_diff", { branch: ticket.branch });

    if (diff.files.length === 0) {
      fileList.innerHTML = '<p class="empty-state">' + esc(t('board.noChanges')) + '</p>';
    } else {
      fileList.innerHTML = `
        <div class="review-stats">
          <span class="stat-add">+${diff.totalAdditions}</span> / <span class="stat-del">-${diff.totalDeletions}</span>
          \u2014 ${esc(t('board.filesChanged', {count: diff.files.length}))}
        </div>
      ` + diff.files.map(f => `
        <div class="review-file-item" data-file="${esc(f.filePath)}" data-branch="${esc(ticket.branch)}">
          <span class="file-status ${esc(f.status)}">${esc(f.status)}</span>
          <span class="file-path">${esc(f.filePath)}</span>
          <span class="file-changes">
            <span class="stat-add">+${f.additions}</span>
            <span class="stat-del">-${f.deletions}</span>
          </span>
        </div>
      `).join("");

      fileList.querySelectorAll(".review-file-item").forEach(el => {
        el.addEventListener("click", async () => {
          fileList.querySelectorAll(".review-file-item").forEach(i => i.classList.remove("active"));
          el.classList.add("active");
          diffPreview.innerHTML = "Loading...";
          try {
            const fileDiff = await invoke("get_file_diff", { branch: el.dataset.branch, filePath: el.dataset.file });
            if (!fileDiff.trim()) {
              diffPreview.innerHTML = '<p class="empty-state">' + esc(t('board.noDiffData')) + '</p>';
            } else {
              diffPreview.innerHTML = `<pre class="review-diff-body">${renderReviewDiffLines(fileDiff)}</pre>`;
            }
          } catch (e) {
            diffPreview.innerHTML = `<p class="empty-state">Error: ${esc(String(e))}</p>`;
          }
        });
      });
    }
  } catch (e) {
    fileList.innerHTML = `<p class="empty-state">Error: ${esc(String(e))}</p>`;
  }
}

function renderReviewDiffLines(diff) {
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

function getDragAfterElement(container, y) {
  const cards = [...container.querySelectorAll(".ticket-card:not(.dragging)")];
  return cards.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ── Archive ──

function archiveTicket(ticketId) {
  const ticket = state.board.tickets.find(tk => tk.id === ticketId);
  const msg = document.getElementById("git-confirm-message");
  msg.textContent = t('board.confirmArchive', {id: ticketId}) || `Ticket ${ticketId} archivieren?`;
  document.getElementById("btn-git-confirm-yes").onclick = async () => {
    closeModal("modal-git-confirm");
    try {
      await invoke("archive_ticket", { ticketId });
      state.board = await invoke("get_board");
      renderBoard();
      showToast(t('board.ticketArchived') || "Ticket archiviert", "success");
    } catch (err) {
      appendLog("Archive error: " + err, true);
    }
  };
  openModal("modal-git-confirm");
}

export async function loadArchiveView() {
  const body = document.getElementById("archive-body");
  if (!body) return;
  body.innerHTML = '<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line medium"></div>';

  try {
    const tickets = await invoke("get_archived_tickets");
    const badge = document.getElementById("archive-count");
    if (badge) {
      badge.textContent = tickets.length;
      badge.classList.toggle("hidden", tickets.length === 0);
    }

    if (tickets.length === 0) {
      body.innerHTML = '<p class="empty-state">' + esc(t('archive.empty') || 'Keine archivierten Tickets') + '</p>';
      return;
    }

    body.innerHTML = `<table class="archive-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Titel</th>
          <th>Typ</th>
          <th>Erledigt</th>
          <th>Archiviert</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${tickets.map(tk => `<tr data-ticket-id="${esc(tk.id)}">
          <td class="archive-id">${esc(tk.id)}</td>
          <td>${esc(tk.title)}</td>
          <td><span class="badge badge-${esc(tk.ticket_type)}">${esc(tk.ticket_type)}</span></td>
          <td>${tk.done_at ? new Date(tk.done_at).toLocaleDateString("de-DE") : '–'}</td>
          <td>${tk.archived_at ? new Date(tk.archived_at).toLocaleDateString("de-DE") : '–'}</td>
          <td><button class="btn-unarchive" data-unarchive="${esc(tk.id)}" title="Wiederherstellen"><span class="material-symbols-outlined" style="font-size:18px">unarchive</span></button></td>
        </tr>`).join("")}
      </tbody>
    </table>`;

    // Unarchive click handlers
    body.querySelectorAll("[data-unarchive]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await invoke("unarchive_ticket", { ticketId: btn.dataset.unarchive });
          state.board = await invoke("get_board");
          renderBoard();
          loadArchiveView();
          showToast(t('board.ticketUnarchived') || "Ticket wiederhergestellt", "success");
        } catch (err) {
          appendLog("Unarchive error: " + err, true);
        }
      });
    });

    // Search filter
    const searchInput = document.getElementById("archive-search");
    if (searchInput) {
      searchInput.oninput = () => {
        const q = searchInput.value.toLowerCase();
        body.querySelectorAll("tbody tr").forEach(row => {
          const text = row.textContent.toLowerCase();
          row.style.display = text.includes(q) ? "" : "none";
        });
      };
    }
  } catch (err) {
    body.innerHTML = `<p class="empty-state">Fehler: ${esc(String(err))}</p>`;
  }
}
