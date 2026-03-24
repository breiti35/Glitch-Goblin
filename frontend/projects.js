// ── Project Management ──
import { invoke } from '@tauri-apps/api/core';
import { esc } from './utils.js';
import { t } from './i18n.js';
import { state, openModal, closeModal, appendLog } from './app.js';
import { renderBoard, clearFilters } from './board.js';
import { showToast } from './notifications.js';
import { checkGitStatus } from './git.js';
import { updateGitWarnings } from './app.js';
import { loadDeployConfig } from './deploy.js';
import { loadDashboard } from './dashboard.js';
import { loadGitView } from './git.js';
import { loadActivityView } from './activity.js';
import { loadStatistics } from './statistics.js';
import { loadSettingsForm } from './settings.js';
import { loadAgents, loadCommands } from './editors.js';

/** Oeffnet den Projekt-Picker-Dialog mit allen verfuegbaren Projekten. */
export function openProjectPicker() {
  const list = document.getElementById("picker-list");
  list.innerHTML = "";

  state.projects.forEach(p => {
    const item = document.createElement("div");
    item.className = "picker-item";
    if (state.project && state.project.name === p.name) item.classList.add("active");
    item.innerHTML = `
      <span class="picker-item-row">
        <span class="picker-item-name">${esc(p.name)}</span>
        <span class="picker-item-prefix" title="Ticket-Prefix">
          <input type="text" class="prefix-input" value="${esc(p.ticket_prefix || p.ticketPrefix || 'GG')}" maxlength="8" placeholder="GG">
        </span>
      </span>
      <span class="picker-item-path">${esc(p.path)}</span>
      <button class="picker-item-remove" title="Projekt entfernen">&times;</button>
    `;
    item.querySelector(".picker-item-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      removeProjectFlow(p.name);
    });
    const prefixInput = item.querySelector(".prefix-input");
    prefixInput.addEventListener("click", (e) => e.stopPropagation());
    prefixInput.addEventListener("change", async (e) => {
      e.stopPropagation();
      const newPrefix = e.target.value.trim().toUpperCase();
      if (!newPrefix || !/^[A-Z0-9]+$/.test(newPrefix)) {
        e.target.value = p.ticket_prefix || p.ticketPrefix || "GG";
        showToast("Prefix darf nur Buchstaben/Zahlen enthalten", "error");
        return;
      }
      try {
        await invoke("set_ticket_prefix", { projectName: p.name, prefix: newPrefix });
        state.projects = await invoke("get_projects");
        if (state.project?.name === p.name) {
          state.project = await invoke("get_current_project");
        }
        showToast(`Ticket-Prefix → ${newPrefix}`, "success");
      } catch (err) {
        appendLog("Set prefix error: " + err, true);
      }
    });
    item.addEventListener("click", () => switchProject(p.name));
    list.appendChild(item);
  });

  openModal("modal-picker");
}

/** Wechselt zum angegebenen Projekt und laedt alle Views neu.
 * @param {string} name - Name des Projekts.
 */
export async function switchProject(name) {
  try {
    state.board = await invoke("switch_project", { name });
    state.project = await invoke("get_current_project");
    state.projects = await invoke("get_projects");
    state.runningTicket = await invoke("get_running_ticket");
    closeModal("modal-picker");
    clearFilters();
    renderBoard();
    updateSidebar();
    updateAvatar();
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

/** Oeffnet den Ordner-Dialog und fuegt ein neues Projekt hinzu. */
export async function addProjectFlow() {
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

// ── Sidebar ──
/** Aktualisiert die Sidebar-Anzeige mit Projektname und -pfad. */
export function updateSidebar() {
  const nameEl = document.getElementById("sidebar-project-name");
  const pathEl = document.getElementById("sidebar-project-path");

  if (state.project) {
    nameEl.textContent = state.project.name;
    // Clean Windows UNC prefix (\\?\) from path display
    let cleanPath = state.project.path || "";
    cleanPath = cleanPath.replace(/^\\\\\?\\/, "");
    pathEl.textContent = cleanPath;
  } else {
    nameEl.textContent = t('header.noProject');
    pathEl.textContent = "\u2014";
  }
}

// ── Claude Usage ──
/** Letzter erfolgreich geladener Usage-Wert (fuer Focus-Mode u.a.) */
export let lastUsage = null;

/** Laedt die Claude-Usage-Daten vom Backend und zeigt sie in der Sidebar an. */
export async function loadClaudeUsage() {
  try {
    const usage = await invoke("get_claude_usage");
    lastUsage = usage;
    updateUsageDisplay(usage);
  } catch (e) {
    console.warn("[usage] get_claude_usage fehlgeschlagen:", e);
    // Wenn bereits Daten vorhanden sind, Anzeige beibehalten (kein Offline-Flackern)
    if (lastUsage !== null) return;
    // Noch keine Daten — Offline-Symbol anzeigen
    const bars = document.getElementById("header-usage-bars");
    if (bars) bars.classList.add("hidden");
    const offlineIcon = document.getElementById("usage-offline-icon");
    if (offlineIcon) offlineIcon.classList.remove("hidden");
  }
}

function updateUsageDisplay(usage) {
  const offlineIcon = document.getElementById("usage-offline-icon");
  if (offlineIcon) offlineIcon.classList.add("hidden");
  const bars = document.getElementById("header-usage-bars");
  if (bars) bars.classList.remove("hidden");

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

// ── Project Avatar ──

/** Erzeugt Initialen aus dem Projektnamen (max. 2 Zeichen). */
function projectInitials(name) {
  if (!name) return "?";
  const words = name.trim().split(/[\s\-_]+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Aktualisiert den Header-Avatar mit Logo oder Initialen. */
export async function updateAvatar() {
  const el = document.getElementById("header-avatar");
  if (!el) return;

  const name = state.project?.name;
  if (!name) {
    el.textContent = "?";
    el.style.backgroundImage = "";
    el.classList.remove("has-logo");
    return;
  }

  try {
    const dataUrl = await invoke("get_project_logo", { projectName: name });
    if (dataUrl) {
      el.textContent = "";
      el.style.backgroundImage = `url(${dataUrl})`;
      el.classList.add("has-logo");
      return;
    }
  } catch (_) { /* kein Logo vorhanden */ }

  el.textContent = projectInitials(name);
  el.style.backgroundImage = "";
  el.classList.remove("has-logo");
}

/** Oeffnet ein verstecktes File-Input um ein Logo hochzuladen. */
export async function uploadProjectLogo() {
  if (!state.project?.name) return;

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast(t('avatar.invalidType'), "error");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showToast(t('avatar.logoTooLarge'), "error");
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      await invoke("set_project_logo", { projectName: state.project.name, data: dataUrl });
      await updateAvatar();
      showToast(t('avatar.logoSaved'), "success");
    } catch (err) {
      showToast(t('avatar.logoUploadFailed') + ": " + err, "error");
    }
  });
  input.click();
}

/** Entfernt das Projekt-Logo. */
export async function removeProjectLogo() {
  if (!state.project?.name) return;
  try {
    await invoke("remove_project_logo", { projectName: state.project.name });
    await updateAvatar();
    showToast(t('avatar.logoRemoved'), "success");
  } catch (err) {
    showToast(t('avatar.logoRemoveFailed') + ": " + err, "error");
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Richtet das Rechtsklick-Kontextmenü für den Avatar ein. */
export function setupAvatarContextMenu() {
  const avatar = document.getElementById("header-avatar");
  const menu = document.getElementById("avatar-context-menu");
  if (!avatar || !menu) return;

  avatar.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!state.project) return;
    menu.style.top = e.clientY + "px";
    menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + "px";
    menu.classList.remove("hidden");
  });

  // Linksklick auf Avatar öffnet ebenfalls das Menü
  avatar.addEventListener("click", (e) => {
    if (!state.project) return;
    const rect = avatar.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + "px";
    menu.style.left = Math.min(rect.left, window.innerWidth - 200) + "px";
    menu.classList.remove("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#avatar-context-menu") && !e.target.closest("#header-avatar")) {
      menu.classList.add("hidden");
    }
  });

  menu.addEventListener("click", (e) => {
    const item = e.target.closest(".ctx-item");
    if (!item) return;
    menu.classList.add("hidden");
    const action = item.dataset.action;
    if (action === "upload-logo") uploadProjectLogo();
    else if (action === "remove-logo") removeProjectLogo();
    else if (action === "project-settings") {
      // Navigiere zum Settings-View
      const nav = document.querySelector('[data-view="settings"]');
      if (nav) nav.click();
    }
  });
}
