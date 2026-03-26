// ── Terminal Module ──
// PTY terminal sessions, tabs, board terminal panel.

import { invoke } from '@tauri-apps/api/core';
import { esc, logError } from './utils.js';
import { state, appendLog, modelToFlag, switchView, refreshBoard } from './app.js';
import { t } from './i18n.js';

// ── Shell Options ──

export async function loadShellOptions(selectId, selectedValue) {
  const select = document.getElementById(selectId);
  if (!select) return;
  try {
    const shells = await invoke("list_available_shells");
    select.innerHTML = '<option value="">' + esc(t('terminal.autoDetect')) + '</option>' +
      shells.map(s => `<option value="${esc(s.path)}"${s.path === selectedValue ? " selected" : ""}>${esc(s.name)}</option>`).join("");
  } catch (e) {
    logError("terminal: failed to load shells", e);
  }
}

// ── Terminal Context Descriptors ──

const BOARD_CTX = {
  containerId: "board-terminal-instances",
  tabsId: "board-terminal-tabs",
  emptyStateId: "board-terminal-empty",
  stateKey: "terminals",
  activeKey: "activeTerminal",
};

const PAGE_CTX = {
  containerId: "terminal-page-instances",
  tabsId: "terminal-page-tabs",
  emptyStateId: "terminal-page-empty",
  stateKey: "pageTerminals",
  activeKey: "activePageTerminal",
};

// ── Generic Terminal Factory ──

function createTerminalInstance(terminalId, name, ctx) {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: state.settings.terminal_font_size || 14,
    fontFamily: "'FiraCode Nerd Font Mono', 'FiraCode Nerd Font', 'Fira Code', 'Consolas', monospace",
    scrollback: 10000,
    scrollOnOutput: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const container = document.createElement("div");
  container.className = "terminal-instance";
  container.dataset.terminalId = terminalId;

  const emptyState = document.getElementById(ctx.emptyStateId);
  if (emptyState) emptyState.style.display = "none";
  document.querySelectorAll(`#${ctx.containerId} .terminal-instance`).forEach(c => c.style.display = "none");
  document.getElementById(ctx.containerId).appendChild(container);
  container.style.display = "block";

  const tab = document.createElement("button");
  tab.className = "terminal-tab active";
  tab.dataset.terminalId = terminalId;
  tab.innerHTML = `${esc(name)} <span class="tab-close" data-terminal-id="${terminalId}">&times;</span>`;
  document.querySelectorAll(`#${ctx.tabsId} .terminal-tab`).forEach(t => t.classList.remove("active"));
  document.getElementById(ctx.tabsId).appendChild(tab);

  void container.offsetHeight;
  term.open(container);
  fitAddon.fit();
  const { cols, rows } = term;
  invoke("resize_terminal", { terminalId, cols, rows }).catch(e => logError("terminal: resize", e));
  term.focus();

  term.onData(data => {
    invoke("write_terminal", { terminalId, data }).catch(e => logError("terminal: write", e));
  });

  state[ctx.stateKey][terminalId] = { term, fitAddon, tabEl: tab, containerEl: container, name };
  state[ctx.activeKey] = terminalId;

  return { term, fitAddon, tab, container };
}

function cleanupTerminalInContext(terminalId, ctx) {
  const store = state[ctx.stateKey];
  const inst = store[terminalId];
  if (inst) {
    if (inst._checkInterval) clearInterval(inst._checkInterval);
    if (inst._fallbackTimeout) clearTimeout(inst._fallbackTimeout);
    inst.onOutput = null;
    inst.term.dispose();
    if (inst.tabEl) inst.tabEl.remove();
    inst.containerEl.remove();
    delete store[terminalId];
  }

  const remaining = Object.keys(store);
  if (remaining.length > 0) {
    const nextId = remaining[remaining.length - 1];
    const nextInst = store[nextId];
    if (nextInst) {
      document.querySelectorAll(`#${ctx.tabsId} .terminal-tab`).forEach(t => t.classList.remove("active"));
      if (nextInst.tabEl) nextInst.tabEl.classList.add("active");
      document.querySelectorAll(`#${ctx.containerId} .terminal-instance`).forEach(c => c.style.display = "none");
      nextInst.containerEl.style.display = "block";
      state[ctx.activeKey] = nextId;
      requestAnimationFrame(() => {
        nextInst.fitAddon.fit();
        nextInst.term.focus();
      });
    }
  } else {
    state[ctx.activeKey] = null;
    const emptyState = document.getElementById(ctx.emptyStateId);
    if (emptyState) emptyState.style.display = "";
  }
}

function refitTerminal(ctx) {
  const activeId = state[ctx.activeKey];
  if (!activeId || !state[ctx.stateKey][activeId]) return;
  const inst = state[ctx.stateKey][activeId];
  requestAnimationFrame(() => {
    inst.fitAddon.fit();
    const { cols, rows } = inst.term;
    invoke("resize_terminal", { terminalId: activeId, cols, rows }).catch(e => logError("terminal: resize", e));
  });
}

function switchTerminalTab(terminalId, ctx) {
  if (!state[ctx.stateKey][terminalId]) return;
  document.querySelectorAll(`#${ctx.tabsId} .terminal-tab`).forEach(t => t.classList.remove("active"));
  document.querySelectorAll(`#${ctx.containerId} .terminal-instance`).forEach(c => c.style.display = "none");

  const inst = state[ctx.stateKey][terminalId];
  if (inst.tabEl) inst.tabEl.classList.add("active");
  inst.containerEl.style.display = "block";
  state[ctx.activeKey] = terminalId;
  refitTerminal(ctx);
  inst.term.focus();
}

// ── Terminal Lifecycle ──

export function cleanupTerminal(terminalId) {
  cleanupTerminalInContext(terminalId, BOARD_CTX);
}

export async function closeTerminalById(terminalId) {
  try {
    await invoke("close_terminal", { terminalId });
  } catch (e) {
    logError("terminal: close failed", e);
  }
  cleanupTerminal(terminalId);
}

// ── Board Terminal Panel ──

export function toggleTerminalView() {
  // Ctrl+` toggles: if on terminal page, go back to board; otherwise open terminal page
  const terminalView = document.getElementById("view-terminal");
  if (terminalView && terminalView.classList.contains("active")) {
    switchView("board");
  } else {
    switchView("terminal");
  }
}

export function toggleBoardTerminalPanel() {
  const panel = document.getElementById("board-terminal-panel");
  if (!panel) return;
  const wasCollapsed = panel.classList.contains("collapsed");
  panel.classList.toggle("collapsed");

  const toggleBtn = document.getElementById("board-terminal-toggle");
  if (wasCollapsed) {
    toggleBtn.innerHTML = "&#9660; Terminal";
    if (panel.dataset.savedHeight) {
      panel.style.height = panel.dataset.savedHeight;
    }
    if (Object.keys(state.terminals).length === 0) {
      openBoardTerminal();
    } else {
      refitBoardTerminal();
    }
  } else {
    toggleBtn.innerHTML = "&#9654; Terminal";
    if (panel.style.height) {
      panel.dataset.savedHeight = panel.style.height;
      panel.style.height = "";
    }
  }
}

function ensurePanelVisible() {
  const panel = document.getElementById("board-terminal-panel");
  if (panel && panel.classList.contains("collapsed")) {
    panel.classList.remove("collapsed");
    document.getElementById("board-terminal-toggle").innerHTML = "&#9660; Terminal";
    if (panel.dataset.savedHeight) {
      panel.style.height = panel.dataset.savedHeight;
    }
    void panel.offsetHeight;
  }
}

export async function openBoardTerminal(shell) {
  if (!state.project) return;
  ensurePanelVisible();

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
    createTerminalInstance(terminalId, name, BOARD_CTX);
  } catch (e) {
    appendLog("Failed to open terminal: " + e, true);
  }
}

export async function openTicketTerminal(startResult, model) {
  ensurePanelVisible();

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

  const cwd = startResult.projectPath;
  let terminalId;
  try {
    terminalId = await invoke("spawn_terminal", { shell, cwd });
  } catch (e) {
    appendLog("Terminal konnte nicht gestartet werden: " + e, true);
    state.runningTicket = null;
    refreshBoard();
    return;
  }
  state.terminalCounter++;
  const name = startResult.ticketId;

  createTerminalInstance(terminalId, name, BOARD_CTX);

  // Start Claude Code interactively, detect readiness via output, then send prompt
  setTimeout(() => {
    const claudePath = state.settings.claude_cli_path || "claude";
    const modelFlag = modelToFlag(model || state.settings.claude_model || "claude-sonnet-4-6");
    const claudeCmd = `${claudePath} --dangerously-skip-permissions --model ${modelFlag}\r`;
    invoke("write_terminal", { terminalId, data: claudeCmd }).catch(e => logError("terminal: write", e));

    const inst = state.terminals[terminalId];
    if (!inst) return;

    let promptSent = false;
    let lastOutputTime = 0;
    let outputReceived = false;

    inst.onOutput = () => {
      if (promptSent) return;
      outputReceived = true;
      lastOutputTime = Date.now();
    };

    // Poll: once output settles (2s silence after first output), send prompt
    const checkInterval = setInterval(() => {
      // Stop if terminal was cleaned up
      if (!state.terminals[terminalId]) { clearInterval(checkInterval); return; }
      if (promptSent) { clearInterval(checkInterval); return; }
      if (outputReceived && Date.now() - lastOutputTime > 2000) {
        promptSent = true;
        inst.onOutput = null;
        clearInterval(checkInterval);
        const isMultiline = startResult.prompt.includes("\n");
        // Bracketed paste mode: \x1b[200~ ... \x1b[201~ tells the CLI this is a paste, not typed input
        const prompt = isMultiline
          ? "\x1b[200~" + startResult.prompt + "\x1b[201~"
          : startResult.prompt + "\r";
        invoke("write_terminal", { terminalId, data: prompt }).catch(e => logError("terminal: write", e));
      }
    }, 500);

    // Store interval handle for cleanup
    inst._checkInterval = checkInterval;

    // Fallback: send after 20s regardless
    const fallbackTimeout = setTimeout(() => {
      if (!promptSent) {
        promptSent = true;
        inst.onOutput = null;
        clearInterval(checkInterval);
        const isMultiline = startResult.prompt.includes("\n");
        const prompt = isMultiline
          ? "\x1b[200~" + startResult.prompt + "\x1b[201~"
          : startResult.prompt + "\r";
        invoke("write_terminal", { terminalId, data: prompt }).catch(e => logError("terminal: write", e));
      }
    }, 20000);

    // Store timeout handle for cleanup
    inst._fallbackTimeout = fallbackTimeout;
  }, 1500);
}

export async function openDeployTerminal(terminalId, name) {
  ensurePanelVisible();

  // Switch to board view if not already there
  const boardView = document.getElementById("view-board");
  if (boardView && !boardView.classList.contains("active")) {
    switchView("board");
  }

  createTerminalInstance(terminalId, name, BOARD_CTX);
}

// ── Terminal Tab Management ──

export function refitBoardTerminal() {
  refitTerminal(BOARD_CTX);
}

function switchBoardTerminalTab(terminalId) {
  switchTerminalTab(terminalId, BOARD_CTX);
}

// ── Terminal Page (Fullscreen Multi-Tab) ──

export function cleanupPageTerminal(terminalId) {
  cleanupTerminalInContext(terminalId, PAGE_CTX);
}

async function closePageTerminalById(terminalId) {
  try {
    await invoke("close_terminal", { terminalId });
  } catch (e) {
    logError("terminal: close failed", e);
  }
  cleanupPageTerminal(terminalId);
}

async function openPageTerminal(shell) {
  if (!state.project) return;

  const cwd = state.project.path;
  if (!shell) {
    const select = document.getElementById("terminal-page-shell-select");
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
    state.pageTerminalCounter++;
    const name = "Terminal " + state.pageTerminalCounter;
    createTerminalInstance(terminalId, name, PAGE_CTX);
  } catch (e) {
    appendLog("Failed to open terminal: " + e, true);
  }
}

export function refitPageTerminal() {
  refitTerminal(PAGE_CTX);
}

function switchPageTerminalTab(terminalId) {
  switchTerminalTab(terminalId, PAGE_CTX);
}

// ── Setup Listeners ──

export function setupTerminalListeners() {

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

  // Board-panel shell dropdown
  const boardShellSelect = document.getElementById("board-terminal-shell-select");
  if (boardShellSelect) {
    let boardShellsLoaded = false;
    boardShellSelect.addEventListener("focus", async () => {
      if (boardShellsLoaded) return;
      boardShellsLoaded = true;
      await loadShellOptions("board-terminal-shell-select", state.settings.default_shell || "");
    });
    loadShellOptions("board-terminal-shell-select", state.settings.default_shell || "");
  }

  // Font size slider live preview
  document.getElementById("set-terminal-fontsize")?.addEventListener("input", (e) => {
    document.getElementById("terminal-fontsize-label").textContent = e.target.value + "px";
  });

  // Resize observer — board terminal panel
  const boardBody = document.getElementById("board-terminal-instances");
  if (boardBody) {
    let resizeTimeout;
    new ResizeObserver(() => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => refitBoardTerminal(), 100);
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

  // ── Terminal Page Listeners ──

  // Page tab clicks
  document.getElementById("terminal-page-tabs")?.addEventListener("click", e => {
    const closeBtn = e.target.closest(".tab-close");
    if (closeBtn) {
      e.stopPropagation();
      closePageTerminalById(closeBtn.dataset.terminalId);
      return;
    }
    const tab = e.target.closest(".terminal-tab");
    if (tab) switchPageTerminalTab(tab.dataset.terminalId);
  });

  // Page new terminal
  document.getElementById("terminal-page-new")?.addEventListener("click", () => openPageTerminal());

  // Page shell dropdown
  const pageShellSelect = document.getElementById("terminal-page-shell-select");
  if (pageShellSelect) {
    let pageShellsLoaded = false;
    pageShellSelect.addEventListener("focus", async () => {
      if (pageShellsLoaded) return;
      pageShellsLoaded = true;
      await loadShellOptions("terminal-page-shell-select", state.settings.default_shell || "");
    });
    loadShellOptions("terminal-page-shell-select", state.settings.default_shell || "");
  }

  // Resize observer — terminal page
  const pageBody = document.getElementById("terminal-page-instances");
  if (pageBody) {
    let pageResizeTimeout;
    new ResizeObserver(() => {
      clearTimeout(pageResizeTimeout);
      pageResizeTimeout = setTimeout(() => refitPageTerminal(), 100);
    }).observe(pageBody);
  }
}
