// ── Tauri IPC ──
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ── Modules ──
import { debounce, esc, withGuard, logError } from './utils.js';
import { installErrorHandler } from './error-handler.js';
import { renderBoard, applyFilters, restoreFilters, toggleFilterBar, clearFilters, closeContextMenu, handleContextMenuAction, exportCurrentLog, loadArchiveView } from './board.js';
import { openDetailPanel, closeDetailPanel, saveDetailTicket, deleteDetailTicket, setupCommentListeners } from './detail.js';
import { loadGitView, setupGitListeners, checkGitStatus } from './git.js';
import { setupTerminalListeners, openTicketTerminal, toggleTerminalView, toggleBoardTerminalPanel, cleanupTerminal, cleanupPageTerminal, refitPageTerminal } from './terminal.js';
import { loadSettingsForm, saveSettingsForm, openBackupModal, setupModelPresetListener, setupSettingsTabs } from './settings.js';
import { loadStatistics } from './statistics.js';
import { loadDashboard, stopBuildPoll, loadTemplatesForModal, setupTemplateListener, setupImportExportListeners } from './dashboard.js';
import { loadActivityView, setupActivityListeners } from './activity.js';
import { loadAgents, loadCommands, newAgentFlow, saveAgentEditor, deleteAgentEditor, setupAgentEditorClose, newCommandFlow, saveCommandEditor, deleteCommandEditor, setupCommandEditorClose } from './editors.js';
import { setupDeployListeners, loadDeployConfig } from './deploy.js';
import { setupBugSyncListeners, updateBugSyncBadge } from './bugsync.js';
import { t, setLocale, onLocaleChange, translateDOM } from './i18n.js';

// ── Extracted Modules ──
import { notifyDesktop, playSound, showToast, setupNotifCenter } from './notifications.js';
import { openProjectPicker, switchProject, addProjectFlow, updateSidebar, loadClaudeUsage } from './projects.js';
import { enterFocusMode, exitFocusMode } from './focus-mode.js';
import { loadNotesView } from './notes.js';
import { checkTicketRecovery } from './recovery.js';
import { openSearchSpotlight, closeSearchSpotlight, globalSearch } from './search.js';

// ── Re-exports for other modules ──
export { showToast } from './notifications.js';

// ── Local State (shared with all modules) ──
/** Globales State-Objekt, das von allen Frontend-Modulen geteilt wird. */
export const state = {
  board: { project_name: "", tickets: [] },
  project: null,
  projects: [],
  settings: {},
  runningTicket: null,
  detailTicket: null,
  progressLines: {},
  editingAgent: null,
  editingCommand: null,
  // Terminal (board panel)
  terminals: {},
  activeTerminal: null,
  terminalCounter: 0,
  // Terminal (page view)
  pageTerminals: {},
  activePageTerminal: null,
  pageTerminalCounter: 0,
  // Deploy
  deployConfig: null,
  deployingLocal: false,
  deployingLive: false,
  // Bug-Sync
  bugSyncCount: 0,
};

// ── Init ──
document.addEventListener("DOMContentLoaded", async () => {
  installErrorHandler();
  await loadInitialState();
  bindEvents();
  bindKeyboardShortcuts();
  await setupListeners();
  setupTerminalListeners();
  setupGitListeners();
  setupActivityListeners();
  setupCommentListeners();
  setupModelPresetListener();
  setupSettingsTabs();
  setupNotifCenter();
  setupTemplateListener();
  setupImportExportListeners();
  setupDeployListeners();
  setupBugSyncListeners();
  loadDeployConfig();
  restoreFilters();
  renderBoard();
  refreshUndoState();
  updateSidebar();
  checkGitStatus();
  updateGitWarnings();
  loadClaudeUsage();
  setInterval(loadClaudeUsage, 60_000);
  setInterval(updateStatusBar, 30000);

  // Check for interrupted ticket (crash recovery)
  checkTicketRecovery();
});

async function loadInitialState() {
  try {
    state.board = await invoke("get_board");
    state.project = await invoke("get_current_project");
    state.projects = await invoke("get_projects");
    state.settings = await invoke("get_settings");
    if (state.settings.bug_sync) {
      state.settings.bug_sync.api_token_set = !!state.settings.bug_sync.api_token;
      state.settings.bug_sync.api_token = ""; // clear sentinel from backend
    }
    if (state.settings.github) {
      state.settings.github.token_set = !!state.settings.github.token;
      state.settings.github.token = ""; // clear sentinel from backend
    }
    state.runningTicket = await invoke("get_running_ticket");

    // Apply theme from settings
    if (state.settings.theme) {
      document.body.dataset.theme = state.settings.theme;
      updateThemeUI();
    }

    // Apply language from settings
    setLocale(state.settings.language || 'de');

    // Re-render active views on locale change
    onLocaleChange(() => {
      renderBoard();
      translateDOM();
    });

    // Apply accent color
    applyAccentColor(state.settings.accent_color || state.settings.accentColor);

    // Username in header
    const projectName = state.project?.name || "";
    const initial = (projectName[0] || "U").toUpperCase();
    const displayName = projectName || "User";
    const usernameEl = document.getElementById("header-username");
    const avatarEl   = document.getElementById("header-avatar");
    if (usernameEl) usernameEl.textContent = displayName;
    if (avatarEl)   avatarEl.textContent = initial;

    // App version
    try {
      const version = await invoke("get_version");
      const vEl = document.getElementById("app-version");
      if (vEl) vEl.textContent = "v" + version;
      const svEl = document.getElementById("settings-version");
      if (svEl) svEl.textContent = "Version " + version;
      const sbEl = document.getElementById("status-version");
      if (sbEl) sbEl.textContent = "v" + version;
    } catch (_) { /* non-critical */ }

    // Update status bar git info
    updateStatusBar();

    // Request notification permission
    if (state.settings.notifications_enabled !== false) {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    }
  } catch (e) {
    appendLog("Initialisierung fehlgeschlagen: " + e, true);
  }
}

// ── Event Bindings ──
function bindEvents() {
  // Navigation — sidebar
  document.querySelectorAll(".nav-item[data-view]").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // Theme toggle
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  document.getElementById("btn-app-settings").addEventListener("click", () => switchView("settings"));

  // Search Spotlight
  document.getElementById("btn-open-search")?.addEventListener("click", openSearchSpotlight);
  const debouncedGlobalSearch = debounce(globalSearch, 200);
  const searchInput = document.getElementById("global-search-input");
  searchInput?.addEventListener("input", debouncedGlobalSearch);
  // Close overlay on backdrop click or Escape
  document.querySelector(".search-overlay-backdrop")?.addEventListener("click", closeSearchSpotlight);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-spotlight") && !e.target.closest("#btn-open-search")) {
      closeSearchSpotlight();
    }
  });

  // Header "+ Create Project" button
  document.getElementById("btn-header-add-project")?.addEventListener("click", openProjectPicker);

  // Project selector
  document.getElementById("project-selector").addEventListener("click", openProjectPicker);

  // Undo / Redo
  document.getElementById("btn-undo").addEventListener("click", performUndo);
  document.getElementById("btn-redo").addEventListener("click", performRedo);

  // New task
  document.getElementById("btn-new-task").addEventListener("click", openNewTaskModal);
  document.getElementById("btn-backlog-add")?.addEventListener("click", openNewTaskModal);
  document.getElementById("btn-archive-done")?.addEventListener("click", archiveAllDoneTickets);
  document.getElementById("btn-create-task").addEventListener("click", createTask);
  document.getElementById("new-task-type").addEventListener("change", updateTaskHelper);
  document.getElementById("new-task-desc").addEventListener("input", debounce(updateTaskHelper, 300));
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

  // Review modal
  document.querySelector("#modal-review .modal-close").addEventListener("click", () => closeModal("modal-review"));
  document.querySelector("#modal-review .modal-backdrop").addEventListener("click", () => closeModal("modal-review"));

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
  document.getElementById("set-bugsync-interval")?.addEventListener("input", (e) => {
    const v = parseInt(e.target.value);
    document.getElementById("bugsync-interval-label").textContent = v >= 60 ? Math.round(v / 60) + " min" : v + " s";
  });
  document.getElementById("set-github-interval")?.addEventListener("input", (e) => {
    document.getElementById("github-interval-label").textContent = e.target.value + "s";
  });
  document.getElementById("btn-open-backups").addEventListener("click", openBackupModal);

  // Filter bar (debounced)
  document.getElementById("btn-filter-toggle").addEventListener("click", toggleFilterBar);
  document.getElementById("filter-input").addEventListener("input", debounce(applyFilters, 150));
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
  document.getElementById("context-menu").addEventListener("click", handleContextMenuAction);

  // Agent editor
  document.getElementById("btn-new-agent").addEventListener("click", newAgentFlow);
  document.getElementById("btn-save-agent").addEventListener("click", saveAgentEditor);
  document.getElementById("btn-delete-agent").addEventListener("click", deleteAgentEditor);
  setupAgentEditorClose();

  // Command editor
  document.getElementById("btn-new-command").addEventListener("click", newCommandFlow);
  document.getElementById("btn-save-command").addEventListener("click", saveCommandEditor);
  document.getElementById("btn-delete-command").addEventListener("click", deleteCommandEditor);
  setupCommandEditorClose();

  // Window controls (custom titlebar)
  document.getElementById("win-minimize")?.addEventListener("click", () => getCurrentWindow().minimize());
  document.getElementById("win-maximize")?.addEventListener("click", async () => {
    const win = getCurrentWindow();
    if (await win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  document.getElementById("win-close")?.addEventListener("click", () => getCurrentWindow().close());
}

// ── Keyboard Shortcuts ──
function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    const tag = e.target.tagName;
    if (e.key === "Escape") {
      closeSearchSpotlight();
      closeAllModals();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") e.target.blur();
      return;
    }

    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case "k":
          e.preventDefault();
          openSearchSpotlight();
          break;
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
        case "z":
          e.preventDefault();
          performUndo();
          break;
        case "y":
          e.preventDefault();
          performRedo();
          break;
      }
      return;
    }

    if (e.key === "Escape") {
      closeAllModals();
    } else if (e.key === "?") {
      toggleModal("shortcut-help");
    } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) {
      handleBoardKeyNav(e);
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

  await listen("terminal-output", (event) => {
    const { terminalId, data } = event.payload;
    const inst = state.terminals[terminalId] || state.pageTerminals[terminalId];
    if (inst) {
      inst.term.write(data);
      if (inst.onOutput) inst.onOutput(data);
    }
  });

  await listen("terminal-closed", (event) => {
    const { terminalId } = event.payload;
    if (state.pageTerminals[terminalId]) {
      cleanupPageTerminal(terminalId);
    } else {
      cleanupTerminal(terminalId);
    }
  });

  await listen("bug-sync-available", (event) => {
    const count = event.payload;
    updateBugSyncBadge(count);
    appendLog(`Bug-Sync: ${count} neue Bugs im Portal verfuegbar`);
  });
}

// ── View Routing ──
/** Wechselt die aktive Ansicht und laedt ggf. Inhalte der Ziel-View nach (Lazy Loading).
 * @param {string} name - Name der Ziel-Ansicht (z.B. "board", "git", "settings").
 */
export function switchView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.add("active");

  document.querySelectorAll(".nav-item[data-view]").forEach(b => b.classList.remove("active"));
  const nav = document.querySelector(`.nav-item[data-view="${name}"]`);
  if (nav) nav.classList.add("active");

  // Stop build polling when leaving dashboard
  if (name !== "dashboard") stopBuildPoll();

  // Hide board terminal panel on Terminal page (would be redundant)
  const boardPanel = document.getElementById("board-terminal-panel");
  if (boardPanel) {
    boardPanel.style.display = name === "terminal" ? "none" : "";
  }

  // Lazy-load view content
  if (name === "agents") loadAgents();
  if (name === "commands") loadCommands();
  if (name === "settings") loadSettingsForm();
  if (name === "statistics") loadStatistics();
  if (name === "git") loadGitView();
  if (name === "activity") loadActivityView();
  if (name === "dashboard") loadDashboard();
  if (name === "archive") loadArchiveView();
  if (name === "notes") loadNotesView();
  if (name === "terminal") refitPageTerminal();

  // Update git warnings when switching views
  updateGitWarnings();
}

// ── Archive ──
async function archiveAllDoneTickets() {
  const doneTickets = (state.board.tickets || []).filter(t => t.column === "done");
  if (doneTickets.length === 0) {
    showToast("Keine erledigten Tickets zum Archivieren", "info");
    return;
  }
  if (!confirm(`${doneTickets.length} erledigte Tickets archivieren?`)) return;
  try {
    for (const t of doneTickets) {
      await invoke("archive_ticket", { ticketId: t.id });
    }
    state.board = await invoke("get_board");
    renderBoard();
    showToast(`${doneTickets.length} Tickets archiviert`, "success");
  } catch (err) {
    appendLog("Archive error: " + err, true);
  }
}

// ── Execution ──
/** Zeigt den Bestaetigungsdialog zum Ausfuehren eines Tickets mit Modell-Empfehlung und Auswahl.
 * @param {object} ticket - Das auszufuehrende Ticket-Objekt.
 */
export function confirmExecute(ticket) {
  const isCodeChanging = ticket.ticket_type === "feature" || ticket.ticket_type === "bugfix";
  const warning = isCodeChanging ? " \u26A0 Dieses Ticket \u00E4ndert Code." : "";
  document.getElementById("confirm-message").textContent =
    `Execute ticket ${ticket.id} - "${ticket.title}"?${warning}`;
  const modelSelect = document.getElementById("confirm-model-select");

  // Model recommendation based on ticket type
  const rec = getModelRecommendation(ticket.ticket_type);
  modelSelect.value = modelToFlag(rec.model);
  const hintEl = document.getElementById("model-recommendation-hint");
  if (hintEl) {
    hintEl.textContent = rec.hint;
    hintEl.className = "model-hint model-hint-" + rec.level;
  }

  document.getElementById("btn-confirm-yes").onclick = () => {
    const selectedModel = modelSelect.value;
    closeModal("modal-confirm");
    executeTicket(ticket.id, selectedModel);
  };
  openModal("modal-confirm");
}

function getModelRecommendation(ticketType) {
  switch (ticketType) {
    case "security":
      return { model: "claude-opus-4-6", hint: "Opus empfohlen \u2014 tiefe Analyse, Edge Cases", level: "opus" };
    case "feature":
      return { model: "claude-opus-4-6", hint: "Opus empfohlen \u2014 komplexe Architektur", level: "opus" };
    case "bugfix":
      return { model: "claude-sonnet-4-6", hint: "Sonnet empfohlen \u2014 schnell, klar definiert", level: "sonnet" };
    case "docs":
      return { model: "claude-sonnet-4-6", hint: "Sonnet empfohlen \u2014 Textarbeit", level: "sonnet" };
    default:
      return { model: state.settings.claude_model || "claude-sonnet-4-6", hint: "", level: "default" };
  }
}

/** Normalisiert einen Modell-Kurznamen (z.B. "sonnet") oder Legacy-ID zu einer vollstaendigen Modell-ID.
 * @param {string} model - Kurzname oder vollstaendige Modell-ID.
 * @returns {string} Vollstaendige Modell-ID.
 */
export function modelToFlag(model) {
  const compat = {
    sonnet: "claude-sonnet-4-6", "sonnet-1m": "claude-sonnet-4-6[1m]",
    opus: "claude-opus-4-6", "opus-1m": "claude-opus-4-6[1m]",
    haiku: "claude-haiku-4-5-20251001"
  };
  return compat[model] || model || "claude-sonnet-4-6";
}

const executeTicket = withGuard(async function(ticketId, model) {
  const ticket = (state.board.tickets || []).find(t => t.id === ticketId);
  const ticketTitle = ticket ? ticket.title : ticketId;
  const selectedModel = model || state.settings.claude_model || "claude-sonnet-4-6";

  state.runningTicket = ticketId;
  renderBoard();

  try {
    appendLog(`Starting ${ticketId} - ${ticketTitle}...`);
    const result = await invoke("start_ticket", { ticketId, model: selectedModel });
    appendLog(`Branch: ${result.branch}`);
    try {
      await openTicketTerminal(result, selectedModel);
      // Activate focus mode
      enterFocusMode(ticket, result.branch, selectedModel, finishTicket);
    } catch (termErr) {
      appendLog("Terminal error: " + termErr, true);
      showToast(t('toast.terminalFailed'), "error");
    }
  } catch (err) {
    state.runningTicket = null;
    // Sync backend state — running_ticket may need clearing
    invoke("get_running_ticket").then(rt => { state.runningTicket = rt; }).catch(e => logError("get_running_ticket", e));
    appendLog("Start error: " + err, true);
    notifyDesktop(t('notify.error'), t('notify.failed', {title: ticketTitle}), state.settings);
    playSound("error", state.settings);
    refreshBoard();
  }
});

/** Oeffnet den Review-Diff-Dialog zum Abschliessen eines Tickets (Ticket wechselt nach Bestaetigung zu Done).
 * @param {string} ticketId - ID des abzuschliessenden Tickets.
 */
export async function finishTicket(ticketId) {
  // Open review modal instead of immediately finishing
  await openReviewModal(ticketId);
}

async function openReviewModal(ticketId) {
  const ticket = (state.board.tickets || []).find(t => t.id === ticketId);
  const title = ticket ? `Review: ${ticketId} - ${ticket.title}` : `Review: ${ticketId}`;
  document.getElementById("review-title").textContent = title;

  const fileList = document.getElementById("review-file-list");
  const diffPreview = document.getElementById("review-diff-preview");
  fileList.innerHTML = '<p class="empty-state">Loading...</p>';
  diffPreview.innerHTML = '<p class="empty-state">Datei anklicken f\u00FCr Diff-Vorschau</p>';

  const tokensInput = document.getElementById("review-tokens-input");
  const costInput = document.getElementById("review-cost-input");
  if (tokensInput) tokensInput.value = "";
  if (costInput) costInput.value = "";

  openModal("modal-review");

  try {
    const diff = await invoke("get_working_diff");

    if (diff.files.length === 0) {
      fileList.innerHTML = '<p class="empty-state">Keine \u00C4nderungen gefunden</p>';
    } else {
      fileList.innerHTML = `
        <div class="review-stats">
          <span class="stat-add">+${diff.totalAdditions}</span> / <span class="stat-del">-${diff.totalDeletions}</span>
          \u2014 ${diff.files.length} Dateien ge\u00E4ndert
        </div>
      ` + diff.files.map(f => `
        <div class="review-file-item" data-file="${esc(f.filePath)}">
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
            const fileDiff = await invoke("get_working_file_diff", { filePath: el.dataset.file });
            if (!fileDiff.trim()) {
              diffPreview.innerHTML = '<p class="empty-state">(keine Diff-Daten)</p>';
            } else {
              diffPreview.innerHTML = `<pre class="review-diff-body">${renderDiffLines(fileDiff)}</pre>`;
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

  // Confirm button (guarded against double-click)
  const confirmBtn = document.getElementById("btn-review-confirm");
  confirmBtn.onclick = async () => {
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    const tokensVal = document.getElementById("review-tokens-input")?.value;
    const costVal = document.getElementById("review-cost-input")?.value;
    const tokensUsed = tokensVal && tokensVal.trim() !== "" ? Math.round(parseFloat(tokensVal)) : null;
    const costUsd = costVal && costVal.trim() !== "" ? parseFloat(costVal) : null;
    closeModal("modal-review");
    try {
      appendLog(`Finishing ${ticketId}...`);
      await invoke("finish_ticket", { ticketId, tokensUsed, costUsd });
      state.runningTicket = null;
      appendLog(`\u2713 ${ticketId} -> Done`);
      showToast(t('toast.ticketDone', {id: ticketId}), "success");
      notifyDesktop(t('notify.ticketDone'), t('notify.ticketFinished', {id: ticketId}), state.settings);
      playSound("success", state.settings);
      refreshBoard();
    } catch (err) {
      appendLog("Finish error: " + err, true);
    } finally {
      confirmBtn.disabled = false;
    }
  };

  // Cancel button
  document.getElementById("btn-review-cancel").onclick = () => {
    closeModal("modal-review");
  };
}

function renderDiffLines(diff) {
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

/** Fuehrt einen Ticket-Branch nach Benutzerbestaetigung in den Hauptbranch zusammen (gegen Doppelklick gesichert).
 * @param {string} ticketId - ID des zu mergenden Tickets.
 */
export const mergeTicket = withGuard(async function(ticketId) {
  if (!confirm(`Ticket ${ticketId} \u00FCbernehmen?\nDie \u00C4nderungen werden in den Hauptbranch \u00FCbernommen.`)) return;
  try {
    appendLog(`Merging ${ticketId}...`);
    await invoke("merge_ticket", { ticketId });
    appendLog(`\u2713 ${ticketId} merged successfully`);
    showToast(t('toast.ticketMerged', {id: ticketId}), "success");
    refreshBoard();
  } catch (err) {
    appendLog("Merge error: " + err, true);
  }
});

// ── Board Refresh ──
/** Holt den aktuellen Board-State vom Backend und rendert das Board neu. Beendet den Focus-Modus wenn kein Ticket laeuft. */
export async function refreshBoard() {
  try {
    state.board = await invoke("get_board");
    state.runningTicket = await invoke("get_running_ticket");
    renderBoard();
    refreshUndoState();
    // Exit focus mode if ticket no longer running
    if (!state.runningTicket) exitFocusMode();
  } catch (e) {
    logError("Failed to refresh board", e);
  }
}

// ── Undo / Redo ──

async function performUndo() {
  try {
    const result = await invoke("undo_action");
    state.board = await invoke("get_board");
    renderBoard();
    updateUndoButtons(result);
    showToast(t('undo.undone') || "Rückgängig gemacht", "success");
  } catch (err) {
    if (!String(err).includes("Nichts")) appendLog("Undo: " + err, true);
  }
}

async function performRedo() {
  try {
    const result = await invoke("redo_action");
    state.board = await invoke("get_board");
    renderBoard();
    updateUndoButtons(result);
    showToast(t('undo.redone') || "Wiederhergestellt", "success");
  } catch (err) {
    if (!String(err).includes("Nichts")) appendLog("Redo: " + err, true);
  }
}

function updateUndoButtons(undoState) {
  const undoBtn = document.getElementById("btn-undo");
  const redoBtn = document.getElementById("btn-redo");
  if (undoBtn) {
    undoBtn.disabled = !undoState.canUndo;
    undoBtn.title = undoState.undoDescription
      ? (t('undo.undo') || "Rückgängig") + ": " + undoState.undoDescription
      : (t('undo.undo') || "Rückgängig") + " (Ctrl+Z)";
  }
  if (redoBtn) {
    redoBtn.disabled = !undoState.canRedo;
    redoBtn.title = undoState.redoDescription
      ? (t('undo.redo') || "Wiederherstellen") + ": " + undoState.redoDescription
      : (t('undo.redo') || "Wiederherstellen") + " (Ctrl+Y)";
  }
}

/** Aktualisiert Undo/Redo-Buttons nach Board-Aktionen. */
export async function refreshUndoState() {
  try {
    const result = await invoke("get_undo_state");
    updateUndoButtons(result);
  } catch (_) { /* non-critical */ }
}

// ── Log Panel ──
const LOG_MAX_LINES = 500;

/** Fuegt eine Zeile zum Log-Panel hinzu (max. 500 Zeilen). Fehler werden zusaetzlich als Toast angezeigt.
 * @param {string} text - Der anzuzeigende Text.
 * @param {boolean} [isError=false] - Wenn true, wird die Zeile als Fehler hervorgehoben.
 */
export function appendLog(text, isError = false) {
  const body = document.getElementById("log-body");
  const line = document.createElement("div");
  line.className = "log-line" + (isError ? " error" : "");
  line.textContent = text;
  body.appendChild(line);
  while (body.childElementCount > LOG_MAX_LINES) {
    body.removeChild(body.firstElementChild);
  }
  body.scrollTop = body.scrollHeight;

  // Also show toast for important messages
  if (isError) {
    showToast(text, "error");
  }
}

// ── Theme ──
function toggleTheme() {
  const current = document.body.dataset.theme;
  const next = current === "dark" ? "light" : "dark";
  document.body.dataset.theme = next;
  updateThemeUI();
  state.settings.theme = next;
  invoke("save_settings", { settings: state.settings }).catch(e => logError("save_settings", e));
}

/** Aktualisiert das Theme-Icon im Header passend zum aktiven Theme (dark/light). */
export function updateThemeUI() {
  const theme = document.body.dataset.theme;
  const matIcon = document.getElementById("theme-icon-mat");
  if (matIcon) matIcon.textContent = theme === "dark" ? "dark_mode" : "light_mode";
}

/** Setzt die Akzentfarbe als CSS-Custom-Properties (--accent, --accent-hover, --accent-glow) am body-Element.
 * @param {string} color - Hex-Farbwert, z.B. "#F97316".
 */
export function applyAccentColor(color) {
  if (!color) return;
  // Must set on body (which has data-theme) to override theme defaults
  const el = document.body;
  el.style.setProperty("--accent", color);
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const hover = `rgb(${Math.min(r + 20, 255)}, ${Math.min(g + 20, 255)}, ${Math.min(b + 20, 255)})`;
  el.style.setProperty("--accent-hover", hover);
  el.style.setProperty("--accent-glow", `rgba(${r}, ${g}, ${b}, 0.15)`);
  el.style.setProperty("--primary-container", hover);
}

// ── New Task Modal ──
function openNewTaskModal() {
  document.getElementById("new-task-title").value = "";
  document.getElementById("new-task-type").value = "feature";
  document.getElementById("new-task-prio").value = "";
  document.getElementById("new-task-desc").value = "";
  document.getElementById("new-task-template").value = "";
  loadTemplatesForModal();
  updateTaskHelper();
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

// ── Modal Helpers ──
/** Entfernt die "hidden"-Klasse von einem Modal-Element, um es anzuzeigen.
 * @param {string} id - Die Element-ID des Modals.
 */
export function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

/** Fuegt die "hidden"-Klasse zu einem Modal-Element hinzu, um es auszublenden.
 * @param {string} id - Die Element-ID des Modals.
 */
export function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

// ── Board Keyboard Navigation ──
function handleBoardKeyNav(e) {
  // Only active when board view is visible
  const boardView = document.getElementById("view-board");
  if (!boardView || !boardView.classList.contains("active")) return;

  const focused = document.querySelector(".ticket-card.kb-focus");
  const columns = ["backlog", "progress", "review", "done"];

  if (!focused) {
    // No card focused — focus first card
    if (e.key === "ArrowDown" || e.key === "Enter") {
      const first = document.querySelector(".ticket-card");
      if (first) {
        e.preventDefault();
        first.classList.add("kb-focus");
        first.scrollIntoView({ block: "nearest" });
      }
    }
    return;
  }

  e.preventDefault();
  const col = focused.closest(".column-body")?.dataset.drop;
  const colIdx = columns.indexOf(col);
  const cards = [...(document.querySelector(`[data-drop="${col}"]`)?.querySelectorAll(".ticket-card") || [])];
  const cardIdx = cards.indexOf(focused);

  if (e.key === "ArrowDown") {
    if (cardIdx < cards.length - 1) {
      focused.classList.remove("kb-focus");
      cards[cardIdx + 1].classList.add("kb-focus");
      cards[cardIdx + 1].scrollIntoView({ block: "nearest" });
    }
  } else if (e.key === "ArrowUp") {
    if (cardIdx > 0) {
      focused.classList.remove("kb-focus");
      cards[cardIdx - 1].classList.add("kb-focus");
      cards[cardIdx - 1].scrollIntoView({ block: "nearest" });
    }
  } else if (e.key === "ArrowRight") {
    if (colIdx < columns.length - 1) {
      const nextCol = columns[colIdx + 1];
      const nextCards = document.querySelector(`[data-drop="${nextCol}"]`)?.querySelectorAll(".ticket-card");
      if (nextCards && nextCards.length > 0) {
        focused.classList.remove("kb-focus");
        const target = nextCards[Math.min(cardIdx, nextCards.length - 1)];
        target.classList.add("kb-focus");
        target.scrollIntoView({ block: "nearest" });
      }
    }
  } else if (e.key === "ArrowLeft") {
    if (colIdx > 0) {
      const prevCol = columns[colIdx - 1];
      const prevCards = document.querySelector(`[data-drop="${prevCol}"]`)?.querySelectorAll(".ticket-card");
      if (prevCards && prevCards.length > 0) {
        focused.classList.remove("kb-focus");
        const target = prevCards[Math.min(cardIdx, prevCards.length - 1)];
        target.classList.add("kb-focus");
        target.scrollIntoView({ block: "nearest" });
      }
    }
  } else if (e.key === "Enter") {
    const ticketId = focused.dataset.ticketId;
    const ticket = (state.board.tickets || []).find(t => t.id === ticketId);
    if (ticket) openDetailPanel(ticket);
  }
}

// ── Task Helper (Tipps beim Ticket erstellen) ──
function updateTaskHelper() {
  const helper = document.getElementById("task-helper");
  if (!helper) return;

  const type = document.getElementById("new-task-type").value;
  const desc = document.getElementById("new-task-desc").value;

  const tips = [];
  const checks = [];

  // Typ-spezifische Tipps
  if (type === "feature") {
    tips.push("\u{1F4A1} Beschreibe welche Dateien betroffen sind (z.B. src/controllers/userController.js)");
    tips.push("\u{1F4A1} Nenne den gew\u00FCnschten Endpunkt oder die UI-Komponente");
    if (!desc.match(/\.(js|rs|ts|html|css|py)/)) checks.push("\u26A0 Keine Dateipfade in der Beschreibung \u2014 Claude muss die Codebase durchsuchen (mehr Tokens)");
  } else if (type === "bugfix") {
    tips.push("\u{1F41B} Beschreibe das erwartete vs. tats\u00E4chliche Verhalten");
    tips.push("\u{1F41B} Nenne die betroffene Datei/Funktion wenn bekannt");
    if (!desc.match(/Datei|datei|file|\.js|\.rs|\.ts|controller|function|Funktion/i)) checks.push("\u26A0 Betroffene Datei/Funktion nicht genannt \u2014 hilft Claude den Bug schneller zu finden");
  } else if (type === "security") {
    tips.push("\u{1F512} Beschreibe den Angriffsvektor (z.B. SQL Injection, XSS)");
    tips.push("\u{1F512} Nenne die zu pr\u00FCfenden Dateien/Endpoints");
  } else if (type === "docs") {
    tips.push("\u{1F4C4} Nenne welche Dokumentation aktualisiert werden soll");
    tips.push("\u{1F4C4} Haiku-Modell reicht f\u00FCr Doku-Aufgaben (g\u00FCnstiger)");
  }

  // Allgemeine Checks
  if (desc.length > 0 && desc.length < 20) {
    checks.push("\u26A0 Beschreibung sehr kurz \u2014 je genauer, desto weniger Tokens verbraucht Claude");
  }
  if (desc.length === 0) {
    checks.push("\u26A0 Keine Beschreibung \u2014 Claude muss raten was gemeint ist");
  }
  if (desc.length > 50 && !checks.length) {
    checks.push("\u2713 Gute Beschreibung \u2014 spart Tokens und liefert bessere Ergebnisse");
  }

  helper.innerHTML = `
    <div class="helper-tips">${tips.map(t => `<div class="helper-tip">${t}</div>`).join("")}</div>
    ${checks.length ? `<div class="helper-checks">${checks.map(c => `<div class="helper-check">${c}</div>`).join("")}</div>` : ""}
  `;
}

// ── Git Warning Banner ──
/** Prueft den Git-Status und zeigt ggf. ein Warning-Banner an (kein Git-Repo, laufende Operation). */
export async function updateGitWarnings() {
  try {
    const status = await invoke("get_git_status");
    const banner = document.getElementById("git-warning-banner");
    if (!banner) return;

    if (!status.isGitRepo) {
      banner.textContent = t('git.noGitRepo');
      banner.className = "git-warning-banner warn visible";
    } else if (status.operationInProgress) {
      banner.innerHTML = `${esc(t('git.operationInProgress', {op: status.operationInProgress}))}
        ${status.operationInProgress === 'merge' ? `<button id="btn-abort-merge" class="btn-danger" style="margin-left:8px;padding:2px 8px;font-size:11px">${esc(t('git.abortMerge'))}</button>` : ''}`;
      banner.className = "git-warning-banner error visible";
      document.getElementById("btn-abort-merge")?.addEventListener("click", async () => {
        try {
          await invoke("abort_git_merge");
          showToast(t('git.mergeAborted'), "success");
          updateGitWarnings();
          checkGitStatus();
        } catch (e) {
          showToast(String(e), "error");
        }
      });
    } else if (status.isDetached) {
      banner.textContent = t('git.detachedHead');
      banner.className = "git-warning-banner warn visible";
    } else {
      banner.className = "git-warning-banner hidden";
    }
  } catch {
    // No project selected or other issue — hide banner
    const banner = document.getElementById("git-warning-banner");
    if (banner) banner.className = "git-warning-banner hidden";
  }
}

// ── Status Bar ──
async function updateStatusBar() {
  try {
    const info = await invoke("get_git_status");
    const branchEl = document.getElementById("status-git-branch");
    const dirtyEl  = document.getElementById("status-git-dirty");
    const syncEl   = document.getElementById("status-git-sync");
    const iconEl   = document.getElementById("status-git-icon");

    if (!info.isGitRepo) {
      if (branchEl) branchEl.textContent = "—";
      if (dirtyEl)  { dirtyEl.textContent = ""; dirtyEl.classList.add("hidden"); }
      if (syncEl)   { syncEl.textContent = "";  syncEl.classList.add("hidden"); }
      if (iconEl)   iconEl.textContent = "source_environment";
      return;
    }

    if (branchEl) branchEl.textContent = info.currentBranch || "HEAD";

    if (dirtyEl) {
      if (info.isDirty) {
        dirtyEl.textContent = " ●";
        dirtyEl.classList.remove("hidden");
      } else {
        dirtyEl.textContent = "";
        dirtyEl.classList.add("hidden");
      }
    }

    if (syncEl) {
      const parts = [];
      if (info.aheadCount > 0)  parts.push(`↑${info.aheadCount}`);
      if (info.behindCount > 0) parts.push(`↓${info.behindCount}`);
      if (parts.length > 0) {
        syncEl.textContent = " " + parts.join(" ");
        syncEl.classList.remove("hidden");
      } else {
        syncEl.textContent = "";
        syncEl.classList.add("hidden");
      }
    }

    if (iconEl) iconEl.textContent = info.isDirty ? "edit" : "source_environment";
  } catch (_) { /* non-critical */ }
}
