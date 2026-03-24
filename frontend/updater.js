// ── Updater Module ──
// Auto-update check via Tauri Updater Plugin + GitHub Releases.

import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { state, showToast, openModal, closeModal, appendLog } from './app.js';
import { t } from './i18n.js';

let currentUpdate = null;

// Close-Handler fuer Modal (X-Button + Backdrop)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-updater-modal-close')?.addEventListener('click', () => closeModal('modal-updater'));
  document.querySelector('#modal-updater .modal-backdrop')?.addEventListener('click', () => closeModal('modal-updater'));
});

/** Startet den Update-Check nach 5 Sekunden Verzoegerung beim App-Start. */
export function scheduleUpdateCheck() {
  setTimeout(() => {
    checkForUpdate(true);
  }, 5000);
}

/**
 * Prueft auf verfuegbare Updates.
 * @param {boolean} silent - Bei true werden keine Toasts bei "kein Update" angezeigt.
 */
export async function checkForUpdate(silent = false) {
  try {
    const update = await check();
    if (update) {
      currentUpdate = update;
      showUpdateAvailable(update);
    } else if (!silent) {
      showToast(t('updater.upToDate') || 'App ist aktuell', 'success');
    }
  } catch (err) {
    appendLog('Update-Check fehlgeschlagen: ' + err, true);
    if (!silent) {
      showToast(t('updater.checkFailed') || 'Update-Check fehlgeschlagen', 'error');
    }
  }
}

/** Zeigt das Update-Modal mit Zustand 1: Update gefunden. */
function showUpdateAvailable(update) {
  const modal = document.getElementById('modal-updater');
  if (!modal) return;

  // Zustand 1: Update gefunden
  const body = modal.querySelector('.updater-body');
  const version = update.version || '?';
  const notes = update.body || '';

  body.innerHTML = `
    <div class="updater-info">
      <div class="updater-version-row">
        <span class="material-symbols-outlined updater-icon">system_update</span>
        <div>
          <div class="updater-version-label">${escHtml(t('updater.newVersion') || 'Neue Version verfuegbar')}</div>
          <div class="updater-version-number">v${escHtml(version)}</div>
        </div>
      </div>
      ${notes ? `<div class="updater-notes">${renderMarkdown(escHtml(notes))}</div>` : ''}
    </div>
    <div class="updater-actions">
      <button class="btn-primary" id="btn-updater-install">
        <span class="material-symbols-outlined" style="font-size:16px">download</span>
        ${escHtml(t('updater.installNow') || 'Jetzt aktualisieren')}
      </button>
      <button class="btn-secondary" id="btn-updater-later">
        ${escHtml(t('updater.later') || 'Spaeter')}
      </button>
    </div>
  `;

  document.getElementById('btn-updater-install').addEventListener('click', () => installUpdate());
  document.getElementById('btn-updater-later').addEventListener('click', () => closeModal('modal-updater'));

  openModal('modal-updater');
}

/** Zustand 2: Download laeuft — Fortschrittsanzeige. */
async function installUpdate() {
  if (!currentUpdate) return;
  const body = document.querySelector('#modal-updater .updater-body');

  body.innerHTML = `
    <div class="updater-progress">
      <span class="material-symbols-outlined updater-icon updater-icon-spin">sync</span>
      <div class="updater-progress-label">${escHtml(t('updater.downloading') || 'Update wird heruntergeladen...')}</div>
      <div class="updater-progress-bar-track">
        <div class="updater-progress-bar-fill" id="updater-progress-fill"></div>
      </div>
      <div class="updater-progress-pct" id="updater-progress-pct">0%</div>
    </div>
  `;

  try {
    let downloaded = 0;
    let contentLength = 0;

    await currentUpdate.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          contentLength = event.data.contentLength || 0;
          break;
        case 'Progress':
          downloaded += event.data.chunkLength || 0;
          if (contentLength > 0) {
            const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
            const fill = document.getElementById('updater-progress-fill');
            const label = document.getElementById('updater-progress-pct');
            if (fill) fill.style.width = pct + '%';
            if (label) label.textContent = pct + '%';
          }
          break;
        case 'Finished':
          break;
      }
    });

    // Zustand 3: Fertig — Neustart-Prompt
    showRestartPrompt();
  } catch (err) {
    appendLog('Update-Installation fehlgeschlagen: ' + err, true);
    body.innerHTML = `
      <div class="updater-error">
        <span class="material-symbols-outlined updater-icon" style="color:var(--danger)">error</span>
        <div class="updater-progress-label">${escHtml(t('updater.installFailed') || 'Installation fehlgeschlagen')}</div>
        <div class="updater-error-detail">${escHtml(String(err))}</div>
        <div class="updater-actions">
          <button class="btn-secondary" id="btn-updater-close-err">${escHtml(t('updater.close') || 'Schliessen')}</button>
        </div>
      </div>
    `;
    document.getElementById('btn-updater-close-err').addEventListener('click', () => closeModal('modal-updater'));
  }
}

/** Zustand 3: Update installiert — Neustart anbieten. */
function showRestartPrompt() {
  const body = document.querySelector('#modal-updater .updater-body');
  body.innerHTML = `
    <div class="updater-done">
      <span class="material-symbols-outlined updater-icon" style="color:var(--success)">check_circle</span>
      <div class="updater-progress-label">${escHtml(t('updater.installed') || 'Update installiert!')}</div>
      <div class="updater-done-sub">${escHtml(t('updater.restartHint') || 'Die App muss neu gestartet werden, um das Update zu aktivieren.')}</div>
      <div class="updater-actions">
        <button class="btn-primary" id="btn-updater-restart">
          <span class="material-symbols-outlined" style="font-size:16px">restart_alt</span>
          ${escHtml(t('updater.restart') || 'Jetzt neu starten')}
        </button>
        <button class="btn-secondary" id="btn-updater-later2">
          ${escHtml(t('updater.later') || 'Spaeter')}
        </button>
      </div>
    </div>
  `;
  document.getElementById('btn-updater-restart').addEventListener('click', async () => {
    try {
      await relaunch();
    } catch (err) {
      appendLog('Relaunch fehlgeschlagen: ' + err, true);
    }
  });
  document.getElementById('btn-updater-later2').addEventListener('click', () => closeModal('modal-updater'));
}

// ── Helpers ──

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Einfaches Markdown-Rendering fuer Release Notes (bold, links, lists). */
function renderMarkdown(html) {
  return html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}
