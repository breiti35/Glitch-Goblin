// ── Deploy Module ──
// Docker/SSH deploy operations.

import { invoke } from '@tauri-apps/api/core';
import { esc, shellEscape, shellEscapeLocal, validateDeployParam } from './utils.js';
import { state, appendLog, openModal, closeModal } from './app.js';
import { openDeployTerminal } from './terminal.js';

// ── Deploy Listeners ──

export function setupDeployListeners() {
  document.getElementById("btn-local-deploy")?.addEventListener("click", confirmLocalDeploy);
  document.getElementById("btn-live-deploy")?.addEventListener("click", confirmLiveDeploy);
  document.getElementById("btn-detect-env")?.addEventListener("click", detectDeployEnvironment);
  document.getElementById("btn-deploy-confirm-yes")?.addEventListener("click", () => {
    const action = document.getElementById("modal-deploy-confirm").dataset.action;
    closeModal("modal-deploy-confirm");
    if (action === "local") executeLocalDeploy();
    else if (action === "local-stop") executeLocalDeployStop();
    else if (action === "live") executeLiveDeploy();
  });
  document.getElementById("btn-deploy-confirm-no")?.addEventListener("click", () => {
    closeModal("modal-deploy-confirm");
  });
  document.getElementById("set-live-enabled")?.addEventListener("change", (e) => {
    const panel = document.getElementById("live-settings-panel");
    if (panel) {
      panel.classList.toggle("collapsed", !e.target.checked);
    }
  });
}

// ── Deploy Config ──

export async function loadDeployConfig() {
  try {
    state.deployConfig = await invoke("get_deploy_config");
    updateDeployButtons();
    loadDeploySettingsForm();
  } catch (e) {
    appendLog("Deploy-Konfiguration konnte nicht geladen werden: " + e, true);
  }
}

function updateDeployButtons() {
  const cfg = state.deployConfig;
  const localBtn = document.getElementById("btn-local-deploy");
  const liveBtn = document.getElementById("btn-live-deploy");
  if (!cfg) {
    localBtn?.classList.add("hidden");
    liveBtn?.classList.add("hidden");
    return;
  }
  if (cfg.composeFiles?.length > 0 || cfg.deployType === "compose") {
    localBtn?.classList.remove("hidden");
  } else {
    localBtn?.classList.add("hidden");
  }
  if (cfg.liveEnabled && cfg.sshHost) {
    liveBtn?.classList.remove("hidden");
  } else {
    liveBtn?.classList.add("hidden");
  }
}

// ── Local Deploy ──

function confirmLocalDeploy() {
  const cfg = state.deployConfig;
  if (!cfg) return;
  const modal = document.getElementById("modal-deploy-confirm");
  modal.dataset.action = "local";
  document.getElementById("deploy-confirm-title").textContent = "Lokal testen (Docker)";
  document.getElementById("deploy-confirm-message").textContent = "Docker Compose starten?";

  const files = (cfg.composeFiles?.length > 0) ? cfg.composeFiles : ["docker-compose.yml"];
  let cmd = "docker compose";
  files.forEach(f => cmd += ` -f ${f}`);
  if (cfg.envFile) cmd += ` --env-file ${cfg.envFile}`;
  cmd += " up --build -d";
  document.getElementById("deploy-confirm-details").textContent = cmd;
  openModal("modal-deploy-confirm");
}

async function executeLocalDeploy() {
  state.deployingLocal = true;
  updateDeployBadge("deploying", "Deploying...");
  try {
    const terminalId = await invoke("local_deploy");
    openDeployTerminal(terminalId, "Local Deploy");

    const cfg = state.deployConfig;
    const files = (cfg.composeFiles?.length > 0) ? cfg.composeFiles : [];
    let cmd = "docker compose";
    files.forEach(f => cmd += ` -f ${shellEscapeLocal(f)}`);
    if (cfg.envFile) cmd += ` --env-file ${shellEscapeLocal(cfg.envFile)}`;
    cmd += " up --build -d\r";
    setTimeout(() => {
      invoke("write_terminal", { terminalId, data: cmd }).catch(e => console.warn("deploy: write", e));
    }, 1500);

    updateDeployBadge("success", "Local running");
    state.deployingLocal = false;
  } catch (e) {
    updateDeployBadge("error", "Deploy failed");
    state.deployingLocal = false;
    appendLog("Local deploy error: " + e, true);
  }
}

// ── Live Deploy ──

function confirmLiveDeploy() {
  const cfg = state.deployConfig;
  if (!cfg || !cfg.liveEnabled) return;
  const modal = document.getElementById("modal-deploy-confirm");
  modal.dataset.action = "live";
  document.getElementById("deploy-confirm-title").textContent = "Live deployen";
  document.getElementById("deploy-confirm-message").textContent = `Deploy zu ${cfg.sshHost}?`;

  const allCmds = [
    ...(cfg.preCommands || []),
    ...(cfg.deployCommands || []),
    ...(cfg.postCommands || []),
  ].filter(Boolean);
  let preview = "ssh";
  if (cfg.sshKey) preview += ` -i ${cfg.sshKey}`;
  if (cfg.sshPort && cfg.sshPort !== 22) preview += ` -p ${cfg.sshPort}`;
  preview += ` ${cfg.sshHost}`;
  if (cfg.serverPath || allCmds.length > 0) {
    const remoteParts = [];
    if (cfg.serverPath) remoteParts.push(`cd ${cfg.serverPath}`);
    remoteParts.push(...allCmds);
    preview += `\n"${remoteParts.join(" && ")}"`;
  }
  document.getElementById("deploy-confirm-details").textContent = preview;
  openModal("modal-deploy-confirm");
}

async function executeLiveDeploy() {
  state.deployingLive = true;
  updateDeployBadge("deploying", "Deploying live...");
  try {
    const terminalId = await invoke("live_deploy");
    openDeployTerminal(terminalId, "Live Deploy");

    const cfg = state.deployConfig;
    if (!validateDeployParam("SSH host", cfg.sshHost) ||
        !validateDeployParam("SSH key", cfg.sshKey) ||
        !validateDeployParam("Server path", cfg.serverPath)) {
      state.deployingLive = false;
      updateDeployBadge("error", "Invalid deploy config");
      return;
    }
    const allCmds = [
      ...(cfg.preCommands || []),
      ...(cfg.deployCommands || []),
      ...(cfg.postCommands || []),
    ].filter(Boolean);

    for (const cmd of allCmds) {
      if (!validateDeployParam("Deploy command", cmd)) {
        state.deployingLive = false;
        updateDeployBadge("error", "Invalid deploy command");
        return;
      }
    }

    let sshCmd = "ssh";
    if (cfg.sshKey) sshCmd += ` -i ${shellEscapeLocal(cfg.sshKey)}`;
    if (cfg.sshPort && cfg.sshPort !== 22) sshCmd += ` -p ${cfg.sshPort}`;
    sshCmd += ` ${shellEscapeLocal(cfg.sshHost)}`;
    if (cfg.serverPath || allCmds.length > 0) {
      const remoteParts = [];
      if (cfg.serverPath) remoteParts.push(`cd ${shellEscape(cfg.serverPath)}`);
      remoteParts.push(...allCmds);
      sshCmd += ` "${remoteParts.join(" && ")}"`;
    }
    sshCmd += "\r";

    setTimeout(() => {
      invoke("write_terminal", { terminalId, data: sshCmd }).catch(e => console.warn("deploy: write", e));
    }, 1500);

    updateDeployBadge("success", "Live deployed");
    state.deployingLive = false;
  } catch (e) {
    updateDeployBadge("error", "Live deploy failed");
    state.deployingLive = false;
    appendLog("Live deploy error: " + e, true);
  }
}

async function executeLocalDeployStop() {
  try {
    const terminalId = await invoke("local_deploy_stop");
    openDeployTerminal(terminalId, "Docker Stop");

    const cfg = state.deployConfig;
    const files = (cfg.composeFiles?.length > 0) ? cfg.composeFiles : [];
    let cmd = "docker compose";
    files.forEach(f => cmd += ` -f ${f}`);
    cmd += " down\r";
    setTimeout(() => {
      invoke("write_terminal", { terminalId, data: cmd }).catch(e => console.warn("deploy: write", e));
    }, 1500);

    updateDeployBadge("hidden", "");
  } catch (e) {
    appendLog("Docker stop error: " + e, true);
  }
}

function updateDeployBadge(status, text) {
  const badge = document.getElementById("deploy-status-badge");
  if (!badge) return;
  badge.className = "deploy-badge";
  if (status === "hidden") {
    badge.classList.add("hidden");
    badge.textContent = "";
    return;
  }
  badge.classList.remove("hidden");
  badge.classList.add(status);
  badge.textContent = text;
}

// ── Deploy Environment Detection ──

async function detectDeployEnvironment() {
  const info = document.getElementById("deploy-detection-info");
  if (!info) return;
  info.classList.remove("hidden");
  info.innerHTML = '<span class="text-muted">Detecting...</span>';

  try {
    const env = await invoke("detect_deploy_env");
    let html = "";

    if (env.docker.installed) {
      html += `<div class="detect-item detect-ok">&#10004; Docker: ${esc(env.docker.version)}</div>`;
      html += `<div class="detect-item ${env.docker.running ? 'detect-ok' : 'detect-warn'}">
        ${env.docker.running ? '&#10004;' : '&#9888;'} Docker Daemon: ${env.docker.running ? 'Running' : 'Not Running'}</div>`;
      html += `<div class="detect-item ${env.docker.composeAvailable ? 'detect-ok' : 'detect-warn'}">
        ${env.docker.composeAvailable ? '&#10004;' : '&#9888;'} Docker Compose: ${env.docker.composeAvailable ? 'Available' : 'Not Found'}</div>`;
    } else {
      html += '<div class="detect-item detect-missing">&#10008; Docker: Not Installed</div>';
    }

    if (env.composeFiles.length > 0) {
      html += `<div class="detect-item detect-ok">&#10004; Compose Files: ${env.composeFiles.map(esc).join(', ')}</div>`;
      const composeInput = document.getElementById("set-compose-files");
      if (composeInput && !composeInput.value) {
        composeInput.value = env.composeFiles.join(", ");
      }
    } else {
      html += '<div class="detect-item detect-missing">&#10008; No Compose files found</div>';
    }

    if (env.envFiles.length > 0) {
      html += `<div class="detect-item detect-ok">&#10004; Env Files: ${env.envFiles.map(esc).join(', ')}</div>`;
      const envInput = document.getElementById("set-env-file");
      if (envInput && !envInput.value && env.envFiles.length > 0) {
        envInput.value = env.envFiles[0];
      }
    }

    html += `<div class="detect-item ${env.sshAvailable ? 'detect-ok' : 'detect-missing'}">
      ${env.sshAvailable ? '&#10004;' : '&#10008;'} SSH: ${env.sshAvailable ? 'Available' : 'Not Found'}</div>`;
    if (env.sshKeys.length > 0) {
      html += `<div class="detect-item detect-ok">&#10004; SSH Keys: ${env.sshKeys.length} found</div>`;
    }

    if (env.hasCargoToml) html += '<div class="detect-item detect-ok">&#10004; Rust project (Cargo.toml)</div>';
    if (env.hasPackageJson) html += '<div class="detect-item detect-ok">&#10004; Node.js project (package.json)</div>';

    info.innerHTML = html;
  } catch (e) {
    info.innerHTML = `<div class="detect-item detect-warn">&#9888; Detection failed: ${esc(String(e))}</div>`;
  }
}

// ── Deploy Settings Form ──

export function loadDeploySettingsForm() {
  const cfg = state.deployConfig;
  if (!cfg) return;
  const el = (id) => document.getElementById(id);
  if (el("set-deploy-type")) el("set-deploy-type").value = cfg.deployType || "compose";
  if (el("set-compose-files")) el("set-compose-files").value = (cfg.composeFiles || []).join(", ");
  if (el("set-env-file")) el("set-env-file").value = cfg.envFile || "";
  if (el("set-local-url")) el("set-local-url").value = cfg.localUrl || "";
  if (el("set-live-enabled")) el("set-live-enabled").checked = !!cfg.liveEnabled;
  if (el("set-ssh-host")) el("set-ssh-host").value = cfg.sshHost || "";
  if (el("set-ssh-key")) el("set-ssh-key").value = cfg.sshKey || "";
  if (el("set-ssh-port")) el("set-ssh-port").value = cfg.sshPort || 22;
  if (el("set-server-path")) el("set-server-path").value = cfg.serverPath || "";
  if (el("set-server-branch")) el("set-server-branch").value = cfg.serverBranch || "main";
  if (el("set-pre-commands")) el("set-pre-commands").value = (cfg.preCommands || []).join("\n");
  if (el("set-deploy-commands")) el("set-deploy-commands").value = (cfg.deployCommands || []).join("\n");
  if (el("set-post-commands")) el("set-post-commands").value = (cfg.postCommands || []).join("\n");
  if (el("set-live-url")) el("set-live-url").value = cfg.liveUrl || "";

  const livePanel = document.getElementById("live-settings-panel");
  if (livePanel) livePanel.classList.toggle("collapsed", !cfg.liveEnabled);
}

export async function saveDeploySettingsForm() {
  const el = (id) => document.getElementById(id);
  const config = {
    deployType: el("set-deploy-type")?.value || "compose",
    composeFiles: (el("set-compose-files")?.value || "").split(",").map(s => s.trim()).filter(Boolean),
    envFile: el("set-env-file")?.value?.trim() || "",
    localUrl: el("set-local-url")?.value?.trim() || "",
    liveEnabled: el("set-live-enabled")?.checked || false,
    sshHost: el("set-ssh-host")?.value?.trim() || "",
    sshKey: el("set-ssh-key")?.value?.trim() || "",
    sshPort: parseInt(el("set-ssh-port")?.value) || 22,
    serverPath: el("set-server-path")?.value?.trim() || "",
    serverBranch: el("set-server-branch")?.value?.trim() || "main",
    preCommands: (el("set-pre-commands")?.value || "").split("\n").map(s => s.trim()).filter(Boolean),
    deployCommands: (el("set-deploy-commands")?.value || "").split("\n").map(s => s.trim()).filter(Boolean),
    postCommands: (el("set-post-commands")?.value || "").split("\n").map(s => s.trim()).filter(Boolean),
    liveUrl: el("set-live-url")?.value?.trim() || "",
  };

  try {
    await invoke("save_deploy_config", { config });
    state.deployConfig = config;
    updateDeployButtons();
  } catch (e) {
    appendLog("Save deploy config error: " + e, true);
  }
}
