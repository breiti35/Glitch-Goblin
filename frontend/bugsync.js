// ── Bug-Sync Module ──
// Portal bug-tracker synchronization + Inbox view.

import { invoke } from '@tauri-apps/api/core';
import { state, appendLog } from './app.js';
import { switchView } from './app.js';
import { renderBoard } from './board.js';
import { showToast } from './notifications.js';
import { t } from './i18n.js';

// ── Bug-Sync Listeners ──

export function setupBugSyncListeners() {
  const syncBtn = document.getElementById("btn-bug-sync");
  if (syncBtn) syncBtn.addEventListener("click", handleBugSyncClick);

  const testBtn = document.getElementById("btn-bugsync-test");
  if (testBtn) testBtn.addEventListener("click", handleBugSyncClick);

  const refreshBtn = document.getElementById("btn-inbox-refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", loadInboxView);

  const intervalRange = document.getElementById("set-bugsync-interval");
  if (intervalRange) {
    intervalRange.addEventListener("input", () => {
      const secs = parseInt(intervalRange.value);
      document.getElementById("bugsync-interval-label").textContent =
        secs >= 60 ? Math.round(secs / 60) + " min" : secs + " s";
    });
  }

  updateBugSyncVisibility();
}

/** Entscheidet ob Inbox-View oder direkter Sync gestartet wird. */
function handleBugSyncClick() {
  const bs = state.settings.bug_sync || {};
  if (bs.sync_mode === "auto") {
    performBugSync();
  } else {
    switchView("bugsync");
  }
}

export function updateBugSyncVisibility() {
  const bs = state.settings.bug_sync || {};
  const syncBtn = document.getElementById("btn-bug-sync");
  const navBtn = document.getElementById("nav-bug-sync");
  const show = bs.enabled && bs.api_url;
  if (syncBtn) syncBtn.classList.toggle("hidden", !show);
  if (navBtn) navBtn.classList.toggle("hidden", !show);
}

export function updateBugSyncBadge(count) {
  state.bugSyncCount = count;
  const badge = document.getElementById("bug-sync-badge");
  const navBadge = document.getElementById("bug-sync-count");
  if (badge) {
    badge.textContent = count;
    badge.classList.toggle("hidden", count <= 0);
  }
  if (navBadge) navBadge.textContent = count;
  const bellBadge = document.getElementById("header-notif-badge");
  if (bellBadge) {
    bellBadge.textContent = count;
    bellBadge.classList.toggle("hidden", count === 0);
  }
}

// ── Inbox View ──

export async function loadInboxView() {
  const container = document.getElementById("bugsync-inbox-list");
  const subtitle = document.getElementById("bugsync-inbox-subtitle");
  if (!container) return;

  container.innerHTML = '<p class="empty-state">Lade Eintr\u00e4ge vom Portal...</p>';

  try {
    const bugs = await invoke("fetch_inbox_bugs");

    if (!bugs || bugs.length === 0) {
      container.innerHTML = '<p class="empty-state">Keine neuen Eintr\u00e4ge im Portal</p>';
      if (subtitle) subtitle.textContent = "Keine offenen Meldungen";
      updateBugSyncBadge(0);
      return;
    }

    updateBugSyncBadge(bugs.length);
    if (subtitle) subtitle.textContent = `${bugs.length} Eintr\u00e4ge zur Sichtung`;

    container.innerHTML = "";
    for (const bug of bugs) {
      container.appendChild(renderInboxCard(bug));
    }
  } catch (err) {
    container.innerHTML = `<p class="empty-state" style="color:var(--danger)">Fehler: ${err}</p>`;
    appendLog("Bug-Sync Inbox error: " + err, true);
  }
}

function renderInboxCard(bug) {
  const card = document.createElement("div");
  card.className = "bugsync-inbox-card";
  card.dataset.bugId = bug.id;

  const typeLabel = bug.bug_type || "bug";
  const typeClass = typeLabel === "feedback" ? "badge-feedback" : typeLabel === "idea" ? "badge-idea" : "badge-bug";

  const reporter = bug.reporter_name || "Unbekannt";
  const date = bug.created_at ? new Date(bug.created_at).toLocaleDateString("de-DE") : "";
  const category = bug.category || "";

  card.innerHTML = `
    <div class="inbox-card-header">
      <span class="inbox-type-badge ${typeClass}">${typeLabel === "feedback" ? "Feedback" : typeLabel === "idea" ? "Idee" : "Bug"}</span>
      <span class="inbox-card-id">#${bug.id}</span>
      ${date ? `<span class="inbox-card-date">${date}</span>` : ""}
    </div>
    <div class="inbox-card-body">
      <h3 class="inbox-card-title">${escapeHtml(bug.title)}</h3>
      ${bug.description ? `<p class="inbox-card-desc">${escapeHtml(bug.description)}</p>` : ""}
      <div class="inbox-card-meta">
        ${category ? `<span class="inbox-meta-item"><span class="material-symbols-outlined" style="font-size:14px">category</span> ${escapeHtml(category)}</span>` : ""}
        <span class="inbox-meta-item"><span class="material-symbols-outlined" style="font-size:14px">person</span> ${escapeHtml(reporter)}</span>
      </div>
    </div>
    <div class="inbox-card-actions">
      <button class="btn-inbox-accept" title="\u00dcbernehmen"><span class="material-symbols-outlined">check_circle</span> \u00dcbernehmen</button>
      <button class="btn-inbox-reject" title="Ablehnen"><span class="material-symbols-outlined">cancel</span> Ablehnen</button>
    </div>
  `;

  // Accept
  card.querySelector(".btn-inbox-accept").addEventListener("click", async () => {
    await acceptBug(bug, card);
  });

  // Reject
  card.querySelector(".btn-inbox-reject").addEventListener("click", async () => {
    await rejectBug(bug.id, card);
  });

  return card;
}

async function acceptBug(bug, card) {
  const btn = card.querySelector(".btn-inbox-accept");
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined spinning">sync</span> ...';

  try {
    const ticket = await invoke("accept_inbox_bug", { bug });
    card.classList.add("inbox-card-accepted");
    card.querySelector(".inbox-card-actions").innerHTML =
      `<span class="inbox-action-done">\u2713 Ticket ${ticket.id} erstellt</span>`;
    showToast(`Ticket ${ticket.id} erstellt`, "success");
    appendLog(`Bug-Sync Inbox: Bug #${bug.id} als ${ticket.id} \u00fcbernommen`);

    // Update board data in background
    state.board = await invoke("get_board");
    renderBoard();
    updateRemainingCount();
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined">check_circle</span> \u00dcbernehmen';
    showToast("Fehler: " + err, "error");
    appendLog("Bug-Sync accept error: " + err, true);
  }
}

async function rejectBug(bugId, card) {
  const btn = card.querySelector(".btn-inbox-reject");
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined spinning">sync</span> ...';

  try {
    await invoke("reject_inbox_bug", { bugId });
    card.classList.add("inbox-card-rejected");
    card.querySelector(".inbox-card-actions").innerHTML =
      '<span class="inbox-action-done inbox-rejected">\u2717 Abgelehnt</span>';
    showToast(`Bug #${bugId} abgelehnt`, "info");
    appendLog(`Bug-Sync Inbox: Bug #${bugId} abgelehnt`);
    updateRemainingCount();
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined">cancel</span> Ablehnen';
    showToast("Fehler: " + err, "error");
    appendLog("Bug-Sync reject error: " + err, true);
  }
}

function updateRemainingCount() {
  const container = document.getElementById("bugsync-inbox-list");
  if (!container) return;
  const remaining = container.querySelectorAll(".bugsync-inbox-card:not(.inbox-card-accepted):not(.inbox-card-rejected)").length;
  const subtitle = document.getElementById("bugsync-inbox-subtitle");
  if (subtitle) {
    subtitle.textContent = remaining > 0
      ? `${remaining} Eintr\u00e4ge zur Sichtung`
      : "Alle Eintr\u00e4ge bearbeitet";
  }
  updateBugSyncBadge(remaining);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Legacy Auto-Sync ──

async function performBugSync() {
  const syncBtn = document.getElementById("btn-bug-sync");
  const statusEl = document.getElementById("bugsync-status");

  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.textContent = "\u{1F504} " + t('settings.syncing');
  }

  try {
    const result = await invoke("sync_portal_bugs");

    if (result.syncedCount > 0) {
      appendLog(`Bug-Sync: ${result.syncedCount} neue Eintr\u00e4ge synchronisiert`);
      state.board = await invoke("get_board");
      renderBoard();
      updateBugSyncBadge(0);
    } else {
      appendLog("Bug-Sync: Keine neuen Eintr\u00e4ge");
    }

    if (result.errors && result.errors.length > 0) {
      result.errors.forEach(e => appendLog("Bug-Sync Warning: " + e, true));
    }

    if (statusEl) {
      statusEl.textContent = result.syncedCount > 0
        ? `${result.syncedCount} Eintr\u00e4ge synchronisiert`
        : "Keine neuen Eintr\u00e4ge gefunden";
      statusEl.classList.remove("hidden");
      setTimeout(() => statusEl.classList.add("hidden"), 5000);
    }
  } catch (err) {
    appendLog("Bug-Sync error: " + err, true);
    if (statusEl) {
      statusEl.textContent = t('settings.syncError', {error: err});
      statusEl.classList.remove("hidden");
    }
  } finally {
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.textContent = "\u{1F41B} " + t('board.bugSync');
    }
  }
}
