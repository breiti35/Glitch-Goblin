// ── Focus Mode ──
import { invoke } from '@tauri-apps/api/core';
import { state, appendLog } from './app.js';
import { showToast } from './notifications.js';
import { t } from './i18n.js';
import { lastUsage } from './projects.js';

let focusElapsedInterval = null;
let focusUsageInterval = null;

/** Aktiviert den Focus-Modus mit Terminal, Timer und Quick-Notes.
 * @param {object} ticket - Das aktive Ticket-Objekt.
 * @param {string} branch - Name des Git-Branches.
 * @param {string} model - Verwendetes Claude-Modell.
 * @param {function} finishTicketFn - Referenz auf finishTicket-Funktion.
 */
export function enterFocusMode(ticket, branch, model, finishTicketFn) {
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
    if (state.runningTicket) finishTicketFn(state.runningTicket);
  };

  // Exit button
  document.getElementById("btn-focus-exit").onclick = () => exitFocusMode();

  // Load Claude usage into focus sidebar (reads cached value from central poll)
  updateFocusFromCache();
  if (focusUsageInterval) clearInterval(focusUsageInterval);
  focusUsageInterval = setInterval(updateFocusFromCache, 10_000);

  focus.classList.remove("hidden");
}

/** Liest den gecachten Usage-Wert vom zentralen Polling-Timer und aktualisiert das Focus-Sidebar. */
function updateFocusFromCache() {
  const usage = lastUsage;
  if (usage) {
    const offlineRow = document.getElementById("focus-usage-offline");
    if (offlineRow) offlineRow.classList.add("hidden");
    updateFocusUsageRow("focus-usage-5h", "focus-usage-5h-fill", "focus-usage-5h-pct", usage.fiveHour);
    updateFocusUsageRow("focus-usage-7d", "focus-usage-7d-fill", "focus-usage-7d-pct", usage.sevenDay);
  } else {
    const row5h = document.getElementById("focus-usage-5h");
    const row7d = document.getElementById("focus-usage-7d");
    if (row5h) row5h.classList.add("hidden");
    if (row7d) row7d.classList.add("hidden");
    const offlineRow = document.getElementById("focus-usage-offline");
    if (offlineRow) offlineRow.classList.remove("hidden");
  }
}

function updateFocusUsageRow(rowId, fillId, pctId, value) {
  const row = document.getElementById(rowId);
  const fill = document.getElementById(fillId);
  const pct = document.getElementById(pctId);
  if (!row || !fill || !pct) return;
  const val = Math.round(value);
  row.classList.remove("hidden");
  fill.style.width = Math.min(val, 100) + "%";
  fill.className = "focus-usage-fill " + (val >= 90 ? "usage-red" : val >= 70 ? "usage-yellow" : "usage-green");
  pct.textContent = val + "%";
}

/** Deaktiviert den Focus-Modus und verschiebt das Terminal zurueck ins Board-Panel. */
export function exitFocusMode() {
  const focus = document.getElementById("focus-mode");
  if (!focus) return;
  focus.classList.add("hidden");

  if (focusElapsedInterval) {
    clearInterval(focusElapsedInterval);
    focusElapsedInterval = null;
  }

  if (focusUsageInterval) {
    clearInterval(focusUsageInterval);
    focusUsageInterval = null;
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
