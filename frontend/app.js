// ── Tauri IPC ──
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ── Modules ──
import { debounce, esc } from './utils.js';
import { installErrorHandler } from './error-handler.js';
import { renderBoard, applyFilters, toggleFilterBar, clearFilters, closeContextMenu, handleContextMenuAction, exportCurrentLog } from './board.js';
import { openDetailPanel, closeDetailPanel, saveDetailTicket, deleteDetailTicket, setupCommentListeners } from './detail.js';
import { loadGitView, setupGitListeners, checkGitStatus } from './git.js';
import { setupTerminalListeners, openTicketTerminal, toggleTerminalView, toggleBoardTerminalPanel, cleanupTerminal } from './terminal.js';
import { loadSettingsForm, saveSettingsForm, openBackupModal, setupModelPresetListener } from './settings.js';
import { loadStatistics } from './statistics.js';
import { loadDashboard, loadTemplatesForModal, setupTemplateListener, setupImportExportListeners } from './dashboard.js';
import { loadActivityView, setupActivityListeners } from './activity.js';
import { loadAgents, loadCommands, newAgentFlow, saveAgentEditor, deleteAgentEditor, newCommandFlow, saveCommandEditor, deleteCommandEditor } from './editors.js';
import { setupDeployListeners, loadDeployConfig } from './deploy.js';
import { setupBugSyncListeners, updateBugSyncBadge } from './bugsync.js';

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
  setupTemplateListener();
  setupImportExportListeners();
  setupDeployListeners();
  setupBugSyncListeners();
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

  // Global search → filter (debounced)
  const debouncedApplyFilters = debounce(applyFilters, 150);
  document.getElementById("global-search-input")?.addEventListener("input", (e) => {
    const filterInput = document.getElementById("filter-input");
    if (filterInput) {
      filterInput.value = e.target.value;
      debouncedApplyFilters();
    }
  });

  // Header "+ Create Project" button
  document.getElementById("btn-header-add-project")?.addEventListener("click", openProjectPicker);

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
}

// ── Execution ──
export function confirmExecute(ticket) {
  const isCodeChanging = ticket.ticket_type === "feature" || ticket.ticket_type === "bugfix";
  const warning = isCodeChanging ? " \u26A0 Dieses Ticket \u00E4ndert Code." : "";
  document.getElementById("confirm-message").textContent =
    `Execute ticket ${ticket.id} - "${ticket.title}"?${warning}`;
  const modelSelect = document.getElementById("confirm-model-select");
  modelSelect.value = modelToFlag(state.settings.claude_model || "claude-sonnet-4-6");
  document.getElementById("btn-confirm-yes").onclick = () => {
    const selectedModel = modelSelect.value;
    closeModal("modal-confirm");
    executeTicket(ticket.id, selectedModel);
  };
  openModal("modal-confirm");
}

export function modelToFlag(model) {
  const compat = { sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-6", haiku: "claude-haiku-4-5-20251001" };
  return compat[model] || model || "claude-sonnet-4-6";
}

async function executeTicket(ticketId, model) {
  const ticket = (state.board.tickets || []).find(t => t.id === ticketId);
  const ticketTitle = ticket ? ticket.title : ticketId;
  const selectedModel = model || state.settings.claude_model || "claude-sonnet-4-6";

  state.runningTicket = ticketId;
  renderBoard();

  try {
    appendLog(`Starting ${ticketId} - ${ticketTitle}...`);
    const result = await invoke("start_ticket", { ticketId, model: selectedModel });
    appendLog(`Branch: ${result.branch}`);
    await openTicketTerminal(result, selectedModel);
  } catch (err) {
    state.runningTicket = null;
    appendLog("Start error: " + err, true);
    notifyDesktop("Fehler", `${ticketTitle} fehlgeschlagen`);
    playSound("error");
    refreshBoard();
  }
}

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

  // Confirm button
  document.getElementById("btn-review-confirm").onclick = async () => {
    closeModal("modal-review");
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

export async function mergeTicket(ticketId) {
  if (!confirm(`Ticket ${ticketId} mergen?\nDer Branch wird in den Hauptbranch gemergt.`)) return;
  try {
    appendLog(`Merging ${ticketId}...`);
    await invoke("merge_ticket", { ticketId });
    appendLog(`\u2713 ${ticketId} merged successfully`);
    refreshBoard();
  } catch (err) {
    appendLog("Merge error: " + err, true);
  }
}

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
