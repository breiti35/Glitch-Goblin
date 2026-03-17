// ── Tauri IPC ──
const { invoke, Channel } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ── Sound Data URIs (Block C3) ──
const SOUNDS = {
  // Short ascending chime (~2KB)
  success: "data:audio/wav;base64,UklGRlQBAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YTABAAAAAAAlAEoAbACLAKgAwgDYAOoA9wAAAAUABQAAAAMA/v/2/+3/4f/V/8j/vP+x/6f/n/+Z/5X/lP+V/5r/ov+t/7r/yv/c//D/AAARACoAPABPAGIAdQCHAJYApACvALcAvAC+AL0AuACvAKIAkgB+AGQASABIAC8AEgD0/9T/sv+R/3D/UP8z/xj/AP/s/tz+0P7I/sT+xf7K/tP+4f7z/gj/IP88/1r/ev+d/8H/5v8LAC8AVABxAKAAuwDWAOoA+gAFAQoBC",
  // Short low tone (~2KB)
  error: "data:audio/wav;base64,UklGRlQBAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YTABAAAAAPj/4f/E/6P/gf9g/0D/JP8N//z+8f7u/vH+/P4O/yb/Rf9p/5L/vf/r/xoASAB1AKAA1QAAASkBSgFkAXUBfgF+AXUBZAFKAV8BKAHyALcAdwA1APIE1v+k/3D/Qf8V//D+0P60/p/+j/6F/oL+hf6O/p3+sv7M/uz+EP84/2P/kP/A//D/IgBTAIIArwDaAAAAJAFCAVoBawF2AXkBdAFoAVQBOAEWAe0AvgCKAFIAFwDZ/5b/"
};

// ── Local State ──
const state = {
  board: { project_name: "", tickets: [] },
  project: null,
  projects: [],
  settings: {},
  runningTicket: null,
  detailTicket: null,
  progressLines: {},
  filters: { text: "", types: [], prios: [] },
  editingAgent: null,
  editingCommand: null,
  // Terminal
  terminals: {},
  activeTerminal: null,
  terminalCounter: 0,
  // Deploy
  deployConfig: null,
  deployingLocal: false,
  deployingLive: false,
};

let contextTicket = null;

// ── Init ──
document.addEventListener("DOMContentLoaded", async () => {
  await loadInitialState();
  bindEvents();
  bindKeyboardShortcuts();
  await setupListeners();
  setupTerminalListeners();
  setupGitListeners();
  setupActivityListeners();
  setupCommentListeners();
  setupModelPresetListener();
  setupTemplateListener();
  setupImportExportListeners();
  setupDeployListeners();
  loadDeployConfig();
  renderBoard();
  updateSidebar();
  checkGitStatus();
});

async function loadInitialState() {
  try {
    state.board = await invoke("get_board");
    state.project = await invoke("get_current_project");
    state.projects = await invoke("get_projects");
    state.settings = await invoke("get_settings");
    state.runningTicket = await invoke("get_running_ticket");

    // Apply theme from settings
    if (state.settings.theme) {
      document.body.dataset.theme = state.settings.theme;
      updateThemeUI();
    }

    // Apply accent color
    applyAccentColor(state.settings.accent_color || state.settings.accentColor);

    // Request notification permission
    if (state.settings.notifications_enabled !== false) {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    }
  } catch (e) {
    console.error("Failed to load initial state:", e);
  }
}

// ── Event Bindings ──
function bindEvents() {
  // Navigation
  document.querySelectorAll(".nav-item[data-view]").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // Theme toggle
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  document.getElementById("btn-app-settings").addEventListener("click", () => switchView("settings"));

  // Project selector
  document.getElementById("project-selector").addEventListener("click", openProjectPicker);

  // New task
  document.getElementById("btn-new-task").addEventListener("click", openNewTaskModal);
  document.getElementById("btn-create-task").addEventListener("click", createTask);
  document.getElementById("btn-cancel-task").addEventListener("click", () => closeModal("modal-new-task"));

  // Confirm modal
  document.getElementById("btn-confirm-no").addEventListener("click", () => closeModal("modal-confirm"));

  // Picker modal
  document.querySelector("#modal-picker .modal-close").addEventListener("click", () => closeModal("modal-picker"));
  document.querySelector("#modal-picker .modal-backdrop").addEventListener("click", () => closeModal("modal-picker"));
  document.getElementById("btn-add-project").addEventListener("click", addProjectFlow);

  // New task modal
  document.querySelector("#modal-new-task .modal-close").addEventListener("click", () => closeModal("modal-new-task"));
  document.querySelector("#modal-new-task .modal-backdrop").addEventListener("click", () => closeModal("modal-new-task"));

  // Confirm modal backdrop
  document.querySelector("#modal-confirm .modal-backdrop").addEventListener("click", () => closeModal("modal-confirm"));

  // Backup modal
  document.querySelector("#modal-backup .modal-close").addEventListener("click", () => closeModal("modal-backup"));
  document.querySelector("#modal-backup .modal-backdrop").addEventListener("click", () => closeModal("modal-backup"));

  // Shortcut help modal
  document.querySelector("#shortcut-help .modal-close").addEventListener("click", () => closeModal("shortcut-help"));
  document.querySelector("#shortcut-help .modal-backdrop").addEventListener("click", () => closeModal("shortcut-help"));

  // Detail panel
  document.getElementById("panel-close").addEventListener("click", closeDetailPanel);
  document.getElementById("btn-detail-save").addEventListener("click", saveDetailTicket);
  document.getElementById("btn-detail-delete").addEventListener("click", deleteDetailTicket);

  // Log clear + export
  document.getElementById("log-clear").addEventListener("click", () => {
    document.getElementById("log-body").innerHTML = "";
  });
  document.getElementById("log-export").addEventListener("click", exportCurrentLog);

  // Settings
  document.getElementById("btn-save-settings").addEventListener("click", saveSettingsForm);
  document.getElementById("set-accent-color").addEventListener("input", (e) => {
    document.getElementById("accent-color-label").textContent = e.target.value;
  });
  document.getElementById("set-max-backups").addEventListener("input", (e) => {
    document.getElementById("max-backups-label").textContent = e.target.value;
  });
  document.getElementById("btn-open-backups").addEventListener("click", openBackupModal);

  // Filter bar
  document.getElementById("btn-filter-toggle").addEventListener("click", toggleFilterBar);
  document.getElementById("filter-input").addEventListener("input", applyFilters);
  document.getElementById("filter-clear").addEventListener("click", clearFilters);
  document.querySelectorAll("[data-filter-type]").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      applyFilters();
    });
  });
  document.querySelectorAll("[data-filter-prio]").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      applyFilters();
    });
  });

  // Context menu - close on click outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#context-menu")) closeContextMenu();
  });
  // Context menu actions
  document.getElementById("context-menu").addEventListener("click", handleContextMenuAction);

  // Agent editor
  document.getElementById("btn-new-agent").addEventListener("click", newAgentFlow);
  document.getElementById("btn-save-agent").addEventListener("click", saveAgentEditor);
  document.getElementById("btn-delete-agent").addEventListener("click", deleteAgentEditor);

  // Command editor
  document.getElementById("btn-new-command").addEventListener("click", newCommandFlow);
  document.getElementById("btn-save-command").addEventListener("click", saveCommandEditor);
  document.getElementById("btn-delete-command").addEventListener("click", deleteCommandEditor);
}

// ── Keyboard Shortcuts (Block C1) ──
function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Guard: skip if typing in input/textarea/select
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (e.key === "Escape") {
        e.target.blur();
        closeAllModals();
      }
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case "n":
          e.preventDefault();
          openNewTaskModal();
          break;
        case "f":
          e.preventDefault();
          toggleFilterBar();
          break;
        case "p":
          e.preventDefault();
          openProjectPicker();
          break;
        case ",":
          e.preventDefault();
          switchView("settings");
          break;
        case "l":
          e.preventDefault();
          toggleLogPanel();
          break;
        case "`":
          e.preventDefault();
          toggleTerminalView();
          break;
      }
      return;
    }

    if (e.key === "Escape") {
      closeAllModals();
    } else if (e.key === "?") {
      toggleModal("shortcut-help");
    }
  });
}

function toggleLogPanel() {
  const log = document.getElementById("log-panel");
  if (log.style.height === "0px") {
    log.style.height = "";
  } else {
    log.style.height = "0px";
    log.style.minHeight = "0";
  }
}

function closeAllModals() {
  document.querySelectorAll(".modal:not(.hidden)").forEach(m => m.classList.add("hidden"));
  closeDetailPanel();
  closeContextMenu();
  const filterBar = document.getElementById("filter-bar");
  if (!filterBar.classList.contains("hidden")) filterBar.classList.add("hidden");
}

function toggleModal(id) {
  const el = document.getElementById(id);
  el.classList.toggle("hidden");
}

// ── Tauri Event Listeners ──
async function setupListeners() {
  await listen("board-changed", (event) => {
    state.board = event.payload;
    renderBoard();
    updateSidebar();
  });

  // Terminal output
  await listen("terminal-output", (event) => {
    const { terminalId, data } = event.payload;
    const inst = state.terminals[terminalId];
    if (inst) inst.term.write(data);
  });

  // Terminal closed by shell exit
  await listen("terminal-closed", (event) => {
    const { terminalId } = event.payload;
    cleanupTerminal(terminalId);
  });
}

// ── View Routing ──
function switchView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.add("active");

  document.querySelectorAll(".nav-item[data-view]").forEach(b => b.classList.remove("active"));
  const nav = document.querySelector(`[data-view="${name}"]`);
  if (nav) nav.classList.add("active");

  // Lazy-load view content
  if (name === "agents") loadAgents();
  if (name === "commands") loadCommands();
  if (name === "settings") loadSettingsForm();
  if (name === "statistics") loadStatistics();
  if (name === "git") loadGitView();
  if (name === "activity") loadActivityView();
  if (name === "dashboard") loadDashboard();
}

// ── Board Rendering ──
function renderBoard() {
  const columns = ["backlog", "progress", "review", "done"];
  const tickets = state.board.tickets || [];

  columns.forEach(col => {
    const body = document.querySelector(`[data-drop="${col}"]`);
    const countEl = document.querySelector(`[data-count="${col}"]`);
    const colTickets = tickets.filter(t => t.column === col);
    countEl.textContent = colTickets.length;
    body.innerHTML = "";

    colTickets.forEach(ticket => {
      body.appendChild(createCard(ticket, col));
    });
  });

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

  setupDragDrop();
  applyFilters();
}

function createCard(ticket, col) {
  const card = document.createElement("div");
  card.className = "ticket-card";
  card.dataset.ticketId = ticket.id;
  card.dataset.ticketType = ticket.ticket_type;
  card.dataset.ticketPrio = ticket.prio || "";
  card.draggable = true;

  const isRunning = state.runningTicket === ticket.id;
  if (isRunning) card.classList.add("running");

  // Type badge class
  const typeClass = `badge-${ticket.ticket_type}`;
  const typeLabel = { feature: "feat", bugfix: "fix", security: "sec", docs: "docs" }[ticket.ticket_type] || ticket.ticket_type;

  // Prio badge
  let prioBadge = "";
  if (ticket.prio) {
    prioBadge = `<span class="badge badge-${ticket.prio}">${ticket.prio}</span>`;
  }

  // Action button / status
  let actionHTML = "";
  if (col === "backlog" && !state.runningTicket) {
    actionHTML = `<button class="card-action start" data-execute="${ticket.id}">\u25B7 Start</button>`;
  } else if (col === "progress") {
    actionHTML = `<button class="card-action finish" data-finish="${ticket.id}">\u2714 Ticket abschlie\u00DFen</button>`;
  } else if (col === "review") {
    actionHTML = `<button class="card-action merge" data-merge="${ticket.id}">Merge</button>`;
  } else if (col === "done") {
    actionHTML = `<span class="card-status complete-status">Complete</span>`;
  }

  // Progress bar (Block B1)
  let progressHTML = "";
  if (col === "review") {
    progressHTML = `
      <div class="card-progress">
        <div class="progress-track">
          <div class="progress-fill full" style="width: 100%"></div>
        </div>
      </div>`;
  }

  // Time
  const timeStr = ticket.created_at ? timeAgo(ticket.created_at) : "";

  card.innerHTML = `
    <div class="card-top">
      <span class="card-title">${esc(ticket.title)}</span>
      <span class="card-id">${esc(ticket.id)}</span>
    </div>
    ${ticket.description ? `<div class="card-desc">${esc(ticket.description)}</div>` : ""}
    <div class="card-badges">
      <span class="badge ${typeClass}">${typeLabel}</span>
      ${prioBadge}
      ${ticket.cost_usd ? `<span class="cost-badge">$${ticket.cost_usd.toFixed(2)}</span>` : ""}
      ${(ticket.comments && ticket.comments.length > 0) ? `<span class="comment-count-badge">\u{1F4AC} ${ticket.comments.length}</span>` : ""}
    </div>
    ${progressHTML}
    <div class="card-footer">
      <span class="card-time">${timeStr}</span>
      ${actionHTML}
    </div>
  `;

  // Click to open detail (not on buttons)
  card.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    openDetailPanel(ticket);
  });

  // Right-click context menu (Block B3)
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

// ── Context Menu (Block B3) ──
function showContextMenu(e, ticket) {
  contextTicket = ticket;
  const menu = document.getElementById("context-menu");

  // Show/hide items based on column
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

function closeContextMenu() {
  document.getElementById("context-menu").classList.add("hidden");
  contextTicket = null;
}

async function handleContextMenuAction(e) {
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
  });
}

async function exportLogForTicket(ticketId) {
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

async function exportCurrentLog() {
  const ticketId = state.runningTicket || "general";
  await exportLogForTicket(ticketId);
}

// ── Filter (Block B2) ──
function toggleFilterBar() {
  const bar = document.getElementById("filter-bar");
  bar.classList.toggle("hidden");
  if (!bar.classList.contains("hidden")) {
    document.getElementById("filter-input").focus();
  }
}

function applyFilters() {
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

function clearFilters() {
  document.getElementById("filter-input").value = "";
  document.querySelectorAll(".filter-toggle.active").forEach(b => b.classList.remove("active"));
  applyFilters();
}

// ── Drag & Drop ──
function setupDragDrop() {
  document.querySelectorAll(".ticket-card").forEach(card => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.ticketId);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      document.querySelectorAll(".column").forEach(c => c.classList.remove("drag-over"));
    });
  });

  document.querySelectorAll(".column-body").forEach(body => {
    body.addEventListener("dragover", (e) => {
      e.preventDefault();
      body.closest(".column").classList.add("drag-over");
    });
    body.addEventListener("dragleave", (e) => {
      if (!body.contains(e.relatedTarget)) {
        body.closest(".column").classList.remove("drag-over");
      }
    });
    body.addEventListener("drop", async (e) => {
      e.preventDefault();
      body.closest(".column").classList.remove("drag-over");
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

// ── Execution ──
function confirmExecute(ticket) {
  const needsConfirm = ticket.ticket_type === "feature" || ticket.ticket_type === "bugfix";
  if (!needsConfirm && isAutoExecuteType(ticket.ticket_type)) {
    executeTicket(ticket.id, state.settings.claude_model || "sonnet");
    return;
  }

  document.getElementById("confirm-message").textContent =
    `Execute ticket ${ticket.id} - "${ticket.title}"?`;
  const modelSelect = document.getElementById("confirm-model-select");
  modelSelect.value = state.settings.claude_model || "sonnet";
  document.getElementById("btn-confirm-yes").onclick = () => {
    const selectedModel = modelSelect.value;
    closeModal("modal-confirm");
    executeTicket(ticket.id, selectedModel);
  };
  openModal("modal-confirm");
}

function isAutoExecuteType(type) {
  return (state.settings.auto_execute_types || state.settings.autoExecuteTypes || []).includes(type);
}

function modelToFlag(model) {
  const map = { opus: "claude-opus-4-6", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5" };
  return map[model] || "claude-sonnet-4-6";
}

async function executeTicket(ticketId, model) {
  const ticket = (state.board.tickets || []).find(t => t.id === ticketId);
  const ticketTitle = ticket ? ticket.title : ticketId;
  const selectedModel = model || state.settings.claude_model || "sonnet";

  state.runningTicket = ticketId;
  renderBoard();

  try {
    // Phase 1: Git setup (branch, worktree, copy .claude)
    appendLog(`Starting ${ticketId} - ${ticketTitle}...`);
    const result = await invoke("start_ticket", { ticketId, model: selectedModel });
    appendLog(`Branch: ${result.branch}`);
    appendLog(`Worktree: ${result.worktreePath}`);

    // Phase 2: Open terminal tab with Claude Code in the worktree
    await openTicketTerminal(result, selectedModel);
  } catch (err) {
    state.runningTicket = null;
    appendLog("Start error: " + err, true);
    notifyDesktop("Fehler", `${ticketTitle} fehlgeschlagen`);
    playSound("error");
    refreshBoard();
  }
}

async function openTicketTerminal(startResult, model) {
  // Ensure terminal panel is visible
  const panel = document.getElementById("board-terminal-panel");
  if (panel.classList.contains("collapsed")) {
    panel.classList.remove("collapsed");
    document.getElementById("board-terminal-toggle").innerHTML = "&#9660; Terminal";
    // Restore drag-resized height if available
    if (panel.dataset.savedHeight) {
      panel.style.height = panel.dataset.savedHeight;
    }
    void panel.offsetHeight;
  }

  // Get shell
  let shell = "";
  const select = document.getElementById("board-terminal-shell-select");
  shell = select?.value || state.settings.default_shell || "";
  if (!shell) {
    try {
      const shells = await invoke("list_available_shells");
      if (shells.length > 0) shell = shells[0].path;
    } catch (e) { return; }
  }
  if (!shell) return;

  const cwd = startResult.worktreePath;
  const terminalId = await invoke("spawn_terminal", { shell, cwd });
  state.terminalCounter++;
  const name = startResult.ticketId;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: state.settings.terminal_font_size || 14,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    theme: { background: "#000000", foreground: "#E2E8F0", cursor: "#F97316" },
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const container = document.createElement("div");
  container.className = "terminal-instance";
  container.dataset.terminalId = terminalId;

  const emptyState = document.getElementById("board-terminal-empty");
  if (emptyState) emptyState.style.display = "none";
  document.querySelectorAll("#board-terminal-instances .terminal-instance").forEach(c => c.style.display = "none");
  document.getElementById("board-terminal-instances").appendChild(container);
  container.style.display = "block";

  const tab = document.createElement("button");
  tab.className = "terminal-tab active";
  tab.dataset.terminalId = terminalId;
  tab.innerHTML = `${esc(name)} <span class="tab-close" data-terminal-id="${terminalId}">&times;</span>`;
  document.querySelectorAll("#board-terminal-tabs .terminal-tab").forEach(t => t.classList.remove("active"));
  document.getElementById("board-terminal-tabs").appendChild(tab);

  void container.offsetHeight;
  term.open(container);
  fitAddon.fit();
  const { cols, rows } = term;
  invoke("resize_terminal", { terminalId, cols, rows }).catch(() => {});
  term.focus();

  term.onData(data => {
    invoke("write_terminal", { terminalId, data }).catch(() => {});
  });

  state.terminals[terminalId] = { term, fitAddon, tabEl: tab, containerEl: container, name, ticketId: startResult.ticketId };
  state.activeTerminal = terminalId;

  // Start Claude Code interactively after shell is ready
  setTimeout(() => {
    const claudeCmd = (state.settings.claude_cli_path || "claude") + " --dangerously-skip-permissions --model " + modelToFlag(model || state.settings.claude_model || "sonnet") + "\r";
    invoke("write_terminal", { terminalId, data: claudeCmd }).catch(() => {});

    // Send the prompt after Claude has started
    setTimeout(() => {
      const prompt = "Du arbeitest in einem Git Worktree. \u00C4ndere NUR Dateien die zum Projekt geh\u00F6ren, NICHT den .claude/ Ordner.\n\n" + startResult.prompt + "\r";
      invoke("write_terminal", { terminalId, data: prompt }).catch(() => {});
    }, 3500);
  }, 2500);
}

async function finishTicket(ticketId) {
  if (!confirm(`Ticket ${ticketId} abschlie\u00DFen?\nChanges werden committed und das Ticket nach Review verschoben.`)) return;
  try {
    appendLog(`Finishing ${ticketId}...`);
    await invoke("finish_ticket", { ticketId });
    state.runningTicket = null;
    appendLog(`\u2713 ${ticketId} -> Review`);
    notifyDesktop("Ticket fertig", `${ticketId} ist in Review`);
    playSound("success");
    refreshBoard();
  } catch (err) {
    appendLog("Finish error: " + err, true);
  }
}

async function mergeTicket(ticketId) {
  try {
    appendLog(`Merging ${ticketId}...`);
    await invoke("merge_ticket", { ticketId });
    appendLog(`\u2713 ${ticketId} merged successfully`);
    refreshBoard();
  } catch (err) {
    appendLog("Merge error: " + err, true);
  }
}

// ── Notifications (Block C2) ──
function notifyDesktop(title, body) {
  if (state.settings.notifications_enabled === false) return;
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch (e) {
    console.warn("Notification failed:", e);
  }
}

// ── Sounds (Block C3) ──
function playSound(name) {
  if (state.settings.sounds_enabled === false) return;
  const uri = SOUNDS[name];
  if (!uri) return;
  try {
    const audio = new Audio(uri);
    audio.volume = 0.5;
    audio.play().catch(() => {}); // Ignore autoplay restrictions
  } catch (e) {
    console.warn("Sound failed:", e);
  }
}

// ── Board Refresh ──
async function refreshBoard() {
  try {
    state.board = await invoke("get_board");
    state.runningTicket = await invoke("get_running_ticket");
    renderBoard();
  } catch (e) {
    console.error("Failed to refresh board:", e);
  }
}

// ── Log Panel ──
function appendLog(text, isError = false) {
  const body = document.getElementById("log-body");
  const line = document.createElement("div");
  line.className = "log-line" + (isError ? " error" : "");
  line.textContent = text;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

// ── Sidebar ──
function updateSidebar() {
  const nameEl = document.getElementById("sidebar-project-name");
  const pathEl = document.getElementById("sidebar-project-path");

  if (state.project) {
    nameEl.textContent = state.project.name;
    pathEl.textContent = state.project.path;
  } else {
    nameEl.textContent = "No project";
    pathEl.textContent = "\u2014";
  }
}

// ── Theme ──
function toggleTheme() {
  const current = document.body.dataset.theme;
  const next = current === "dark" ? "light" : "dark";
  document.body.dataset.theme = next;
  updateThemeUI();
  state.settings.theme = next;
  invoke("save_settings", { settings: state.settings }).catch(console.error);
}

function updateThemeUI() {
  const theme = document.body.dataset.theme;
  document.getElementById("theme-icon").textContent = theme === "dark" ? "\u263E" : "\u2600";
  document.getElementById("theme-label").textContent = theme === "dark" ? "Dark Mode" : "Light Mode";
}

function applyAccentColor(color) {
  if (!color) return;
  document.documentElement.style.setProperty("--user-accent", color);
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const hover = `rgb(${Math.min(r + 20, 255)}, ${Math.min(g + 20, 255)}, ${Math.min(b + 20, 255)})`;
  document.documentElement.style.setProperty("--user-accent-hover", hover);
}

// ── Project Picker ──
function openProjectPicker() {
  const list = document.getElementById("picker-list");
  list.innerHTML = "";

  state.projects.forEach(p => {
    const item = document.createElement("div");
    item.className = "picker-item";
    if (state.project && state.project.name === p.name) item.classList.add("active");
    item.innerHTML = `
      <span class="picker-item-name">${esc(p.name)}</span>
      <span class="picker-item-path">${esc(p.path)}</span>
      <button class="picker-item-remove" title="Projekt entfernen">&times;</button>
    `;
    item.querySelector(".picker-item-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      removeProjectFlow(p.name);
    });
    item.addEventListener("click", () => switchProject(p.name));
    list.appendChild(item);
  });

  openModal("modal-picker");
}

async function switchProject(name) {
  try {
    state.board = await invoke("switch_project", { name });
    state.project = await invoke("get_current_project");
    state.projects = await invoke("get_projects");
    closeModal("modal-picker");
    renderBoard();
    updateSidebar();
    checkGitStatus();
    loadDeployConfig();
  } catch (err) {
    appendLog("Switch project error: " + err, true);
  }
}

async function removeProjectFlow(name) {
  if (!confirm(`Projekt "${name}" aus der Liste entfernen?\n(Die Dateien werden nicht gelöscht)`)) return;
  try {
    await invoke("remove_project", { name });
    state.projects = await invoke("get_projects");
    openProjectPicker();
  } catch (err) {
    appendLog("Remove project error: " + err, true);
  }
}

async function addProjectFlow() {
  try {
    const folder = await invoke("pick_folder");
    console.log("pick_folder result:", folder, typeof folder);
    if (!folder) return;

    const parts = folder.replace(/\\/g, "/").split("/");
    const name = parts[parts.length - 1] || "project";

    await invoke("add_project", { name, path: folder });
    state.projects = await invoke("get_projects");
    openProjectPicker();
  } catch (err) {
    appendLog("Add project error: " + err, true);
  }
}

// ── New Task Modal ──
function openNewTaskModal() {
  document.getElementById("new-task-title").value = "";
  document.getElementById("new-task-type").value = "feature";
  document.getElementById("new-task-prio").value = "";
  document.getElementById("new-task-desc").value = "";
  document.getElementById("new-task-template").value = "";
  loadTemplatesForModal();
  openModal("modal-new-task");
  document.getElementById("new-task-title").focus();
}

async function createTask() {
  const title = document.getElementById("new-task-title").value.trim();
  if (!title) return;

  const ticketType = document.getElementById("new-task-type").value;
  const description = document.getElementById("new-task-desc").value.trim();
  const prio = document.getElementById("new-task-prio").value || null;

  try {
    await invoke("create_ticket", { title, ticketType, description, prio });
    state.board = await invoke("get_board");
    closeModal("modal-new-task");
    renderBoard();
  } catch (err) {
    appendLog("Create task error: " + err, true);
  }
}

// ── Detail Panel ──
function openDetailPanel(ticket) {
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
  if (ticket.tokens_used || ticket.cost_usd) {
    costInfo.classList.remove("hidden");
    document.getElementById("detail-model").textContent = ticket.model_used || "-";
    document.getElementById("detail-tokens").textContent = ticket.tokens_used ? ticket.tokens_used.toLocaleString() : "-";
    document.getElementById("detail-cost").textContent = ticket.cost_usd ? "$" + ticket.cost_usd.toFixed(4) : "-";
  } else {
    costInfo.classList.add("hidden");
  }

  // Render timeline (Block A1)
  renderTimeline(ticket);

  // Render comments
  renderComments(ticket);

  document.getElementById("panel-detail").classList.remove("hidden");
}

function closeDetailPanel() {
  document.getElementById("panel-detail").classList.add("hidden");
  state.detailTicket = null;
}

// ── Timeline (Block A1) ──
function renderTimeline(ticket) {
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

  container.innerHTML = `<div class="timeline-title">Timeline</div>` +
    entries.map(e => `
      <div class="timeline-entry">
        <span class="timeline-icon">${e.icon}</span>
        <span class="timeline-label">${e.label}</span>
        <span class="timeline-time">${formatTimeShort(e.time)}</span>
        ${e.duration ? `<span class="timeline-duration">(${e.duration})</span>` : ""}
      </div>
    `).join("");
}

function formatDuration(ms) {
  if (ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "min";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "min";
  const d = Math.floor(h / 24);
  return d + "d " + (h % 24) + "h";
}

function formatTimeShort(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) + " " +
           d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}

async function saveDetailTicket() {
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

async function deleteDetailTicket() {
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

// ── Settings ──
function loadSettingsForm() {
  const s = state.settings;
  document.getElementById("set-claude-path").value = s.claude_cli_path || s.claudeCliPath || "claude";
  document.getElementById("set-commit-prefix").value = s.commit_prefix || s.commitPrefix || "kanban:";
  document.getElementById("set-auto-execute").value = (s.auto_execute_types || s.autoExecuteTypes || []).join(", ");
  document.getElementById("set-accent-color").value = s.accent_color || s.accentColor || "#F97316";
  document.getElementById("accent-color-label").textContent = s.accent_color || s.accentColor || "#F97316";
  document.getElementById("set-theme").value = s.theme || "dark";
  // New settings
  document.getElementById("set-notifications").checked = s.notifications_enabled !== false;
  document.getElementById("set-sounds").checked = s.sounds_enabled !== false;
  document.getElementById("set-backups").checked = s.backups_enabled !== false;
  document.getElementById("set-max-backups").value = s.max_backups || 10;
  document.getElementById("max-backups-label").textContent = s.max_backups || 10;
  // Model & cost settings
  document.getElementById("set-claude-model").value = s.claude_model || "sonnet";
  document.getElementById("set-cost-input").value = s.cost_per_input_mtok ?? 3;
  document.getElementById("set-cost-output").value = s.cost_per_output_mtok ?? 15;
  // Terminal settings
  document.getElementById("set-terminal-fontsize").value = s.terminal_font_size || 14;
  document.getElementById("terminal-fontsize-label").textContent = (s.terminal_font_size || 14) + "px";
  loadShellOptions("set-default-shell", s.default_shell || "");
}

async function saveSettingsForm() {
  const settings = {
    claude_cli_path: document.getElementById("set-claude-path").value.trim(),
    commit_prefix: document.getElementById("set-commit-prefix").value.trim(),
    auto_execute_types: document.getElementById("set-auto-execute").value.split(",").map(s => s.trim()).filter(Boolean),
    accent_color: document.getElementById("set-accent-color").value,
    theme: document.getElementById("set-theme").value,
    notifications_enabled: document.getElementById("set-notifications").checked,
    sounds_enabled: document.getElementById("set-sounds").checked,
    backups_enabled: document.getElementById("set-backups").checked,
    max_backups: parseInt(document.getElementById("set-max-backups").value) || 10,
    claude_model: document.getElementById("set-claude-model").value,
    cost_per_input_mtok: parseFloat(document.getElementById("set-cost-input").value) || 3,
    cost_per_output_mtok: parseFloat(document.getElementById("set-cost-output").value) || 15,
    default_shell: document.getElementById("set-default-shell").value,
    terminal_font_size: parseInt(document.getElementById("set-terminal-fontsize").value) || 14,
  };

  try {
    await invoke("save_settings", { settings });
    state.settings = settings;
    document.body.dataset.theme = settings.theme;
    updateThemeUI();
    applyAccentColor(settings.accent_color);
    await saveDeploySettingsForm();
    appendLog("Settings saved");
  } catch (err) {
    appendLog("Save settings error: " + err, true);
  }
}

// ── Backup Modal ──
async function openBackupModal() {
  openModal("modal-backup");
  const list = document.getElementById("backup-list");
  list.innerHTML = '<p class="empty-state">Loading...</p>';

  try {
    const backups = await invoke("list_backups");
    if (backups.length === 0) {
      list.innerHTML = '<p class="empty-state">No backups found</p>';
      return;
    }
    list.innerHTML = backups.map(b => `
      <div class="backup-item">
        <span class="backup-name">${esc(b)}</span>
        <button class="btn-secondary backup-restore" data-backup="${esc(b)}">Restore</button>
      </div>
    `).join("");

    list.querySelectorAll(".backup-restore").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Restore backup "${btn.dataset.backup}"? Current board will be overwritten.`)) return;
        try {
          state.board = await invoke("restore_backup", { filename: btn.dataset.backup });
          closeModal("modal-backup");
          renderBoard();
          appendLog("Backup restored: " + btn.dataset.backup);
        } catch (err) {
          appendLog("Restore error: " + err, true);
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<p class="empty-state">${esc(String(err))}</p>`;
  }
}

// ── Agents & Commands Views (Block E - Editor) ──
async function loadAgents() {
  try {
    const agents = await invoke("list_agents");
    const list = document.getElementById("agents-list");
    if (agents.length === 0) {
      list.innerHTML = '<p class="empty-state">No agents found in .claude/agents/</p>';
    } else {
      list.innerHTML = agents.map(a => `
        <div class="editor-list-item ${state.editingAgent === a ? "active" : ""}" data-agent="${esc(a)}">
          ${esc(a)}
        </div>
      `).join("");
      list.querySelectorAll(".editor-list-item").forEach(item => {
        item.addEventListener("click", () => openAgentEditor(item.dataset.agent));
      });
    }
    document.getElementById("agent-count").textContent = agents.length;
  } catch (err) {
    document.getElementById("agents-list").innerHTML = `<p class="empty-state">${esc(String(err))}</p>`;
  }
}

async function openAgentEditor(name) {
  try {
    const content = await invoke("read_agent", { name });
    state.editingAgent = name;
    document.getElementById("agent-editor-name").textContent = name + ".md";
    document.getElementById("agent-editor-content").value = content;
    document.getElementById("agent-editor").classList.remove("hidden");
    // Update active state in list
    document.querySelectorAll("#agents-list .editor-list-item").forEach(i => {
      i.classList.toggle("active", i.dataset.agent === name);
    });
  } catch (err) {
    appendLog("Error reading agent: " + err, true);
  }
}

async function saveAgentEditor() {
  if (!state.editingAgent) return;
  const content = document.getElementById("agent-editor-content").value;
  try {
    await invoke("save_agent", { name: state.editingAgent, content });
    appendLog("Agent saved: " + state.editingAgent);
  } catch (err) {
    appendLog("Save agent error: " + err, true);
  }
}

async function deleteAgentEditor() {
  if (!state.editingAgent) return;
  if (!confirm(`Delete agent "${state.editingAgent}"?`)) return;
  try {
    await invoke("delete_agent", { name: state.editingAgent });
    state.editingAgent = null;
    document.getElementById("agent-editor").classList.add("hidden");
    loadAgents();
    appendLog("Agent deleted");
  } catch (err) {
    appendLog("Delete agent error: " + err, true);
  }
}

async function newAgentFlow() {
  const name = prompt("Agent name:");
  if (!name || !name.trim()) return;
  try {
    await invoke("create_agent", { name: name.trim() });
    await loadAgents();
    openAgentEditor(name.trim());
  } catch (err) {
    appendLog("Create agent error: " + err, true);
  }
}

async function loadCommands() {
  try {
    const cmds = await invoke("list_commands_available");
    const list = document.getElementById("commands-list");
    if (cmds.length === 0) {
      list.innerHTML = '<p class="empty-state">No commands found in .claude/commands/</p>';
    } else {
      list.innerHTML = cmds.map(c => `
        <div class="editor-list-item ${state.editingCommand === c ? "active" : ""}" data-command="${esc(c)}">
          ${esc(c)}
        </div>
      `).join("");
      list.querySelectorAll(".editor-list-item").forEach(item => {
        item.addEventListener("click", () => openCommandEditor(item.dataset.command));
      });
    }
    document.getElementById("command-count").textContent = cmds.length;
  } catch (err) {
    document.getElementById("commands-list").innerHTML = `<p class="empty-state">${esc(String(err))}</p>`;
  }
}

async function openCommandEditor(name) {
  try {
    const content = await invoke("read_command", { name });
    state.editingCommand = name;
    document.getElementById("command-editor-name").textContent = name + ".md";
    document.getElementById("command-editor-content").value = content;
    document.getElementById("command-editor").classList.remove("hidden");
    document.querySelectorAll("#commands-list .editor-list-item").forEach(i => {
      i.classList.toggle("active", i.dataset.command === name);
    });
  } catch (err) {
    appendLog("Error reading command: " + err, true);
  }
}

async function saveCommandEditor() {
  if (!state.editingCommand) return;
  const content = document.getElementById("command-editor-content").value;
  try {
    await invoke("save_command", { name: state.editingCommand, content });
    appendLog("Command saved: " + state.editingCommand);
  } catch (err) {
    appendLog("Save command error: " + err, true);
  }
}

async function deleteCommandEditor() {
  if (!state.editingCommand) return;
  if (!confirm(`Delete command "${state.editingCommand}"?`)) return;
  try {
    await invoke("delete_command", { name: state.editingCommand });
    state.editingCommand = null;
    document.getElementById("command-editor").classList.add("hidden");
    loadCommands();
    appendLog("Command deleted");
  } catch (err) {
    appendLog("Delete command error: " + err, true);
  }
}

async function newCommandFlow() {
  const name = prompt("Command name:");
  if (!name || !name.trim()) return;
  try {
    await invoke("create_command", { name: name.trim() });
    await loadCommands();
    openCommandEditor(name.trim());
  } catch (err) {
    appendLog("Create command error: " + err, true);
  }
}

// ── Statistics (Block D2) ──
function loadStatistics() {
  const tickets = state.board.tickets || [];
  const done = tickets.filter(t => t.column === "done");

  // Basic stats
  document.getElementById("stat-total").textContent = tickets.length;
  document.getElementById("stat-done").textContent = done.length;

  // Avg cycle time (created -> done)
  const cycleTimes = done
    .filter(t => t.created_at && t.done_at)
    .map(t => new Date(t.done_at) - new Date(t.created_at))
    .filter(d => d > 0);
  document.getElementById("stat-cycle").textContent =
    cycleTimes.length > 0 ? formatDuration(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) : "-";

  // Avg review time (review_at -> done_at)
  const reviewTimes = done
    .filter(t => t.review_at && t.done_at)
    .map(t => new Date(t.done_at) - new Date(t.review_at))
    .filter(d => d > 0);
  document.getElementById("stat-review").textContent =
    reviewTimes.length > 0 ? formatDuration(reviewTimes.reduce((a, b) => a + b, 0) / reviewTimes.length) : "-";

  // Cost stats
  const ticketsWithCost = tickets.filter(t => t.cost_usd);
  const totalCost = ticketsWithCost.reduce((sum, t) => sum + (t.cost_usd || 0), 0);
  const costEl = document.getElementById("stat-total-cost");
  if (costEl) costEl.textContent = totalCost > 0 ? "$" + totalCost.toFixed(2) : "-";
  const avgCostEl = document.getElementById("stat-avg-cost");
  if (avgCostEl) avgCostEl.textContent = ticketsWithCost.length > 0
    ? "$" + (totalCost / ticketsWithCost.length).toFixed(2) : "-";

  // Stats badge
  document.getElementById("stats-badge").textContent = done.length + "/" + tickets.length;

  // Pie chart (by type)
  renderTypePieChart(tickets);
  // Bar chart (by column)
  renderColumnBarChart(tickets);
  // Recent completed
  renderRecentCompleted(done);
}

function renderTypePieChart(tickets) {
  const counts = { feature: 0, bugfix: 0, security: 0, docs: 0 };
  tickets.forEach(t => { if (counts[t.ticket_type] !== undefined) counts[t.ticket_type]++; });
  const total = tickets.length || 1;
  const colors = { feature: "#3B82F6", bugfix: "#EAB308", security: "#EF4444", docs: "#EC4899" };
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

  const legend = document.getElementById("pie-legend");
  legend.innerHTML = Object.entries(counts)
    .filter(([_, c]) => c > 0)
    .map(([type, count]) =>
      `<div class="legend-item"><span class="legend-dot" style="background:${colors[type]}"></span>${type}: ${count}</div>`
    ).join("");
}

function renderColumnBarChart(tickets) {
  const cols = ["backlog", "progress", "review", "done"];
  const counts = {};
  cols.forEach(c => counts[c] = tickets.filter(t => t.column === c).length);
  const max = Math.max(...Object.values(counts), 1);
  const colors = { backlog: "var(--text-muted)", progress: "var(--accent)", review: "var(--info)", done: "var(--success)" };

  const chart = document.getElementById("bar-chart");
  chart.innerHTML = cols.map(col => `
    <div class="bar-group">
      <div class="bar" style="height: ${(counts[col] / max) * 100}%; background: ${colors[col]}">
        <span class="bar-value">${counts[col]}</span>
      </div>
      <span class="bar-label">${col}</span>
    </div>
  `).join("");
}

function renderRecentCompleted(doneTickets) {
  const sorted = doneTickets
    .filter(t => t.done_at)
    .sort((a, b) => new Date(b.done_at) - new Date(a.done_at))
    .slice(0, 10);

  const container = document.getElementById("recent-completed");
  if (sorted.length === 0) {
    container.innerHTML = '<span class="empty-state" style="padding:8px 0">No completed tickets</span>';
    return;
  }

  container.innerHTML = sorted.map(t => {
    const dur = t.created_at && t.done_at
      ? formatDuration(new Date(t.done_at) - new Date(t.created_at))
      : "-";
    return `<div class="recent-item">
      <span class="recent-title">${esc(t.id)} - ${esc(t.title)}</span>
      <span class="recent-dur">${dur}</span>
    </div>`;
  }).join("");
}

// ── Git Status ──
async function checkGitStatus() {
  try {
    const dirty = await invoke("check_uncommitted");
    const badge = document.getElementById("git-status");
    if (dirty) {
      badge.textContent = "\u25CF uncommitted changes";
      badge.classList.add("dirty");
      badge.classList.remove("clean");
    } else {
      badge.textContent = "\u25CF clean";
      badge.classList.add("clean");
      badge.classList.remove("dirty");
    }
  } catch {
    // No project selected
  }
}

// ── Dashboard (Phase 3 - Block D) ──

async function loadDashboard() {
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
        ? info.recentCommits.map(c => `
            <div class="dash-commit-item">
              <span class="hash">${esc(c.hash)}</span>
              <span class="msg">${esc(c.message)}</span>
              <span class="date">${timeAgo(c.date)}</span>
            </div>`).join("")
        : '<span style="color:var(--muted)">No commits</span>';

    // Recent activity
    document.getElementById("dash-activity-body").innerHTML =
      info.recentActivity.length > 0
        ? info.recentActivity.map(a => `
            <div class="dash-activity-item">
              <span class="act-label">${esc(a.action.replace(/_/g, " "))}${a.ticket_title ? " — " + esc(a.ticket_title) : ""}</span>
              <span class="act-time">${timeAgo(a.timestamp)}</span>
            </div>`).join("")
        : '<span style="color:var(--muted)">No activity</span>';

  } catch (e) {
    console.error("Dashboard error:", e);
  }
}

// ── Templates (Phase 3 - Block D) ──

async function loadTemplatesForModal() {
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

function setupTemplateListener() {
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

// ── Import/Export (Phase 3 - Block D) ──

function setupImportExportListeners() {
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
      updateSidebar();
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

// ── Model Preset (Phase 3 - Block C) ──
function setupModelPresetListener() {
  document.getElementById("set-claude-model")?.addEventListener("change", (e) => {
    const presets = { sonnet: [3, 15], opus: [15, 75] };
    const p = presets[e.target.value];
    if (p) {
      document.getElementById("set-cost-input").value = p[0];
      document.getElementById("set-cost-output").value = p[1];
    }
  });
}

// ── Activity View (Phase 3 - Block C) ──

let activityFilter = "all";

async function loadActivityView() {
  const list = document.getElementById("activity-list");
  list.innerHTML = '<p class="empty-state">Loading...</p>';

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
      const title = e.ticket_title ? ` — ${esc(e.ticket_title)}` : "";
      const detail = e.details ? esc(e.details) : "";
      const ticketId = e.ticket_id ? esc(e.ticket_id) : "";
      html += `
        <div class="activity-item">
          <span class="activity-icon ${cls}">${icon}</span>
          <div class="activity-body">
            <span class="activity-action">${esc(e.action.replace(/_/g, " "))}${title}</span>
            <div class="activity-detail">${ticketId}${detail ? " · " + detail : ""}</div>
          </div>
          <span class="activity-time">${timeAgo(e.timestamp)}</span>
        </div>`;
    }
  }

  list.innerHTML = html;
}

function setupActivityListeners() {
  document.querySelectorAll(".activity-filter").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".activity-filter").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activityFilter = btn.dataset.activityFilter;
      loadActivityView();
    });
  });
}

// ── Comments (Phase 3 - Block C) ──

function renderComments(ticket) {
  const list = document.getElementById("detail-comments-list");
  const comments = ticket.comments || [];

  if (comments.length === 0) {
    list.innerHTML = '<p class="empty-state" style="font-size:12px;margin:4px 0">No comments yet</p>';
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
        // Refresh
        state.board = await invoke("get_board");
        const updated = state.board.tickets.find(t => t.id === btn.dataset.ticketId);
        if (updated) renderComments(updated);
      } catch (e) {
        appendLog("Delete comment error: " + e, true);
      }
    });
  });
}

function setupCommentListeners() {
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

// ── Git View (Phase 3 - Block B) ──

let selectedBranch = null;

async function loadGitView() {
  const list = document.getElementById("git-branch-list");
  list.innerHTML = '<p class="empty-state">Loading branches...</p>';
  document.getElementById("git-detail").classList.add("hidden");

  try {
    const branches = await invoke("list_branches");
    document.getElementById("branch-count").textContent = branches.length;

    if (branches.length === 0) {
      list.innerHTML = '<p class="empty-state">No branches found</p>';
      return;
    }

    list.innerHTML = branches.map(b => `
      <div class="git-branch-item" data-branch="${esc(b.name)}">
        <span class="branch-name">
          ${b.isCurrent ? '<span class="current-badge">&#9679;</span>' : ""}
          ${esc(b.name)}
          ${b.isKanban ? '<span class="kanban-badge">kanban</span>' : ""}
        </span>
        <span class="branch-meta">${esc(b.lastCommitMsg)}</span>
      </div>
    `).join("");

    list.querySelectorAll(".git-branch-item").forEach(el => {
      el.addEventListener("click", () => selectGitBranch(el.dataset.branch));
    });
  } catch (e) {
    list.innerHTML = `<p class="empty-state">Error: ${esc(String(e))}</p>`;
  }
}

async function selectGitBranch(branch) {
  selectedBranch = branch;

  // Highlight in list
  document.querySelectorAll(".git-branch-item").forEach(el => el.classList.remove("active"));
  const active = document.querySelector(`.git-branch-item[data-branch="${CSS.escape(branch)}"]`);
  if (active) active.classList.add("active");

  const detail = document.getElementById("git-detail");
  detail.classList.remove("hidden");
  document.getElementById("git-branch-name").textContent = branch;
  document.getElementById("git-diff-content").classList.add("hidden");

  // Load commits and diff in parallel
  const [commits, diff] = await Promise.all([
    invoke("get_commit_log", { branch, limit: 10 }).catch(() => []),
    invoke("get_branch_diff", { branch }).catch(() => ({ files: [], totalAdditions: 0, totalDeletions: 0 })),
  ]);

  // Render commits
  const commitsEl = document.getElementById("git-commits");
  if (commits.length === 0) {
    commitsEl.innerHTML = '<p class="empty-state" style="font-size:12px">No commits</p>';
  } else {
    commitsEl.innerHTML = commits.map(c => `
      <div class="git-commit-item">
        <span class="commit-hash">${esc(c.hash)}</span>
        <span class="commit-msg">${esc(c.message)}</span>
        <span class="commit-date">${timeAgo(c.date)}</span>
      </div>
    `).join("");
  }

  // Render diff stats
  document.getElementById("git-diff-stats").innerHTML =
    `<span class="stat-add">+${diff.totalAdditions}</span> / <span class="stat-del">-${diff.totalDeletions}</span> in ${diff.files.length} files`;

  // Render file list
  const filesEl = document.getElementById("git-diff-files");
  if (diff.files.length === 0) {
    filesEl.innerHTML = '<p class="empty-state" style="font-size:12px">No changes</p>';
  } else {
    filesEl.innerHTML = diff.files.map(f => `
      <div class="git-file-item" data-file="${esc(f.filePath)}" data-branch="${esc(branch)}">
        <span class="file-status ${esc(f.status)}">${esc(f.status)}</span>
        <span class="file-path">${esc(f.filePath)}</span>
        <span class="file-changes">+${f.additions} -${f.deletions}</span>
      </div>
    `).join("");

    filesEl.querySelectorAll(".git-file-item").forEach(el => {
      el.addEventListener("click", () => showFileDiff(el.dataset.branch, el.dataset.file));
    });
  }
}

async function showFileDiff(branch, filePath) {
  const container = document.getElementById("git-diff-content");
  container.classList.remove("hidden");
  document.getElementById("git-diff-filename").textContent = filePath;
  document.getElementById("git-diff-body").innerHTML = "Loading...";

  try {
    const diff = await invoke("get_file_diff", { branch, filePath });
    const body = document.getElementById("git-diff-body");
    if (!diff.trim()) {
      body.textContent = "(no diff available)";
      return;
    }
    // Syntax-highlight the diff
    body.innerHTML = diff.split("\n").map(line => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return `<span class="diff-line-add">${esc(line)}</span>`;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        return `<span class="diff-line-del">${esc(line)}</span>`;
      } else if (line.startsWith("@@")) {
        return `<span class="diff-line-hdr">${esc(line)}</span>`;
      }
      return esc(line);
    }).join("\n");
  } catch (e) {
    document.getElementById("git-diff-body").textContent = "Error: " + e;
  }
}

function setupGitListeners() {
  document.getElementById("btn-refresh-branches")?.addEventListener("click", loadGitView);

  document.getElementById("btn-git-merge")?.addEventListener("click", async () => {
    if (!selectedBranch) return;
    if (!confirm(`Merge "${selectedBranch}" nach main?`)) return;
    try {
      // Find ticket with this branch
      const ticket = state.board.tickets.find(t => t.branch === selectedBranch);
      if (ticket) {
        await invoke("merge_ticket", { ticketId: ticket.id });
        appendLog(`Merged ${selectedBranch}`);
      } else {
        appendLog("No ticket found for this branch", true);
      }
      loadGitView();
    } catch (e) {
      appendLog("Merge failed: " + e, true);
    }
  });

  document.getElementById("btn-git-delete")?.addEventListener("click", async () => {
    if (!selectedBranch) return;
    if (!confirm(`Branch "${selectedBranch}" löschen?`)) return;
    try {
      await invoke("delete_branch_cmd", { branch: selectedBranch, force: true });
      appendLog(`Deleted branch: ${selectedBranch}`);
      selectedBranch = null;
      loadGitView();
    } catch (e) {
      appendLog("Delete failed: " + e, true);
    }
  });

  document.getElementById("btn-git-terminal")?.addEventListener("click", () => {
    if (!selectedBranch) return;
    openBoardTerminal();
  });

  document.getElementById("btn-close-diff")?.addEventListener("click", () => {
    document.getElementById("git-diff-content").classList.add("hidden");
  });
}

// ── Terminal (Phase 3 - Block A) ──

async function loadShellOptions(selectId, selectedValue) {
  const select = document.getElementById(selectId);
  if (!select) return;
  try {
    const shells = await invoke("list_available_shells");
    select.innerHTML = '<option value="">Auto-detect</option>' +
      shells.map(s => `<option value="${esc(s.path)}"${s.path === selectedValue ? " selected" : ""}>${esc(s.name)}</option>`).join("");
  } catch (e) {
    console.error("Failed to load shells:", e);
  }
}

function cleanupTerminal(terminalId) {
  const inst = state.terminals[terminalId];
  if (inst) {
    inst.term.dispose();
    if (inst.tabEl) inst.tabEl.remove();
    inst.containerEl.remove();
    delete state.terminals[terminalId];
  }

  // Switch to another tab or show empty state
  const remaining = Object.keys(state.terminals);
  if (remaining.length > 0) {
    const nextId = remaining[remaining.length - 1];
    const nextInst = state.terminals[nextId];
    if (nextInst) {
      // Activate in whichever panel it's in
      document.querySelectorAll(".terminal-tab").forEach(t => t.classList.remove("active"));
      if (nextInst.tabEl) nextInst.tabEl.classList.add("active");
      document.querySelectorAll(".terminal-instance").forEach(c => c.style.display = "none");
      nextInst.containerEl.style.display = "block";
      state.activeTerminal = nextId;
      requestAnimationFrame(() => {
        nextInst.fitAddon.fit();
        nextInst.term.focus();
      });
    }
  } else {
    state.activeTerminal = null;
    const boardEmpty = document.getElementById("board-terminal-empty");
    if (boardEmpty) boardEmpty.style.display = "";
  }
}

async function closeTerminalById(terminalId) {
  try {
    await invoke("close_terminal", { terminalId });
  } catch (e) {
    // Terminal might already be closed
  }
  cleanupTerminal(terminalId);
}

function toggleTerminalView() {
  toggleBoardTerminalPanel();
}

function toggleBoardTerminalPanel() {
  const panel = document.getElementById("board-terminal-panel");
  if (!panel) return;
  const wasCollapsed = panel.classList.contains("collapsed");
  panel.classList.toggle("collapsed");

  const toggleBtn = document.getElementById("board-terminal-toggle");
  if (wasCollapsed) {
    toggleBtn.innerHTML = "&#9660; Terminal";
    // Restore drag-resized height if available
    if (panel.dataset.savedHeight) {
      panel.style.height = panel.dataset.savedHeight;
    }
    // Auto-open a terminal if none exist
    if (Object.keys(state.terminals).length === 0) {
      openBoardTerminal();
    } else {
      // Refit the active terminal
      refitBoardTerminal();
    }
  } else {
    toggleBtn.innerHTML = "&#9654; Terminal";
    // Save and clear inline height so collapsed state can anchor to bottom
    if (panel.style.height) {
      panel.dataset.savedHeight = panel.style.height;
      panel.style.height = "";
    }
  }
}

async function openBoardTerminal(shell) {
  if (!state.project) return;
  const panel = document.getElementById("board-terminal-panel");
  const wasCollapsed = panel.classList.contains("collapsed");
  if (wasCollapsed) {
    panel.classList.remove("collapsed");
    document.getElementById("board-terminal-toggle").innerHTML = "&#9660; Terminal";
    // Restore drag-resized height if available
    if (panel.dataset.savedHeight) {
      panel.style.height = panel.dataset.savedHeight;
    }
    // Force synchronous reflow so .board-terminal-body gets display:flex
    // before xterm.open() measures container dimensions
    void panel.offsetHeight;
  }

  const cwd = state.project.path;
  if (!shell) {
    const select = document.getElementById("board-terminal-shell-select");
    shell = select?.value || state.settings.default_shell || "";
  }
  if (!shell) {
    try {
      const shells = await invoke("list_available_shells");
      if (shells.length > 0) shell = shells[0].path;
    } catch (e) { return; }
  }
  if (!shell) return;

  try {
    const terminalId = await invoke("spawn_terminal", { shell, cwd });
    state.terminalCounter++;
    const name = "Terminal " + state.terminalCounter;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: state.settings.terminal_font_size || 14,
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      theme: { background: "#000000", foreground: "#E2E8F0", cursor: "#F97316" },
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const container = document.createElement("div");
    container.className = "terminal-instance";
    container.dataset.terminalId = terminalId;

    const emptyState = document.getElementById("board-terminal-empty");
    if (emptyState) emptyState.style.display = "none";
    document.querySelectorAll("#board-terminal-instances .terminal-instance").forEach(c => c.style.display = "none");
    document.getElementById("board-terminal-instances").appendChild(container);
    container.style.display = "block";

    // Tab in board panel
    const tab = document.createElement("button");
    tab.className = "terminal-tab active";
    tab.dataset.terminalId = terminalId;
    tab.innerHTML = `${esc(name)} <span class="tab-close" data-terminal-id="${terminalId}">&times;</span>`;
    document.querySelectorAll("#board-terminal-tabs .terminal-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("board-terminal-tabs").appendChild(tab);

    // Ensure container has layout dimensions before xterm measures it
    void container.offsetHeight;
    term.open(container);
    fitAddon.fit();
    const { cols, rows } = term;
    invoke("resize_terminal", { terminalId, cols, rows }).catch(() => {});
    term.focus();

    term.onData(data => {
      invoke("write_terminal", { terminalId, data }).catch(() => {});
    });

    state.terminals[terminalId] = { term, fitAddon, tabEl: tab, containerEl: container, name };
    state.activeTerminal = terminalId;
  } catch (e) {
    appendLog("Failed to open terminal: " + e, true);
  }
}

function refitBoardTerminal() {
  if (!state.activeTerminal || !state.terminals[state.activeTerminal]) return;
  const inst = state.terminals[state.activeTerminal];
  requestAnimationFrame(() => {
    inst.fitAddon.fit();
    const { cols, rows } = inst.term;
    invoke("resize_terminal", { terminalId: state.activeTerminal, cols, rows }).catch(() => {});
  });
}

function switchBoardTerminalTab(terminalId) {
  if (!state.terminals[terminalId]) return;
  document.querySelectorAll("#board-terminal-tabs .terminal-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll("#board-terminal-instances .terminal-instance").forEach(c => c.style.display = "none");

  const inst = state.terminals[terminalId];
  if (inst.tabEl) inst.tabEl.classList.add("active");
  inst.containerEl.style.display = "block";
  state.activeTerminal = terminalId;
  refitBoardTerminal();
  inst.term.focus();
}

function setupTerminalListeners() {
  // Sidebar "Terminal" button — open board + expand panel
  document.getElementById("nav-terminal")?.addEventListener("click", () => {
    switchView("board");
    const panel = document.getElementById("board-terminal-panel");
    if (panel && panel.classList.contains("collapsed")) {
      toggleBoardTerminalPanel();
    }
  });

  // Board-panel tab clicks
  document.getElementById("board-terminal-tabs")?.addEventListener("click", e => {
    const closeBtn = e.target.closest(".tab-close");
    if (closeBtn) {
      e.stopPropagation();
      closeTerminalById(closeBtn.dataset.terminalId);
      return;
    }
    const tab = e.target.closest(".terminal-tab");
    if (tab) switchBoardTerminalTab(tab.dataset.terminalId);
  });

  // Board-panel toggle
  document.getElementById("board-terminal-toggle")?.addEventListener("click", toggleBoardTerminalPanel);

  // Board-panel new terminal
  document.getElementById("board-terminal-new")?.addEventListener("click", () => openBoardTerminal());

  // Board-panel shell dropdown — load shells on first focus
  const boardShellSelect = document.getElementById("board-terminal-shell-select");
  if (boardShellSelect) {
    let boardShellsLoaded = false;
    boardShellSelect.addEventListener("focus", async () => {
      if (boardShellsLoaded) return;
      boardShellsLoaded = true;
      await loadShellOptions("board-terminal-shell-select", state.settings.default_shell || "");
    });
    // Also load now (best-effort)
    loadShellOptions("board-terminal-shell-select", state.settings.default_shell || "");
  }

  // Font size slider live preview
  document.getElementById("set-terminal-fontsize")?.addEventListener("input", (e) => {
    document.getElementById("terminal-fontsize-label").textContent = e.target.value + "px";
  });

  // Resize observer — board terminal panel
  const boardBody = document.getElementById("board-terminal-instances");
  if (boardBody) {
    let resizeTimeout2;
    new ResizeObserver(() => {
      clearTimeout(resizeTimeout2);
      resizeTimeout2 = setTimeout(() => refitBoardTerminal(), 100);
    }).observe(boardBody);
  }

  // Drag-resize for board terminal panel
  const drag = document.getElementById("board-terminal-drag");
  const panel = document.getElementById("board-terminal-panel");
  if (drag && panel) {
    let startY, startH;
    const onMouseMove = (e) => {
      const newH = startH - (e.clientY - startY);
      panel.style.height = Math.max(100, Math.min(newH, window.innerHeight * 0.7)) + "px";
    };
    const onMouseUp = () => {
      drag.classList.remove("dragging");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      refitBoardTerminal();
    };
    drag.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = panel.offsetHeight;
      drag.classList.add("dragging");
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }
}

// ── Deploy (Phase 4) ──

function setupDeployListeners() {
  document.getElementById("btn-local-deploy")?.addEventListener("click", confirmLocalDeploy);
  document.getElementById("btn-live-deploy")?.addEventListener("click", confirmLiveDeploy);
  document.getElementById("btn-detect-env")?.addEventListener("click", detectDeployEnvironment);
  document.getElementById("btn-deploy-confirm-yes")?.addEventListener("click", () => {
    const action = document.getElementById("modal-deploy-confirm").dataset.action;
    closeModal("modal-deploy-confirm");
    if (action === "local") executeLocalDeploy();
    else if (action === "local-stop") executeLocalDeployStop();
    else if (action === "live") executeLiveDeploy();
  });
  document.getElementById("btn-deploy-confirm-no")?.addEventListener("click", () => {
    closeModal("modal-deploy-confirm");
  });
  // Toggle live settings panel visibility
  document.getElementById("set-live-enabled")?.addEventListener("change", (e) => {
    const panel = document.getElementById("live-settings-panel");
    if (panel) {
      panel.classList.toggle("collapsed", !e.target.checked);
    }
  });
}

async function loadDeployConfig() {
  try {
    state.deployConfig = await invoke("get_deploy_config");
    updateDeployButtons();
    loadDeploySettingsForm();
  } catch (e) {
    console.error("Load deploy config:", e);
  }
}

function updateDeployButtons() {
  const cfg = state.deployConfig;
  const localBtn = document.getElementById("btn-local-deploy");
  const liveBtn = document.getElementById("btn-live-deploy");
  if (!cfg) {
    localBtn?.classList.add("hidden");
    liveBtn?.classList.add("hidden");
    return;
  }
  // Show local deploy button if compose files exist or deploy type is compose
  if (cfg.composeFiles?.length > 0 || cfg.deployType === "compose") {
    localBtn?.classList.remove("hidden");
  } else {
    localBtn?.classList.add("hidden");
  }
  // Show live deploy button if enabled and host configured
  if (cfg.liveEnabled && cfg.sshHost) {
    liveBtn?.classList.remove("hidden");
  } else {
    liveBtn?.classList.add("hidden");
  }
}

function confirmLocalDeploy() {
  const cfg = state.deployConfig;
  if (!cfg) return;
  const modal = document.getElementById("modal-deploy-confirm");
  modal.dataset.action = "local";
  document.getElementById("deploy-confirm-title").textContent = "Lokal testen (Docker)";
  document.getElementById("deploy-confirm-message").textContent = "Docker Compose starten?";

  // Build preview command
  const files = (cfg.composeFiles?.length > 0) ? cfg.composeFiles : ["docker-compose.yml"];
  let cmd = "docker compose";
  files.forEach(f => cmd += ` -f ${f}`);
  if (cfg.envFile) cmd += ` --env-file ${cfg.envFile}`;
  cmd += " up --build -d";
  document.getElementById("deploy-confirm-details").textContent = cmd;
  openModal("modal-deploy-confirm");
}

async function executeLocalDeploy() {
  state.deployingLocal = true;
  updateDeployBadge("deploying", "Deploying...");
  try {
    const terminalId = await invoke("local_deploy");
    openDeployTerminal(terminalId, "Local Deploy");

    // Inject compose command after shell startup
    const cfg = state.deployConfig;
    const files = (cfg.composeFiles?.length > 0) ? cfg.composeFiles : [];
    let cmd = "docker compose";
    files.forEach(f => cmd += ` -f ${f}`);
    if (cfg.envFile) cmd += ` --env-file ${cfg.envFile}`;
    cmd += " up --build -d\r";
    setTimeout(() => {
      invoke("write_terminal", { terminalId, data: cmd }).catch(() => {});
    }, 1500);

    updateDeployBadge("success", "Local running");
    state.deployingLocal = false;
  } catch (e) {
    updateDeployBadge("error", "Deploy failed");
    state.deployingLocal = false;
    appendLog("Local deploy error: " + e, true);
  }
}

function confirmLiveDeploy() {
  const cfg = state.deployConfig;
  if (!cfg || !cfg.liveEnabled) return;
  const modal = document.getElementById("modal-deploy-confirm");
  modal.dataset.action = "live";
  document.getElementById("deploy-confirm-title").textContent = "Live deployen";
  document.getElementById("deploy-confirm-message").textContent = `Deploy zu ${cfg.sshHost}?`;

  // Build SSH command preview
  const allCmds = [
    ...(cfg.preCommands || []),
    ...(cfg.deployCommands || []),
    ...(cfg.postCommands || []),
  ].filter(Boolean);
  let preview = "ssh";
  if (cfg.sshKey) preview += ` -i ${cfg.sshKey}`;
  if (cfg.sshPort && cfg.sshPort !== 22) preview += ` -p ${cfg.sshPort}`;
  preview += ` ${cfg.sshHost}`;
  if (cfg.serverPath || allCmds.length > 0) {
    const remoteParts = [];
    if (cfg.serverPath) remoteParts.push(`cd ${cfg.serverPath}`);
    remoteParts.push(...allCmds);
    preview += `\n"${remoteParts.join(" && ")}"`;
  }
  document.getElementById("deploy-confirm-details").textContent = preview;
  openModal("modal-deploy-confirm");
}

async function executeLiveDeploy() {
  state.deployingLive = true;
  updateDeployBadge("deploying", "Deploying live...");
  try {
    const terminalId = await invoke("live_deploy");
    openDeployTerminal(terminalId, "Live Deploy");

    // Build and inject SSH command with input validation
    const cfg = state.deployConfig;
    if (!validateDeployParam("SSH host", cfg.sshHost) ||
        !validateDeployParam("SSH key", cfg.sshKey) ||
        !validateDeployParam("Server path", cfg.serverPath)) {
      state.deployingLive = false;
      updateDeployBadge("error", "Invalid deploy config");
      return;
    }
    const allCmds = [
      ...(cfg.preCommands || []),
      ...(cfg.deployCommands || []),
      ...(cfg.postCommands || []),
    ].filter(Boolean);

    for (const cmd of allCmds) {
      if (!validateDeployParam("Deploy command", cmd)) {
        state.deployingLive = false;
        updateDeployBadge("error", "Invalid deploy command");
        return;
      }
    }

    let sshCmd = "ssh";
    if (cfg.sshKey) sshCmd += ` -i ${shellEscape(cfg.sshKey)}`;
    if (cfg.sshPort && cfg.sshPort !== 22) sshCmd += ` -p ${cfg.sshPort}`;
    sshCmd += ` ${shellEscape(cfg.sshHost)}`;
    if (cfg.serverPath || allCmds.length > 0) {
      const remoteParts = [];
      if (cfg.serverPath) remoteParts.push(`cd ${shellEscape(cfg.serverPath)}`);
      remoteParts.push(...allCmds);
      sshCmd += ` "${remoteParts.join(" && ")}"`;
    }
    sshCmd += "\r";

    setTimeout(() => {
      invoke("write_terminal", { terminalId, data: sshCmd }).catch(() => {});
    }, 1500);

    updateDeployBadge("success", "Live deployed");
    state.deployingLive = false;
  } catch (e) {
    updateDeployBadge("error", "Live deploy failed");
    state.deployingLive = false;
    appendLog("Live deploy error: " + e, true);
  }
}

async function executeLocalDeployStop() {
  try {
    const terminalId = await invoke("local_deploy_stop");
    openDeployTerminal(terminalId, "Docker Stop");

    const cfg = state.deployConfig;
    const files = (cfg.composeFiles?.length > 0) ? cfg.composeFiles : [];
    let cmd = "docker compose";
    files.forEach(f => cmd += ` -f ${f}`);
    cmd += " down\r";
    setTimeout(() => {
      invoke("write_terminal", { terminalId, data: cmd }).catch(() => {});
    }, 1500);

    updateDeployBadge("hidden", "");
  } catch (e) {
    appendLog("Docker stop error: " + e, true);
  }
}

function updateDeployBadge(status, text) {
  const badge = document.getElementById("deploy-status-badge");
  if (!badge) return;
  badge.className = "deploy-badge";
  if (status === "hidden") {
    badge.classList.add("hidden");
    badge.textContent = "";
    return;
  }
  badge.classList.remove("hidden");
  badge.classList.add(status);
  badge.textContent = text;
}

async function openDeployTerminal(terminalId, name) {
  // Ensure terminal panel is visible
  const panel = document.getElementById("board-terminal-panel");
  if (panel && panel.classList.contains("collapsed")) {
    panel.classList.remove("collapsed");
    document.getElementById("board-terminal-toggle").innerHTML = "&#9660; Terminal";
    if (panel.dataset.savedHeight) {
      panel.style.height = panel.dataset.savedHeight;
    }
    void panel.offsetHeight;
  }

  // Switch to board view if not already there
  const boardView = document.getElementById("view-board");
  if (boardView && !boardView.classList.contains("active")) {
    switchView("board");
  }

  const term = new Terminal({
    cursorBlink: true,
    fontSize: state.settings.terminal_font_size || 14,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    theme: { background: "#000000", foreground: "#E2E8F0", cursor: "#F97316" },
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const container = document.createElement("div");
  container.className = "terminal-instance";
  container.dataset.terminalId = terminalId;

  const emptyState = document.getElementById("board-terminal-empty");
  if (emptyState) emptyState.style.display = "none";
  document.querySelectorAll("#board-terminal-instances .terminal-instance").forEach(c => c.style.display = "none");
  document.getElementById("board-terminal-instances").appendChild(container);
  container.style.display = "block";

  const tab = document.createElement("button");
  tab.className = "terminal-tab active";
  tab.dataset.terminalId = terminalId;
  tab.innerHTML = `${esc(name)} <span class="tab-close" data-terminal-id="${terminalId}">&times;</span>`;
  document.querySelectorAll("#board-terminal-tabs .terminal-tab").forEach(t => t.classList.remove("active"));
  document.getElementById("board-terminal-tabs").appendChild(tab);

  void container.offsetHeight;
  term.open(container);
  fitAddon.fit();
  const { cols, rows } = term;
  invoke("resize_terminal", { terminalId, cols, rows }).catch(() => {});
  term.focus();

  term.onData(data => {
    invoke("write_terminal", { terminalId, data }).catch(() => {});
  });

  state.terminals[terminalId] = { term, fitAddon, tabEl: tab, containerEl: container, name };
  state.activeTerminal = terminalId;
}

async function detectDeployEnvironment() {
  const info = document.getElementById("deploy-detection-info");
  if (!info) return;
  info.classList.remove("hidden");
  info.innerHTML = '<span class="text-muted">Detecting...</span>';

  try {
    const env = await invoke("detect_deploy_env");
    let html = "";

    // Docker
    if (env.docker.installed) {
      html += `<div class="detect-item detect-ok">&#10004; Docker: ${esc(env.docker.version)}</div>`;
      html += `<div class="detect-item ${env.docker.running ? 'detect-ok' : 'detect-warn'}">
        ${env.docker.running ? '&#10004;' : '&#9888;'} Docker Daemon: ${env.docker.running ? 'Running' : 'Not Running'}</div>`;
      html += `<div class="detect-item ${env.docker.composeAvailable ? 'detect-ok' : 'detect-warn'}">
        ${env.docker.composeAvailable ? '&#10004;' : '&#9888;'} Docker Compose: ${env.docker.composeAvailable ? 'Available' : 'Not Found'}</div>`;
    } else {
      html += '<div class="detect-item detect-missing">&#10008; Docker: Not Installed</div>';
    }

    // Compose files
    if (env.composeFiles.length > 0) {
      html += `<div class="detect-item detect-ok">&#10004; Compose Files: ${env.composeFiles.map(esc).join(', ')}</div>`;
      // Auto-fill compose files
      const composeInput = document.getElementById("set-compose-files");
      if (composeInput && !composeInput.value) {
        composeInput.value = env.composeFiles.join(", ");
      }
    } else {
      html += '<div class="detect-item detect-missing">&#10008; No Compose files found</div>';
    }

    // Env files
    if (env.envFiles.length > 0) {
      html += `<div class="detect-item detect-ok">&#10004; Env Files: ${env.envFiles.map(esc).join(', ')}</div>`;
      const envInput = document.getElementById("set-env-file");
      if (envInput && !envInput.value && env.envFiles.length > 0) {
        envInput.value = env.envFiles[0];
      }
    }

    // SSH
    html += `<div class="detect-item ${env.sshAvailable ? 'detect-ok' : 'detect-missing'}">
      ${env.sshAvailable ? '&#10004;' : '&#10008;'} SSH: ${env.sshAvailable ? 'Available' : 'Not Found'}</div>`;
    if (env.sshKeys.length > 0) {
      html += `<div class="detect-item detect-ok">&#10004; SSH Keys: ${env.sshKeys.length} found</div>`;
    }

    // Project type
    if (env.hasCargoToml) html += '<div class="detect-item detect-ok">&#10004; Rust project (Cargo.toml)</div>';
    if (env.hasPackageJson) html += '<div class="detect-item detect-ok">&#10004; Node.js project (package.json)</div>';

    info.innerHTML = html;
  } catch (e) {
    info.innerHTML = `<div class="detect-item detect-warn">&#9888; Detection failed: ${esc(String(e))}</div>`;
  }
}

function loadDeploySettingsForm() {
  const cfg = state.deployConfig;
  if (!cfg) return;
  const el = (id) => document.getElementById(id);
  if (el("set-deploy-type")) el("set-deploy-type").value = cfg.deployType || "compose";
  if (el("set-compose-files")) el("set-compose-files").value = (cfg.composeFiles || []).join(", ");
  if (el("set-env-file")) el("set-env-file").value = cfg.envFile || "";
  if (el("set-local-url")) el("set-local-url").value = cfg.localUrl || "";
  if (el("set-live-enabled")) el("set-live-enabled").checked = !!cfg.liveEnabled;
  if (el("set-ssh-host")) el("set-ssh-host").value = cfg.sshHost || "";
  if (el("set-ssh-key")) el("set-ssh-key").value = cfg.sshKey || "";
  if (el("set-ssh-port")) el("set-ssh-port").value = cfg.sshPort || 22;
  if (el("set-server-path")) el("set-server-path").value = cfg.serverPath || "";
  if (el("set-server-branch")) el("set-server-branch").value = cfg.serverBranch || "main";
  if (el("set-pre-commands")) el("set-pre-commands").value = (cfg.preCommands || []).join("\n");
  if (el("set-deploy-commands")) el("set-deploy-commands").value = (cfg.deployCommands || []).join("\n");
  if (el("set-post-commands")) el("set-post-commands").value = (cfg.postCommands || []).join("\n");
  if (el("set-live-url")) el("set-live-url").value = cfg.liveUrl || "";

  // Toggle live settings panel
  const livePanel = document.getElementById("live-settings-panel");
  if (livePanel) livePanel.classList.toggle("collapsed", !cfg.liveEnabled);
}

async function saveDeploySettingsForm() {
  const el = (id) => document.getElementById(id);
  const config = {
    deployType: el("set-deploy-type")?.value || "compose",
    composeFiles: (el("set-compose-files")?.value || "").split(",").map(s => s.trim()).filter(Boolean),
    envFile: el("set-env-file")?.value?.trim() || "",
    localUrl: el("set-local-url")?.value?.trim() || "",
    liveEnabled: el("set-live-enabled")?.checked || false,
    sshHost: el("set-ssh-host")?.value?.trim() || "",
    sshKey: el("set-ssh-key")?.value?.trim() || "",
    sshPort: parseInt(el("set-ssh-port")?.value) || 22,
    serverPath: el("set-server-path")?.value?.trim() || "",
    serverBranch: el("set-server-branch")?.value?.trim() || "main",
    preCommands: (el("set-pre-commands")?.value || "").split("\n").map(s => s.trim()).filter(Boolean),
    deployCommands: (el("set-deploy-commands")?.value || "").split("\n").map(s => s.trim()).filter(Boolean),
    postCommands: (el("set-post-commands")?.value || "").split("\n").map(s => s.trim()).filter(Boolean),
    liveUrl: el("set-live-url")?.value?.trim() || "",
  };

  try {
    await invoke("save_deploy_config", { config });
    state.deployConfig = config;
    updateDeployButtons();
  } catch (e) {
    appendLog("Save deploy config error: " + e, true);
  }
}

// ── Modal Helpers ──
function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

// ── Utilities ──
function esc(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function shellEscape(s) {
  if (!s) return "''";
  if (/^[a-zA-Z0-9._\-\/~@:+]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function validateDeployParam(name, value) {
  if (!value) return true;
  if (/[;\|&\$`\n\r\0]/.test(value)) {
    appendLog(`Security: ${name} contains forbidden characters`, true);
    return false;
  }
  return true;
}

function timeAgo(dateStr) {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);

    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  } catch {
    return "";
  }
}
