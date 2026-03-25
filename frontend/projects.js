// ── Project Management ──
import { invoke } from '@tauri-apps/api/core';
import { esc, withGuard } from './utils.js';
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
        <span class="picker-item-prefix" title="${esc(t('projects.ticketPrefixTitle'))}">
          <input type="text" class="prefix-input" value="${esc(p.ticket_prefix || p.ticketPrefix || 'GG')}" maxlength="8" placeholder="GG">
        </span>
      </span>
      <span class="picker-item-path">${esc(p.path)}</span>
      <button class="picker-item-remove" title="${esc(t('projects.removeProject'))}">&times;</button>
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
        showToast(t('projects.prefixInvalid'), "error");
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
async function switchProjectImpl(name) {
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

// Guard gegen Race Conditions bei schnellem Wechsel
export const switchProject = withGuard(switchProjectImpl);

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
      openProjectSettingsModal();
    }
  });
}

// ── Project Settings Modal ──

/** Öffnet das Projekt-Einstellungen-Modal und befüllt es mit den aktuellen Werten. */
export async function openProjectSettingsModal() {
  if (!state.project) return;
  openModal("modal-project-settings");
  await loadProjectSettingsForm();
}

/** Lädt projekt-spezifische Einstellungen vom Backend und befüllt das Modal. */
async function loadProjectSettingsForm() {
  try {
    const ps = await invoke("get_project_settings");

    // Projekt-Tab
    document.getElementById("ps-ticket-prefix").value = ps.ticket_prefix || "GG";

    // GitHub-Tab
    document.getElementById("ps-github-enabled").checked = !!ps.github.enabled;
    document.getElementById("ps-github-owner").value = ps.github.owner || "";
    document.getElementById("ps-github-repo").value = ps.github.repo || "";
    document.getElementById("ps-github-token").value = "";
    document.getElementById("ps-github-token").placeholder = ps.github_token_set ? "(Token gesetzt)" : "ghp_... oder gho_...";
    document.getElementById("ps-github-interval").value = ps.github.poll_interval_secs || 60;
    document.getElementById("ps-github-interval-label").textContent = (ps.github.poll_interval_secs || 60) + "s";

    // Bug-Sync-Tab
    document.getElementById("ps-bugsync-enabled").checked = !!ps.bug_sync.enabled;
    document.getElementById("ps-bugsync-url").value = ps.bug_sync.api_url || "";
    document.getElementById("ps-bugsync-token").value = "";
    document.getElementById("ps-bugsync-token").placeholder = ps.bug_sync_token_set ? "(Token gesetzt)" : "Secret oder JWT Token";
    document.getElementById("ps-bugsync-interval").value = ps.bug_sync.interval_secs || 300;
    const bsInterval = ps.bug_sync.interval_secs || 300;
    document.getElementById("ps-bugsync-interval-label").textContent = bsInterval >= 60 ? Math.round(bsInterval / 60) + " min" : bsInterval + " s";

    // Deploy-Tab — load from existing deploy config
    loadProjectDeployForm();
  } catch (err) {
    appendLog("Load project settings error: " + err, true);
  }
}

/** Befüllt die Deploy-Felder im Projekt-Settings-Modal aus state.deployConfig. */
function loadProjectDeployForm() {
  const cfg = state.deployConfig || {};
  const el = (id) => document.getElementById(id);
  if (el("ps-deploy-type")) el("ps-deploy-type").value = cfg.deployType || "compose";
  if (el("ps-compose-files")) el("ps-compose-files").value = (cfg.composeFiles || []).join(", ");
  if (el("ps-env-file")) el("ps-env-file").value = cfg.envFile || "";
  if (el("ps-local-url")) el("ps-local-url").value = cfg.localUrl || "";
  if (el("ps-live-enabled")) el("ps-live-enabled").checked = !!cfg.liveEnabled;
  if (el("ps-ssh-host")) el("ps-ssh-host").value = cfg.sshHost || "";
  if (el("ps-ssh-key")) el("ps-ssh-key").value = cfg.sshKey || "";
  if (el("ps-ssh-port")) el("ps-ssh-port").value = cfg.sshPort || 22;
  if (el("ps-server-path")) el("ps-server-path").value = cfg.serverPath || "";
  if (el("ps-server-branch")) el("ps-server-branch").value = cfg.serverBranch || "main";
  if (el("ps-pre-commands")) el("ps-pre-commands").value = (cfg.preCommands || []).join("\n");
  if (el("ps-deploy-commands")) el("ps-deploy-commands").value = (cfg.deployCommands || []).join("\n");
  if (el("ps-post-commands")) el("ps-post-commands").value = (cfg.postCommands || []).join("\n");
  if (el("ps-live-url")) el("ps-live-url").value = cfg.liveUrl || "";

  const livePanel = document.getElementById("ps-live-settings-panel");
  if (livePanel) livePanel.classList.toggle("collapsed", !cfg.liveEnabled);
}

/** Speichert alle Projekt-Einstellungen (GitHub, Bug-Sync, Deploy, Prefix). */
export async function saveProjectSettingsForm() {
  const payload = {
    ticket_prefix: document.getElementById("ps-ticket-prefix").value.trim(),
    github: {
      enabled: document.getElementById("ps-github-enabled").checked,
      owner: document.getElementById("ps-github-owner").value.trim(),
      repo: document.getElementById("ps-github-repo").value.trim(),
      token: document.getElementById("ps-github-token").value.trim(),
      poll_interval_secs: parseInt(document.getElementById("ps-github-interval").value) || 60,
    },
    bug_sync: {
      enabled: document.getElementById("ps-bugsync-enabled").checked,
      api_url: document.getElementById("ps-bugsync-url").value.trim(),
      api_token: document.getElementById("ps-bugsync-token").value.trim(),
      interval_secs: parseInt(document.getElementById("ps-bugsync-interval").value) || 300,
    },
  };

  // Deploy config (separate command)
  const el = (id) => document.getElementById(id);
  const deployConfig = {
    deployType: el("ps-deploy-type")?.value || "compose",
    composeFiles: (el("ps-compose-files")?.value || "").split(",").map(s => s.trim()).filter(Boolean),
    envFile: el("ps-env-file")?.value?.trim() || "",
    localUrl: el("ps-local-url")?.value?.trim() || "",
    liveEnabled: el("ps-live-enabled")?.checked || false,
    sshHost: el("ps-ssh-host")?.value?.trim() || "",
    sshKey: el("ps-ssh-key")?.value?.trim() || "",
    sshPort: parseInt(el("ps-ssh-port")?.value) || 22,
    serverPath: el("ps-server-path")?.value?.trim() || "",
    serverBranch: el("ps-server-branch")?.value?.trim() || "main",
    preCommands: (el("ps-pre-commands")?.value || "").split("\n").map(s => s.trim()).filter(Boolean),
    deployCommands: (el("ps-deploy-commands")?.value || "").split("\n").map(s => s.trim()).filter(Boolean),
    postCommands: (el("ps-post-commands")?.value || "").split("\n").map(s => s.trim()).filter(Boolean),
    liveUrl: el("ps-live-url")?.value?.trim() || "",
  };

  try {
    await invoke("save_project_settings", { payload });
    await invoke("save_deploy_config", { config: deployConfig });
    state.deployConfig = deployConfig;

    // Update local state
    if (state.project) {
      state.project.ticket_prefix = payload.ticket_prefix;
    }
    state.projects = await invoke("get_projects");

    closeModal("modal-project-settings");
    showToast(t('settings.saved'), "success");
  } catch (err) {
    appendLog("Save project settings error: " + err, true);
    showToast(String(err), "error");
  }
}

/** Richtet Listener für das Projekt-Settings-Modal ein. */
export function setupProjectSettingsModal() {
  // Tab navigation within the modal
  document.querySelectorAll("#ps-tabs .settings-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#ps-tabs .settings-tab").forEach(t => t.classList.remove("active"));
      const modal = document.getElementById("modal-project-settings");
      modal.querySelectorAll(".settings-tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      const target = modal.querySelector(`[data-tab-content="${tab.dataset.settingsTab}"]`);
      if (target) target.classList.add("active");
    });
  });

  // Save / Cancel
  document.getElementById("btn-ps-save")?.addEventListener("click", saveProjectSettingsForm);
  document.getElementById("btn-ps-cancel")?.addEventListener("click", () => closeModal("modal-project-settings"));
  document.querySelector("#modal-project-settings .modal-close")?.addEventListener("click", () => closeModal("modal-project-settings"));
  document.querySelector("#modal-project-settings .modal-backdrop")?.addEventListener("click", () => closeModal("modal-project-settings"));

  // Logo buttons in project settings
  document.getElementById("ps-upload-logo")?.addEventListener("click", uploadProjectLogo);
  document.getElementById("ps-remove-logo")?.addEventListener("click", removeProjectLogo);

  // Live deploy panel toggle
  document.getElementById("ps-live-enabled")?.addEventListener("change", (e) => {
    const panel = document.getElementById("ps-live-settings-panel");
    if (panel) panel.classList.toggle("collapsed", !e.target.checked);
  });

  // Range label updates
  document.getElementById("ps-github-interval")?.addEventListener("input", (e) => {
    document.getElementById("ps-github-interval-label").textContent = e.target.value + "s";
  });
  document.getElementById("ps-bugsync-interval")?.addEventListener("input", (e) => {
    const v = parseInt(e.target.value);
    document.getElementById("ps-bugsync-interval-label").textContent = v >= 60 ? Math.round(v / 60) + " min" : v + " s";
  });

  // Detect deploy environment
  document.getElementById("ps-detect-env")?.addEventListener("click", async () => {
    const info = document.getElementById("ps-deploy-detection-info");
    if (info) { info.classList.remove("hidden"); info.textContent = t('settings.detecting'); }
    try {
      const result = await invoke("detect_deploy_env");
      if (result.composeFiles?.length > 0) {
        const el = document.getElementById("ps-compose-files");
        if (el) el.value = result.composeFiles.join(", ");
      }
      if (result.envFile) {
        const el = document.getElementById("ps-env-file");
        if (el) el.value = result.envFile;
      }
      if (info) info.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      if (info) info.textContent = String(err);
    }
  });
}
