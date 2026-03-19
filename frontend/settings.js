// ── Settings Module ──
// Settings form, backup modal.

import { invoke } from '@tauri-apps/api/core';
import { esc } from './utils.js';
import { state, appendLog, openModal, closeModal, applyAccentColor, updateThemeUI, modelToFlag } from './app.js';
import { renderBoard } from './board.js';
import { loadShellOptions } from './terminal.js';
import { saveDeploySettingsForm } from './deploy.js';
import { updateBugSyncVisibility } from './bugsync.js';

// ── Settings Form ──

export function loadSettingsForm() {
  const s = state.settings;
  document.getElementById("set-claude-path").value = s.claude_cli_path ?? s.claudeCliPath ?? "claude";
  document.getElementById("set-commit-prefix").value = s.commit_prefix ?? s.commitPrefix ?? "kanban:";
  document.getElementById("set-auto-execute").value = (s.auto_execute_types ?? s.autoExecuteTypes ?? []).join(", ");
  document.getElementById("set-accent-color").value = s.accent_color ?? s.accentColor ?? "#F97316";
  document.getElementById("accent-color-label").textContent = s.accent_color ?? s.accentColor ?? "#F97316";
  document.getElementById("set-theme").value = s.theme || "dark";
  document.getElementById("set-notifications").checked = s.notifications_enabled !== false;
  document.getElementById("set-sounds").checked = s.sounds_enabled !== false;
  document.getElementById("set-backups").checked = s.backups_enabled !== false;
  document.getElementById("set-max-backups").value = s.max_backups || 10;
  document.getElementById("max-backups-label").textContent = s.max_backups || 10;
  document.getElementById("set-claude-model").value = modelToFlag(s.claude_model || "claude-sonnet-4-6");
  document.getElementById("set-cost-input").value = s.cost_per_input_mtok ?? 3;
  document.getElementById("set-cost-output").value = s.cost_per_output_mtok ?? 15;
  document.getElementById("set-terminal-fontsize").value = s.terminal_font_size || 14;
  document.getElementById("terminal-fontsize-label").textContent = (s.terminal_font_size || 14) + "px";
  loadShellOptions("set-default-shell", s.default_shell || "");
  // Bug-Sync settings
  const bs = s.bug_sync || {};
  document.getElementById("set-bugsync-enabled").checked = !!bs.enabled;
  document.getElementById("set-bugsync-url").value = bs.api_url || "";
  document.getElementById("set-bugsync-token").value = "";
  document.getElementById("set-bugsync-token").placeholder = bs.api_token_set ? "(Token gesetzt)" : "Secret oder JWT Token";
  document.getElementById("set-bugsync-interval").value = bs.interval_secs || 300;
  const bsInterval = bs.interval_secs || 300;
  document.getElementById("bugsync-interval-label").textContent = bsInterval >= 60 ? Math.round(bsInterval / 60) + " min" : bsInterval + " s";
}

export async function saveSettingsForm() {
  const settings = {
    claude_cli_path: document.getElementById("set-claude-path").value.trim(),
    commit_prefix: document.getElementById("set-commit-prefix").value.trim(),
    auto_execute_types: document.getElementById("set-auto-execute").value.split(",").map(s => s.trim()).filter(Boolean),
    accent_color: document.getElementById("set-accent-color").value,
    theme: document.getElementById("set-theme").value,
    notifications_enabled: document.getElementById("set-notifications").checked,
    sounds_enabled: document.getElementById("set-sounds").checked,
    backups_enabled: document.getElementById("set-backups").checked,
    max_backups: parseInt(document.getElementById("set-max-backups").value) || 10,
    claude_model: document.getElementById("set-claude-model").value,
    cost_per_input_mtok: parseFloat(document.getElementById("set-cost-input").value) || 3,
    cost_per_output_mtok: parseFloat(document.getElementById("set-cost-output").value) || 15,
    default_shell: document.getElementById("set-default-shell").value,
    terminal_font_size: parseInt(document.getElementById("set-terminal-fontsize").value) || 14,
    bug_sync: {
      enabled: document.getElementById("set-bugsync-enabled").checked,
      api_url: document.getElementById("set-bugsync-url").value.trim(),
      api_token: document.getElementById("set-bugsync-token").value.trim(),
      interval_secs: parseInt(document.getElementById("set-bugsync-interval").value) || 300,
    },
  };

  try {
    await invoke("save_settings", { settings });
    const prevTokenSet = state.settings.bug_sync?.api_token_set ?? false;
    state.settings = settings;
    state.settings.bug_sync.api_token_set = settings.bug_sync.api_token ? true : prevTokenSet;
    state.settings.bug_sync.api_token = "";
    document.body.dataset.theme = settings.theme;
    updateThemeUI();
    applyAccentColor(settings.accent_color);
    updateBugSyncVisibility();
    await saveDeploySettingsForm();
    appendLog("Settings saved");
  } catch (err) {
    appendLog("Save settings error: " + err, true);
  }
}

// ── Backup Modal ──

export async function openBackupModal() {
  openModal("modal-backup");
  const list = document.getElementById("backup-list");
  list.innerHTML = '<p class="empty-state">Loading...</p>';

  try {
    const backups = await invoke("list_backups");
    if (backups.length === 0) {
      list.innerHTML = '<p class="empty-state">No backups found</p>';
      return;
    }
    list.innerHTML = backups.map(b => `
      <div class="backup-item">
        <span class="backup-name">${esc(b)}</span>
        <button class="btn-secondary backup-restore" data-backup="${esc(b)}">Restore</button>
      </div>
    `).join("");

    list.querySelectorAll(".backup-restore").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Restore backup "${btn.dataset.backup}"? Current board will be overwritten.`)) return;
        try {
          state.board = await invoke("restore_backup", { filename: btn.dataset.backup });
          closeModal("modal-backup");
          renderBoard();
          appendLog("Backup restored: " + btn.dataset.backup);
        } catch (err) {
          appendLog("Restore error: " + err, true);
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<p class="empty-state">${esc(String(err))}</p>`;
  }
}

// ── Model Preset ──

export function setupModelPresetListener() {
  document.getElementById("set-claude-model")?.addEventListener("change", (e) => {
    const presets = { sonnet: [3, 15], opus: [15, 75] };
    const p = presets[e.target.value];
    if (p) {
      document.getElementById("set-cost-input").value = p[0];
      document.getElementById("set-cost-output").value = p[1];
    }
  });
}
