// ── Project Management ──
import { invoke } from '@tauri-apps/api/core';
import { esc } from './utils.js';
import { t } from './i18n.js';
import { state, openModal, closeModal, appendLog } from './app.js';
import { renderBoard } from './board.js';
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
/** Laedt die Claude-Usage-Daten vom Backend und zeigt sie in der Sidebar an. */
export async function loadClaudeUsage() {
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
