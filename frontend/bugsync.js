// ── Bug-Sync Module ──
// Portal bug-tracker synchronization.

import { invoke } from '@tauri-apps/api/core';
import { state, appendLog } from './app.js';
import { renderBoard } from './board.js';

// ── Bug-Sync Listeners ──

export function setupBugSyncListeners() {
  const syncBtn = document.getElementById("btn-bug-sync");
  if (syncBtn) syncBtn.addEventListener("click", performBugSync);

  const testBtn = document.getElementById("btn-bugsync-test");
  if (testBtn) testBtn.addEventListener("click", performBugSync);

  const navBtn = document.getElementById("nav-bug-sync");
  if (navBtn) navBtn.addEventListener("click", performBugSync);

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

async function performBugSync() {
  const syncBtn = document.getElementById("btn-bug-sync");
  const statusEl = document.getElementById("bugsync-status");

  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.textContent = "\u{1F504} Synchronisiere...";
  }

  try {
    const result = await invoke("sync_portal_bugs");

    if (result.syncedCount > 0) {
      appendLog(`Bug-Sync: ${result.syncedCount} neue Bugs synchronisiert`);
      state.board = await invoke("get_board");
      renderBoard();
      updateBugSyncBadge(0);
    } else {
      appendLog("Bug-Sync: Keine neuen Bugs");
    }

    if (result.errors && result.errors.length > 0) {
      result.errors.forEach(e => appendLog("Bug-Sync Warning: " + e, true));
    }

    if (statusEl) {
      statusEl.textContent = result.syncedCount > 0
        ? `${result.syncedCount} Bugs synchronisiert`
        : "Keine neuen Bugs gefunden";
      statusEl.classList.remove("hidden");
      setTimeout(() => statusEl.classList.add("hidden"), 5000);
    }
  } catch (err) {
    appendLog("Bug-Sync error: " + err, true);
    if (statusEl) {
      statusEl.textContent = "Fehler: " + err;
      statusEl.classList.remove("hidden");
    }
  } finally {
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.textContent = "\u{1F41B} Bugs synchen";
    }
  }
}
