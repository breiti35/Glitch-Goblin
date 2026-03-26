// ── Settings Module ──
// Global settings form, backup modal, Anthropic OAuth.

import { invoke } from '@tauri-apps/api/core';
import { esc } from './utils.js';
import { state, appendLog, showToast, openModal, closeModal, applyAccentColor, updateThemeUI, modelToFlag } from './app.js';
import { renderBoard } from './board.js';
import { loadShellOptions } from './terminal.js';
import { t, setLocale, getLocale } from './i18n.js';

// ── Settings Form ──

/** Befüllt das Einstellungsformular mit den aktuellen globalen Werten. */
export function loadSettingsForm() {
  const s = state.settings;
  document.getElementById("set-claude-path").value = s.claude_cli_path ?? s.claudeCliPath ?? "claude";
  document.getElementById("set-auto-execute").value = (s.auto_execute_types ?? s.autoExecuteTypes ?? []).join(", ");
  document.getElementById("set-accent-color").value = s.accent_color ?? s.accentColor ?? "#F97316";
  document.getElementById("accent-color-label").textContent = s.accent_color ?? s.accentColor ?? "#F97316";
  document.getElementById("set-theme").value = s.theme || "dark";
  const cardModeEl = document.getElementById("set-card-mode");
  if (cardModeEl) cardModeEl.value = s.card_expand_mode || "click";
  const sortModeEl = document.getElementById("set-ticket-sort");
  if (sortModeEl) sortModeEl.value = s.ticket_sort_mode || "priority";
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
  // Language
  const langEl = document.getElementById("set-language");
  if (langEl) langEl.value = s.language || 'de';
  // Auto-push
  const autoPushEl = document.getElementById("set-auto-push");
  if (autoPushEl) autoPushEl.checked = !!s.auto_push_after_merge;
}

/** Liest das globale Einstellungsformular aus und speichert es. */
export async function saveSettingsForm() {
  const settings = {
    claude_cli_path: document.getElementById("set-claude-path").value.trim(),
    commit_prefix: "",
    auto_execute_types: document.getElementById("set-auto-execute").value.split(",").map(s => s.trim()).filter(Boolean),
    accent_color: document.getElementById("set-accent-color").value,
    theme: document.getElementById("set-theme").value,
    card_expand_mode: document.getElementById("set-card-mode")?.value || "click",
    ticket_sort_mode: document.getElementById("set-ticket-sort")?.value || "priority",
    notifications_enabled: document.getElementById("set-notifications").checked,
    sounds_enabled: document.getElementById("set-sounds").checked,
    backups_enabled: document.getElementById("set-backups").checked,
    max_backups: parseInt(document.getElementById("set-max-backups").value) || 10,
    claude_model: document.getElementById("set-claude-model").value,
    cost_per_input_mtok: parseFloat(document.getElementById("set-cost-input").value) || 3,
    cost_per_output_mtok: parseFloat(document.getElementById("set-cost-output").value) || 15,
    default_shell: document.getElementById("set-default-shell").value,
    terminal_font_size: parseInt(document.getElementById("set-terminal-fontsize").value) || 14,
    language: document.getElementById("set-language")?.value || 'de',
    auto_push_after_merge: document.getElementById("set-auto-push")?.checked || false,
  };

  try {
    await invoke("save_settings", { settings });
    state.settings = { ...state.settings, ...settings };
    document.body.dataset.theme = settings.theme;
    updateThemeUI();
    applyAccentColor(settings.accent_color);
    document.body.dataset.cardMode = settings.card_expand_mode || "click";
    setLocale(settings.language);
    renderBoard();
    appendLog("Settings saved");
    showToast(t('settings.saved'), "success");
  } catch (err) {
    appendLog("Save settings error: " + err, true);
  }
}

// ── Backup Modal ──

/** Öffnet das Backup-Modal und listet alle verfügbaren Backups mit Restore-Schaltfläche auf. */
export async function openBackupModal() {
  openModal("modal-backup");
  const list = document.getElementById("backup-list");
  list.innerHTML = '<p class="empty-state">Loading...</p>';

  try {
    const backups = await invoke("list_backups");
    if (backups.length === 0) {
      list.innerHTML = '<p class="empty-state">' + esc(t('settings.noBackups')) + '</p>';
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
          showToast(t('settings.backupRestored'), "success");
        } catch (err) {
          appendLog("Restore error: " + err, true);
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<p class="empty-state">${esc(String(err))}</p>`;
  }
}

// ── Settings Tab Navigation ──

/** Registriert die Tab-Navigations-Klick-Handler im Einstellungsdialog. */
export function setupSettingsTabs() {
  document.querySelectorAll(".settings-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      // Scope tabs to their parent container to avoid cross-contamination
      const container = tab.closest(".settings-tabs");
      const bentoContainer = container?.parentElement;
      if (!container || !bentoContainer) return;
      container.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
      bentoContainer.querySelectorAll(".settings-tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      const target = bentoContainer.querySelector(`[data-tab-content="${tab.dataset.settingsTab}"]`);
      if (target) target.classList.add("active");
    });
  });
}

// ── Model Preset ──

/** Registriert den Change-Handler für die Modell-Auswahl und befüllt die Kosten-Felder mit Preset-Werten. */
export function setupModelPresetListener() {
  document.getElementById("set-claude-model")?.addEventListener("change", (e) => {
    const val = e.target.value;
    const presets = {
      "claude-sonnet-4-6": [3, 15],
      "claude-sonnet-4-6[1m]": [3, 15],
      "claude-opus-4-6": [15, 75],
      "claude-opus-4-6[1m]": [15, 75],
      "claude-haiku-4-5-20251001": [0.8, 4],
    };
    const p = presets[val];
    if (p) {
      document.getElementById("set-cost-input").value = p[0];
      document.getElementById("set-cost-output").value = p[1];
    }
  });
}

// ── Anthropic OAuth ──

/** Richtet die Event-Listener fuer Anthropic OAuth Login/Logout ein. */
export function setupAnthropicOAuth() {
  const btnLogin = document.getElementById("btn-anthropic-login");
  const btnLogout = document.getElementById("btn-anthropic-logout");

  if (btnLogin) {
    btnLogin.addEventListener("click", async () => {
      btnLogin.disabled = true;
      btnLogin.textContent = t('anthropicOAuth.connecting');
      try {
        const status = await invoke("start_anthropic_login");
        updateAnthropicOAuthUI(status);
        showToast(t('onboarding.oauthSuccess'), "success");
      } catch (err) {
        appendLog("Anthropic OAuth error: " + err, true);
        showToast(t('onboarding.oauthError') + ": " + err, "error");
      } finally {
        btnLogin.disabled = false;
        btnLogin.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle">login</span> ' + esc(t('anthropicOAuth.login'));
      }
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
      try {
        await invoke("anthropic_logout");
        updateAnthropicOAuthUI({ connected: false, accountName: "" });
        showToast(t('anthropicOAuth.statusNotConnected'), "info");
      } catch (err) {
        appendLog("Anthropic logout error: " + err, true);
      }
    });
  }
}

/** Laedt den Anthropic OAuth Status vom Backend und aktualisiert die UI. */
export async function loadAnthropicOAuthStatus() {
  try {
    const status = await invoke("get_anthropic_auth_status");
    updateAnthropicOAuthUI(status);
  } catch (e) {
    // Silently ignore — not critical
  }
}

/** Aktualisiert die Anthropic OAuth UI-Elemente im Settings-Bereich. */
function updateAnthropicOAuthUI(status) {
  const badge = document.getElementById("anthropic-oauth-badge");
  const label = document.getElementById("anthropic-oauth-label");
  const account = document.getElementById("anthropic-oauth-account");
  const btnLogin = document.getElementById("btn-anthropic-login");
  const btnLogout = document.getElementById("btn-anthropic-logout");

  if (!badge) return;

  if (status.connected) {
    badge.className = "anthropic-oauth-badge connected";
    if (label) label.textContent = t('anthropicOAuth.statusConnected');
    if (account) {
      account.textContent = t('anthropicOAuth.connectedAs') + ": " + (status.accountName || "Anthropic");
      account.classList.remove("hidden");
    }
    if (btnLogin) btnLogin.classList.add("hidden");
    if (btnLogout) btnLogout.classList.remove("hidden");
  } else {
    badge.className = "anthropic-oauth-badge disconnected";
    if (label) label.textContent = t('anthropicOAuth.statusNotConnected');
    if (account) account.classList.add("hidden");
    if (btnLogin) btnLogin.classList.remove("hidden");
    if (btnLogout) btnLogout.classList.add("hidden");
  }
}
