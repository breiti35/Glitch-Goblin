// ── Tauri IPC ──
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ── Modules ──
import { debounce, esc, withGuard, timeAgo } from './utils.js';
import { installErrorHandler } from './error-handler.js';
import { renderBoard, applyFilters, toggleFilterBar, clearFilters, closeContextMenu, handleContextMenuAction, exportCurrentLog } from './board.js';
import { openDetailPanel, closeDetailPanel, saveDetailTicket, deleteDetailTicket, setupCommentListeners } from './detail.js';
import { loadGitView, setupGitListeners, checkGitStatus } from './git.js';
import { setupTerminalListeners, openTicketTerminal, openBoardTerminal, toggleTerminalView, toggleBoardTerminalPanel, cleanupTerminal } from './terminal.js';
import { loadSettingsForm, saveSettingsForm, openBackupModal, setupModelPresetListener, setupSettingsTabs } from './settings.js';
import { loadStatistics } from './statistics.js';
import { loadDashboard, loadTemplatesForModal, setupTemplateListener, setupImportExportListeners } from './dashboard.js';
import { loadActivityView, setupActivityListeners } from './activity.js';
import { loadAgents, loadCommands, newAgentFlow, saveAgentEditor, deleteAgentEditor, newCommandFlow, saveCommandEditor, deleteCommandEditor } from './editors.js';
import { setupDeployListeners, loadDeployConfig } from './deploy.js';
import { setupBugSyncListeners, updateBugSyncBadge } from './bugsync.js';
import { t, setLocale, onLocaleChange, translateDOM } from './i18n.js';

// ── Re-export renderBoard for modules that need it ──
export { renderBoard } from './board.js';

// ── Sound Data URIs ──
const SOUNDS = {
  success: "data:audio/wav;base64,UklGRlQBAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YTABAAAAAAAlAEoAbACLAKgAwgDYAOoA9wAAAAUABQAAAAMA/v/2/+3/4f/V/8j/vP+x/6f/n/+Z/5X/lP+V/5r/ov+t/7r/yv/c//D/AAARACoAPABPAGIAdQCHAJYApACvALcAvAC+AL0AuACvAKIAkgB+AGQASABIAC8AEgD0/9T/sv+R/3D/UP8z/xj/AP/s/tz+0P7I/sT+xf7K/tP+4f7z/gj/IP88/1r/ev+d/8H/5v8LAC8AVABxAKAAuwDWAOoA+gAFAQoBC",
  error: "data:audio/wav;base64,UklGRlQBAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YTABAAAAAPj/4f/E/6P/gf9g/0D/JP8N//z+8f7u/vH+/P4O/yb/Rf9p/5L/vf/r/xoASAB1AKAA1QAAASkBSgFkAXUBfgF+AXUBZAFKAV8BKAHyALcAdwA1APIE1v+k/3D/Qf8V//D+0P60/p/+j/6F/oL+hf6O/p3+sv7M/uz+EP84/2P/kP/A//D/IgBTAIIArwDaAAAAJAFCAVoBawF2AXkBdAFoAVQBOAEWAe0AvgCKAFIAFwDZ/5b/"
};

// ── Local State (shared with all modules) ──
export const state = {
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
  renderBoard();
  updateSidebar();
  checkGitStatus();
  updateGitWarnings();
  loadClaudeUsage();
  setInterval(loadClaudeUsage, 120000);

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
      state.settings.bug_sync.api_token = "";
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
    } catch (_) { /* non-critical */ }

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
  // Navigation
  document.querySelectorAll(".nav-item[data-view]").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // Theme toggle
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  document.getElementById("btn-app-settings").addEventListener("click", () => switchView("settings"));

  // Global search with dropdown results
  const debouncedGlobalSearch = debounce(globalSearch, 200);
  const searchInput = document.getElementById("global-search-input");
  searchInput?.addEventListener("input", debouncedGlobalSearch);
  searchInput?.addEventListener("focus", globalSearch);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".global-search")) {
      document.getElementById("global-search-results")?.classList.add("hidden");
    }
  });

  // Header "+ Create Project" button
  document.getElementById("btn-header-add-project")?.addEventListener("click", openProjectPicker);

  // Project selector
  document.getElementById("project-selector").addEventListener("click", openProjectPicker);

  // New task
  document.getElementById("btn-new-task").addEventListener("click", openNewTaskModal);
  document.getElementById("btn-backlog-add")?.addEventListener("click", openNewTaskModal);
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

  // Command editor
  document.getElementById("btn-new-command").addEventListener("click", newCommandFlow);
  document.getElementById("btn-save-command").addEventListener("click", saveCommandEditor);
  document.getElementById("btn-delete-command").addEventListener("click", deleteCommandEditor);
}

// ── Keyboard Shortcuts ──
function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
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
    const inst = state.terminals[terminalId];
    if (inst) {
      inst.term.write(data);
      if (inst.onOutput) inst.onOutput(data);
    }
  });

  await listen("terminal-closed", (event) => {
    const { terminalId } = event.payload;
    cleanupTerminal(terminalId);
  });

  await listen("bug-sync-available", (event) => {
    const count = event.payload;
    updateBugSyncBadge(count);
    appendLog(`Bug-Sync: ${count} neue Bugs im Portal verfuegbar`);
  });
}

// ── View Routing ──
export function switchView(name) {
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

  // Update git warnings when switching views
  updateGitWarnings();
}

// ── Execution ──
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

export function modelToFlag(model) {
  const compat = { sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-6", haiku: "claude-haiku-4-5-20251001" };
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
      enterFocusMode(ticket, result.branch, selectedModel);
    } catch (termErr) {
      appendLog("Terminal error: " + termErr, true);
      showToast(t('toast.terminalFailed'), "error");
    }
  } catch (err) {
    state.runningTicket = null;
    // Sync backend state — running_ticket may need clearing
    invoke("get_running_ticket").then(rt => { state.runningTicket = rt; }).catch(() => {});
    appendLog("Start error: " + err, true);
    notifyDesktop(t('notify.error'), t('notify.failed', {title: ticketTitle}));
    playSound("error");
    refreshBoard();
  }
});

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
    closeModal("modal-review");
    try {
      appendLog(`Finishing ${ticketId}...`);
      await invoke("finish_ticket", { ticketId });
      state.runningTicket = null;
      appendLog(`\u2713 ${ticketId} -> Done`);
      showToast(t('toast.ticketDone', {id: ticketId}), "success");
      notifyDesktop(t('notify.ticketDone'), t('notify.ticketFinished', {id: ticketId}));
      playSound("success");
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

// ── Notifications ──
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

// ── Sounds ──
function playSound(name) {
  if (state.settings.sounds_enabled === false) return;
  const uri = SOUNDS[name];
  if (!uri) return;
  try {
    const audio = new Audio(uri);
    audio.volume = 0.5;
    audio.play().catch(() => { /* autoplay restricted */ });
  } catch (e) {
    console.warn("Sound failed:", e);
  }
}

// ── Board Refresh ──
export async function refreshBoard() {
  try {
    state.board = await invoke("get_board");
    state.runningTicket = await invoke("get_running_ticket");
    renderBoard();
    // Exit focus mode if ticket no longer running
    if (!state.runningTicket) exitFocusMode();
  } catch (e) {
    console.error("Failed to refresh board:", e);
  }
}

// ── Log Panel ──
const LOG_MAX_LINES = 500;

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

// ── Toast System ──
export function showToast(message, type = "info", duration = 3000) {
  // Also add to notification center
  addNotification(message, type);

  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const icons = { success: "\u2713", error: "\u2717", info: "\u24D8" };
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-text">${esc(message)}</span>`;

  container.appendChild(toast);

  // Trigger enter animation
  requestAnimationFrame(() => toast.classList.add("toast-visible"));

  // Auto-dismiss
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    // Fallback removal if transition doesn't fire
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

// ── Sidebar ──
function updateSidebar() {
  const nameEl = document.getElementById("sidebar-project-name");
  const pathEl = document.getElementById("sidebar-project-path");

  if (state.project) {
    nameEl.textContent = state.project.name;
    pathEl.textContent = state.project.path;
  } else {
    nameEl.textContent = t('header.noProject');
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

export function updateThemeUI() {
  const theme = document.body.dataset.theme;
  document.getElementById("theme-icon").textContent = theme === "dark" ? "\u263E" : "\u2600";
  document.getElementById("theme-label").textContent = theme === "dark" ? "Dark Mode" : "Light Mode";
}

export function applyAccentColor(color) {
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
    state.runningTicket = await invoke("get_running_ticket");
    closeModal("modal-picker");
    renderBoard();
    updateSidebar();
    checkGitStatus();
    updateGitWarnings();
    loadDeployConfig();
    loadClaudeUsage();

    // Reload the currently active view
    const activeView = document.querySelector(".view.active");
    if (activeView) {
      const viewName = activeView.id.replace("view-", "");
      if (viewName === "dashboard") loadDashboard();
      else if (viewName === "git") loadGitView();
      else if (viewName === "activity") loadActivityView();
      else if (viewName === "statistics") loadStatistics();
      else if (viewName === "settings") loadSettingsForm();
      else if (viewName === "agents") loadAgents();
      else if (viewName === "commands") loadCommands();
    }

    showToast(t('toast.projectLoaded', {name}), "success");
  } catch (err) {
    appendLog("Switch project error: " + err, true);
  }
}

async function removeProjectFlow(name) {
  if (!confirm(`Projekt "${name}" aus der Liste entfernen?\n(Die Dateien werden nicht gel\u00F6scht)`)) return;
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
export function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

export function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

// ── Claude Usage ──
async function loadClaudeUsage() {
  try {
    const usage = await invoke("get_claude_usage");
    updateUsageDisplay(usage);
  } catch (e) {
    // Usage unavailable (no credentials, offline, etc.)
    const container = document.getElementById("sidebar-usage");
    if (container) container.classList.add("hidden");
  }
}

function updateUsageDisplay(usage) {
  const container = document.getElementById("sidebar-usage");
  if (!container) return;
  container.classList.remove("hidden");

  // 5h bar
  const fill5h = document.getElementById("usage-5h-fill");
  const pct5h = document.getElementById("usage-5h-pct");
  if (fill5h && pct5h) {
    const val = Math.round(usage.fiveHour);
    fill5h.style.width = Math.min(val, 100) + "%";
    fill5h.className = "usage-bar-fill " + usageColor(val);
    pct5h.textContent = val + "%";
  }

  // 7d bar
  const fill7d = document.getElementById("usage-7d-fill");
  const pct7d = document.getElementById("usage-7d-pct");
  if (fill7d && pct7d) {
    const val = Math.round(usage.sevenDay);
    fill7d.style.width = Math.min(val, 100) + "%";
    fill7d.className = "usage-bar-fill " + usageColor(val);
    pct7d.textContent = val + "%";
  }
}

function usageColor(pct) {
  if (pct >= 90) return "usage-red";
  if (pct >= 70) return "usage-yellow";
  return "usage-green";
}

// ── Notification Center ──
const notifications = [];
const NOTIF_MAX = 50;

export function addNotification(message, type = "info") {
  notifications.unshift({ message, type, time: new Date() });
  if (notifications.length > NOTIF_MAX) notifications.pop();
  updateNotifBadge();
  renderNotifList();
}

function updateNotifBadge() {
  const badge = document.getElementById("header-notif-badge");
  if (badge) {
    const count = notifications.length;
    badge.textContent = count;
    badge.classList.toggle("hidden", count === 0);
  }
}

function renderNotifList() {
  const list = document.getElementById("notif-list");
  if (!list) return;
  if (notifications.length === 0) {
    list.innerHTML = `<p class="empty-state">${t('header.noNotifications')}</p>`;
    return;
  }
  list.innerHTML = notifications.map(n => {
    const icons = { success: "\u2713", error: "\u2717", info: "\u24D8", warning: "\u26A0" };
    const ago = timeAgo(n.time.toISOString());
    return `<div class="notif-item notif-${n.type}">
      <span class="notif-icon">${icons[n.type] || icons.info}</span>
      <span class="notif-text">${esc(n.message)}</span>
      <span class="notif-time">${ago}</span>
    </div>`;
  }).join("");
}

function setupNotifCenter() {
  document.getElementById("header-notif-btn")?.addEventListener("click", () => {
    const panel = document.getElementById("notif-panel");
    if (panel) {
      panel.classList.toggle("hidden");
      renderNotifList();
    }
  });
  document.getElementById("btn-notif-clear")?.addEventListener("click", () => {
    notifications.length = 0;
    updateNotifBadge();
    renderNotifList();
  });
  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".notif-wrapper")) {
      document.getElementById("notif-panel")?.classList.add("hidden");
    }
  });
}

// ── Crash Recovery ──
async function checkTicketRecovery() {
  // If a ticket is in "progress" with running_ticket set, but no terminal is open,
  // the app likely crashed. Show recovery dialog.
  if (!state.runningTicket) return;

  // No terminals running = app was restarted after crash
  if (Object.keys(state.terminals).length > 0) return;

  const ticket = (state.board.tickets || []).find(t => t.id === state.runningTicket);
  if (!ticket) return;

  document.getElementById("recovery-message").textContent =
    `Das Ticket "${ticket.id} \u2014 ${ticket.title}" war in Bearbeitung als die App geschlossen wurde.`;

  // Check git status on the branch
  const statusEl = document.getElementById("recovery-status");
  try {
    const diff = await invoke("get_working_diff");
    if (diff.files.length > 0) {
      statusEl.innerHTML = `<div class="recovery-info recovery-warn">
        <strong>${diff.files.length} Dateien mit \u00C4nderungen</strong> gefunden
        (+${diff.totalAdditions} / -${diff.totalDeletions})
      </div>`;
    } else {
      statusEl.innerHTML = `<div class="recovery-info recovery-ok">
        <strong>Keine uncommitteten \u00C4nderungen</strong> \u2014 Arbeit wurde vermutlich abgeschlossen
      </div>`;
    }
  } catch {
    statusEl.innerHTML = `<div class="recovery-info">Git-Status konnte nicht gepr\u00FCft werden</div>`;
  }

  // "Weiterarbeiten" — open terminal on branch
  document.getElementById("btn-recovery-continue").onclick = async () => {
    closeModal("modal-recovery");
    openBoardTerminal();
    showToast(t('toast.terminalOpened'), "info");
  };

  // "Abschließen" — commit + review
  document.getElementById("btn-recovery-finish").onclick = () => {
    closeModal("modal-recovery");
    finishTicket(ticket.id);
  };

  // "Zurück ins Backlog" — reset ticket
  document.getElementById("btn-recovery-reset").onclick = async () => {
    closeModal("modal-recovery");
    try {
      await invoke("move_ticket", { ticketId: ticket.id, targetColumn: "backlog" });
      state.runningTicket = null;
      state.board = await invoke("get_board");
      renderBoard();
      showToast(t('toast.backToBacklog', {id: ticket.id}), "info");
    } catch (err) {
      appendLog("Recovery error: " + err, true);
    }
  };

  openModal("modal-recovery");
}

// ── Focus Mode ──
let focusElapsedInterval = null;

function enterFocusMode(ticket, branch, model) {
  const focus = document.getElementById("focus-mode");
  if (!focus) return;

  document.getElementById("focus-ticket-id").textContent = ticket.id;
  document.getElementById("focus-ticket-title").textContent = ticket.title;
  document.getElementById("focus-ticket-desc").textContent = ticket.description || "";
  document.getElementById("focus-branch").textContent = branch || "\u2014";
  document.getElementById("focus-model").textContent = model || "\u2014";

  // Elapsed timer (shared between focus mode and terminal status bar)
  const startTime = Date.now();
  document.getElementById("focus-elapsed").textContent = "0:00";
  if (focusElapsedInterval) clearInterval(focusElapsedInterval);

  // Show terminal status bar
  const statusBar = document.getElementById("terminal-running-status");
  if (statusBar) {
    statusBar.classList.remove("hidden");
    document.getElementById("terminal-running-label").textContent = t('terminal.working', {id: ticket.id});
  }

  focusElapsedInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    const timeStr = `${min}:${sec.toString().padStart(2, "0")}`;
    document.getElementById("focus-elapsed").textContent = timeStr;
    const elapsedEl = document.getElementById("terminal-running-elapsed");
    if (elapsedEl) elapsedEl.textContent = timeStr;
  }, 1000);

  // Move active terminal into focus area
  const focusArea = document.getElementById("focus-terminal-area");
  if (state.activeTerminal && state.terminals[state.activeTerminal]) {
    const inst = state.terminals[state.activeTerminal];
    focusArea.innerHTML = "";
    focusArea.appendChild(inst.containerEl);
    inst.containerEl.style.display = "block";
    requestAnimationFrame(() => inst.fitAddon.fit());
  }

  // Quick note save
  document.getElementById("focus-notes-input").value = "";
  document.getElementById("btn-focus-note-save").onclick = async () => {
    const input = document.getElementById("focus-notes-input");
    const text = input.value.trim();
    if (!text || !state.runningTicket) return;
    try {
      await invoke("add_comment", { ticketId: state.runningTicket, text: "\u{1F4DD} " + text });
      input.value = "";
      showToast(t('focus.noteSaved'), "success");
    } catch (e) {
      appendLog("Note error: " + e, true);
    }
  };

  // Finish button
  document.getElementById("btn-focus-finish").onclick = () => {
    if (state.runningTicket) finishTicket(state.runningTicket);
  };

  // Exit button
  document.getElementById("btn-focus-exit").onclick = () => exitFocusMode();

  focus.classList.remove("hidden");
}

function exitFocusMode() {
  const focus = document.getElementById("focus-mode");
  if (!focus) return;
  focus.classList.add("hidden");

  if (focusElapsedInterval) {
    clearInterval(focusElapsedInterval);
    focusElapsedInterval = null;
  }

  // Hide terminal status bar
  const statusBar = document.getElementById("terminal-running-status");
  if (statusBar) statusBar.classList.add("hidden");

  // Move terminal back to board panel
  if (state.activeTerminal && state.terminals[state.activeTerminal]) {
    const inst = state.terminals[state.activeTerminal];
    const boardInstances = document.getElementById("board-terminal-instances");
    if (boardInstances && !boardInstances.contains(inst.containerEl)) {
      boardInstances.appendChild(inst.containerEl);
      requestAnimationFrame(() => inst.fitAddon.fit());
    }
  }
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

// ── Global Search ──
function globalSearch() {
  const input = document.getElementById("global-search-input");
  const query = (input?.value || "").toLowerCase().trim();

  let dropdown = document.getElementById("global-search-results");
  if (!dropdown) {
    dropdown = document.createElement("div");
    dropdown.id = "global-search-results";
    dropdown.className = "global-search-results hidden";
    input.parentElement.appendChild(dropdown);
  }

  if (!query || query.length < 2) {
    dropdown.classList.add("hidden");
    return;
  }

  const results = [];

  // Search tickets
  (state.board.tickets || []).forEach(t => {
    if (t.title.toLowerCase().includes(query) || (t.description || "").toLowerCase().includes(query) || t.id.toLowerCase().includes(query)) {
      results.push({ type: "ticket", icon: "\u{1F4CB}", label: `${t.id} — ${t.title}`, sub: t.column, action: () => { switchView("board"); openDetailPanel(t); } });
    }
  });

  // Search settings keywords
  const settingsKeywords = ["claude", "terminal", "deploy", "docker", "ssh", "backup", "theme", "accent", "bug-sync", "model", "shell"];
  settingsKeywords.forEach(kw => {
    if (kw.includes(query)) {
      results.push({ type: "settings", icon: "\u2699", label: `Settings: ${kw}`, sub: "", action: () => switchView("settings") });
    }
  });

  if (results.length === 0) {
    dropdown.innerHTML = `<div class="search-empty">${t('search.noResults')}</div>`;
  } else {
    dropdown.innerHTML = results.slice(0, 10).map((r, i) => `
      <div class="search-result-item" data-search-idx="${i}">
        <span class="search-icon">${r.icon}</span>
        <span class="search-label">${esc(r.label)}</span>
        <span class="search-sub">${esc(r.sub)}</span>
      </div>
    `).join("");

    dropdown.querySelectorAll(".search-result-item").forEach((el, i) => {
      el.addEventListener("click", () => {
        results[i].action();
        dropdown.classList.add("hidden");
        input.value = "";
      });
    });
  }

  dropdown.classList.remove("hidden");
}

// ── Git Warning Banner ──
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
