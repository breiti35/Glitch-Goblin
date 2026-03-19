// ── Board Module ──
// Kanban board rendering, cards, drag & drop, filters, context menu.

import { invoke } from '@tauri-apps/api/core';
import { esc, formatDuration } from './utils.js';
import { state, appendLog, showToast, openModal, closeModal, confirmExecute, finishTicket, mergeTicket, refreshBoard } from './app.js';
import { openDetailPanel } from './detail.js';

let contextTicket = null;

// ── Board Rendering ──

const EMPTY_STATES = {
  backlog: "Keine Aufgaben im Backlog",
  progress: "Keine Aufgaben in Bearbeitung",
  review: "Nichts zu reviewen",
  done: "Noch keine Aufgaben erledigt",
};

let renderBoardPending = false;

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

  columns.forEach(col => {
    const body = document.querySelector(`[data-drop="${col}"]`);
    const countEl = document.querySelector(`[data-count="${col}"]`);
    const colTickets = tickets.filter(t => t.column === col);
    countEl.textContent = colTickets.length;
    body.innerHTML = "";

    if (colTickets.length === 0) {
      // Empty state
      const empty = document.createElement("div");
      empty.className = "column-empty-state";
      empty.textContent = EMPTY_STATES[col];
      body.appendChild(empty);
    } else {
      colTickets.forEach(ticket => {
        body.appendChild(createCard(ticket, col));
      });
    }

    // WIP limit check
    const colEl = body.closest(".column");
    const wipLimit = parseInt(colEl?.dataset.wipLimit || "0");
    if (wipLimit > 0) {
      colEl.classList.toggle("wip-exceeded", colTickets.length > wipLimit);
    }

    // WIP progress bar
    const wipBar = document.querySelector(`[data-wip="${col}"]`);
    if (wipBar && wipLimit > 0) {
      const pct = Math.min(100, Math.round((colTickets.length / wipLimit) * 100));
      wipBar.innerHTML = `<div class="wip-fill" style="width:${pct}%"></div>`;
      wipBar.classList.toggle("hidden", false);
    } else if (wipBar) {
      wipBar.classList.add("hidden");
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
    runBadge.textContent = "\u2699 Running: " + state.runningTicket;
    runBadge.classList.remove("hidden");
  } else {
    runBadge.classList.add("hidden");
  }

  updateHealthBar(tickets);
  setupDragDrop();
  applyFilters();
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
  const progTickets = tickets.filter(t => t.column === "progress" && t.started_at);
  const statProgress = document.querySelector('[data-stat="progress"]');
  if (statProgress) {
    if (progTickets.length > 0) {
      const avgAge = progTickets.reduce((sum, t) => sum + (now - new Date(t.started_at)), 0) / progTickets.length;
      statProgress.textContent = "\u00D8 " + formatDuration(avgAge);
    } else {
      statProgress.textContent = "";
    }
  }

  // Review: oldest ticket age
  const revTickets = tickets.filter(t => t.column === "review" && t.review_at);
  const statReview = document.querySelector('[data-stat="review"]');
  if (statReview) {
    if (revTickets.length > 0) {
      const oldest = Math.max(...revTickets.map(t => now - new Date(t.review_at)));
      statReview.textContent = "\u{1F552} " + formatDuration(oldest);
    } else {
      statReview.textContent = "";
    }
  }

  // Done: completion rate
  const statDone = document.querySelector('[data-stat="done"]');
  if (statDone) {
    const total = tickets.length;
    const doneCount = tickets.filter(t => t.column === "done").length;
    statDone.textContent = total > 0 ? Math.round((doneCount / total) * 100) + "%" : "";
  }
}

export function updateHealthBar(tickets) {
  const total = tickets.length || 1;
  const done    = tickets.filter(t => t.column === "done").length;
  const review  = tickets.filter(t => t.column === "review").length;
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

  // Type icon
  const typeIcons  = { feature: "\u{1F537}", bugfix: "\u{1F41B}", security: "\u{1F512}", docs: "\u{1F4C4}" };
  const typeColors = { feature: "#3B82F6", bugfix: "#f4a460", security: "#e04f5e", docs: "#a855f7" };

  // Progress per column
  const colProgress = { backlog: 10, progress: 50, review: 80, done: 100 };

  // Date string
  const dateStr = ticket.created_at
    ? new Date(ticket.created_at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" })
    : "";

  // Action button
  let actionHTML = "";
  if (col === "backlog" && !state.runningTicket) {
    actionHTML = `<button class="card-action start" data-execute="${ticket.id}">\u25B7 Start</button>`;
  } else if (col === "progress") {
    actionHTML = `<button class="card-action finish" data-finish="${ticket.id}">\u2714 Ticket abschlie\u00DFen</button>`;
  } else if (col === "review") {
    actionHTML = `<button class="card-action review-diff" data-review-diff="${ticket.id}">\u{1F50D} \u00C4nderungen anzeigen</button>
      <button class="card-action merge" data-merge="${ticket.id}">Merge</button>`;
  }

  // Extra badges (cost, comments, portal-bug)
  let extraBadgesHTML = "";
  const extraParts = [];
  if (ticket.cost_usd) extraParts.push(`<span class="cost-badge">$${ticket.cost_usd.toFixed(2)}</span>`);
  if (ticket.comments && ticket.comments.length > 0) extraParts.push(`<span class="comment-count-badge">\u{1F4AC} ${ticket.comments.length}</span>`);
  if (ticket.portal_bug_id) extraParts.push(`<span class="badge badge-portal-bug" title="Portal-Bug #${esc(ticket.portal_bug_id)}${ticket.portal_bug_url ? ' - ' + esc(ticket.portal_bug_url) : ''}">\u{1F41B} Portal-Bug</span>`);
  if (extraParts.length > 0) extraBadgesHTML = `<div class="card-badges">${extraParts.join("")}</div>`;

  // Compact: always visible
  // Hover-expand: card-expand section appears on hover
  card.innerHTML = `
    <div class="card-header-row">
      <span class="card-title">${esc(ticket.title)}</span>
      <span class="card-type-icon" style="background:${typeColors[ticket.ticket_type] || '#666'}"
            title="${ticket.ticket_type}">${typeIcons[ticket.ticket_type] || "\u25CF"}</span>
    </div>
    <div class="card-compact-row">
      ${ticket.prio ? `<span class="badge badge-${ticket.prio}">${ticket.prio}</span>` : ""}
      <div class="card-progress-mini">
        <div class="card-progress-fill" style="width:${colProgress[col] || 10}%"></div>
      </div>
    </div>
    <div class="card-expand">
      ${ticket.description ? `<div class="card-desc">${esc(ticket.description)}</div>` : ""}
      <div class="card-info-row">
        <span class="card-date">\u23F0 ${dateStr}</span>
      </div>
      <div class="card-quick-actions">
        <select class="quick-select quick-prio" data-quick="prio" data-ticket-id="${ticket.id}" title="Priorit\u00E4t">
          <option value=""${!ticket.prio ? " selected" : ""}>—</option>
          <option value="high"${ticket.prio === "high" ? " selected" : ""}>high</option>
          <option value="medium"${ticket.prio === "medium" ? " selected" : ""}>med</option>
          <option value="low"${ticket.prio === "low" ? " selected" : ""}>low</option>
        </select>
        <select class="quick-select quick-type" data-quick="type" data-ticket-id="${ticket.id}" title="Typ">
          <option value="feature"${ticket.ticket_type === "feature" ? " selected" : ""}>feature</option>
          <option value="bugfix"${ticket.ticket_type === "bugfix" ? " selected" : ""}>bugfix</option>
          <option value="security"${ticket.ticket_type === "security" ? " selected" : ""}>security</option>
          <option value="docs"${ticket.ticket_type === "docs" ? " selected" : ""}>docs</option>
        </select>
      </div>
      ${extraBadgesHTML}
      ${actionHTML ? `<div class="card-action-row">${actionHTML}</div>` : ""}
    </div>
  `;

  // Click to open detail (not on buttons or selects)
  card.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest("select")) return;
    openDetailPanel(ticket);
  });

  // Quick-action selects
  card.querySelectorAll(".quick-select").forEach(sel => {
    sel.addEventListener("click", (e) => e.stopPropagation());
    sel.addEventListener("change", async (e) => {
      e.stopPropagation();
      const field = sel.dataset.quick;
      const updated = { ...ticket };
      if (field === "prio") updated.prio = sel.value || null;
      if (field === "type") updated.ticket_type = sel.value;
      try {
        await invoke("update_ticket", { ticket: updated });
        state.board = await invoke("get_board");
        renderBoard();
        showToast("Ticket aktualisiert", "success");
      } catch (err) {
        appendLog("Quick-update error: " + err, true);
      }
    });
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

export function showContextMenu(e, ticket) {
  contextTicket = ticket;
  const menu = document.getElementById("context-menu");

  const startItem = menu.querySelector('[data-action="start"]');
  const mergeItem = menu.querySelector('[data-action="merge"]');
  startItem.classList.toggle("hidden", ticket.column !== "backlog" || !!state.runningTicket);
  mergeItem.classList.toggle("hidden", ticket.column !== "review");

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

export function closeContextMenu() {
  document.getElementById("context-menu").classList.add("hidden");
  contextTicket = null;
}

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
    if (confirm(`Delete ticket ${ticket.id} - "${ticket.title}"?`)) {
      try {
        await invoke("delete_ticket", { ticketId: ticket.id });
        state.board = await invoke("get_board");
        renderBoard();
      } catch (err) {
        appendLog("Delete error: " + err, true);
      }
    }
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
    showToast("In Zwischenablage kopiert", "success");
  });
}

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

export async function exportCurrentLog() {
  const ticketId = state.runningTicket || "general";
  await exportLogForTicket(ticketId);
}

// ── Filter ──

export function toggleFilterBar() {
  const bar = document.getElementById("filter-bar");
  bar.classList.toggle("hidden");
  if (!bar.classList.contains("hidden")) {
    document.getElementById("filter-input").focus();
  }
}

export function applyFilters() {
  const text = document.getElementById("filter-input").value.toLowerCase();
  const activeTypes = Array.from(document.querySelectorAll("[data-filter-type].active")).map(b => b.dataset.filterType);
  const activePrios = Array.from(document.querySelectorAll("[data-filter-prio].active")).map(b => b.dataset.filterPrio);

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
    badge.textContent = filteredCount + " hidden";
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

export function clearFilters() {
  document.getElementById("filter-input").value = "";
  document.querySelectorAll(".filter-toggle.active").forEach(b => b.classList.remove("active"));
  applyFilters();
}

// ── Drag & Drop (Event Delegation — listeners registered once) ──

let dragDropInitialized = false;

export function setupDragDrop() {
  if (dragDropInitialized) return;
  dragDropInitialized = true;

  const board = document.getElementById("board");
  if (!board) return;

  // Delegated dragstart/dragend on board container
  board.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".ticket-card");
    if (!card) return;
    e.dataTransfer.setData("text/plain", card.dataset.ticketId);
    card.classList.add("dragging");

    const ghost = card.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.style.position = "absolute";
    ghost.style.top = "-9999px";
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 20, 20);
    requestAnimationFrame(() => ghost.remove());
  });

  board.addEventListener("dragend", (e) => {
    const card = e.target.closest(".ticket-card");
    if (card) card.classList.remove("dragging");
    document.querySelectorAll(".column").forEach(c => c.classList.remove("drag-over"));
    document.querySelectorAll(".drop-indicator").forEach(ind => ind.remove());
  });

  // Column-body listeners (registered once)
  document.querySelectorAll(".column-body").forEach(body => {
    body.addEventListener("dragover", (e) => {
      e.preventDefault();
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
    showToast("Kein Branch f\u00FCr dieses Ticket gefunden", "error");
    return;
  }

  const title = `Review: ${ticket.id} \u2014 ${ticket.title}`;
  document.getElementById("review-title").textContent = title;

  const fileList = document.getElementById("review-file-list");
  const diffPreview = document.getElementById("review-diff-preview");
  fileList.innerHTML = '<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line medium"></div><div class="skeleton skeleton-line short"></div>';
  diffPreview.innerHTML = '<p class="empty-state">Datei anklicken f\u00FCr Diff-Vorschau</p>';

  // Hide confirm button, show only close
  const confirmBtn = document.getElementById("btn-review-confirm");
  const cancelBtn = document.getElementById("btn-review-cancel");
  confirmBtn.textContent = "\u2714 Merge";
  confirmBtn.onclick = () => {
    closeModal("modal-review");
    mergeTicket(ticket.id);
  };
  cancelBtn.textContent = "Schlie\u00DFen";
  cancelBtn.onclick = () => closeModal("modal-review");

  openModal("modal-review");

  try {
    const diff = await invoke("get_branch_diff", { branch: ticket.branch });

    if (diff.files.length === 0) {
      fileList.innerHTML = '<p class="empty-state">Keine \u00C4nderungen gefunden</p>';
    } else {
      fileList.innerHTML = `
        <div class="review-stats">
          <span class="stat-add">+${diff.totalAdditions}</span> / <span class="stat-del">-${diff.totalDeletions}</span>
          \u2014 ${diff.files.length} Dateien ge\u00E4ndert
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
              diffPreview.innerHTML = '<p class="empty-state">(keine Diff-Daten)</p>';
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
