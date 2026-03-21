// ── Crash Recovery ──
import { invoke } from '@tauri-apps/api/core';
import { state, appendLog, closeModal, openModal, finishTicket } from './app.js';
import { showToast } from './notifications.js';
import { renderBoard } from './board.js';
import { openBoardTerminal } from './terminal.js';
import { t } from './i18n.js';

/** Prueft ob ein Ticket in Bearbeitung war als die App geschlossen wurde und zeigt den Recovery-Dialog. */
export async function checkTicketRecovery() {
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

  // "Abschliessen" — commit + review
  document.getElementById("btn-recovery-finish").onclick = () => {
    closeModal("modal-recovery");
    finishTicket(ticket.id);
  };

  // "Zurueck ins Backlog" — reset ticket
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
