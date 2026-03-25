// ── Onboarding Wizard (GG-105) ──
// Welcome-Modal beim allerersten App-Start (kein Projekt konfiguriert).

import { invoke } from '@tauri-apps/api/core';
import { state, openModal, closeModal, appendLog } from './app.js';
import { renderBoard, clearFilters } from './board.js';
import { updateSidebar, updateAvatar, loadClaudeUsage } from './projects.js';
import { checkGitStatus, loadGitView } from './git.js';
import { updateGitWarnings } from './app.js';
import { loadDeployConfig } from './deploy.js';
import { loadDashboard } from './dashboard.js';
import { showToast } from './notifications.js';
import { t } from './i18n.js';
import { loadSettingsForm } from './settings.js';
import { esc } from './utils.js';

let currentStep = 0;
const TOTAL_STEPS = 5;

// Wizard state
let wizardData = {
  folderPath: null,
  projectName: '',
  isGitRepo: false,
  ticketPrefix: '',
  claudePath: '',
  claudeFound: false,
  claudeVersion: '',
};

/** Prueft ob das Onboarding angezeigt werden soll und oeffnet ggf. den Wizard. */
export function checkOnboarding() {
  if (state.projects && state.projects.length > 0) return;
  // Kein Projekt vorhanden — Onboarding starten
  currentStep = 0;
  wizardData = {
    folderPath: null,
    projectName: '',
    isGitRepo: false,
    ticketPrefix: '',
    claudePath: '',
    claudeFound: false,
    claudeVersion: '',
  };
  showStep(0);
  openModal('modal-onboarding');
}

/** Richtet alle Event-Listener fuer den Onboarding-Wizard ein. */
export function setupOnboarding() {
  const btnNext = document.getElementById('ob-btn-next');
  const btnBack = document.getElementById('ob-btn-back');
  const btnPickFolder = document.getElementById('ob-pick-folder');
  const btnClaudeRecheck = document.getElementById('ob-claude-recheck');

  if (btnNext) btnNext.addEventListener('click', onNext);
  if (btnBack) btnBack.addEventListener('click', onBack);
  if (btnPickFolder) btnPickFolder.addEventListener('click', pickFolder);
  if (btnClaudeRecheck) btnClaudeRecheck.addEventListener('click', checkClaude);

  // Auto-generate prefix when project name changes
  const nameInput = document.getElementById('ob-project-name');
  if (nameInput) {
    nameInput.addEventListener('input', () => {
      const name = nameInput.value.trim();
      if (name && !document.getElementById('ob-ticket-prefix')._userEdited) {
        document.getElementById('ob-ticket-prefix').value = derivePrefix(name);
      }
    });
  }

  // Track manual prefix edits
  const prefixInput = document.getElementById('ob-ticket-prefix');
  if (prefixInput) {
    prefixInput.addEventListener('input', () => {
      prefixInput._userEdited = true;
      prefixInput.value = prefixInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
  }
}

function derivePrefix(name) {
  // Take first 2-3 uppercase letters from project name
  const clean = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (clean.length <= 3) return clean || 'GG';
  // Try word initials first
  const words = name.split(/[\s\-_]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return clean.slice(0, 2);
}

function showStep(step) {
  currentStep = step;

  // Update stepper dots
  document.querySelectorAll('.onboarding-step').forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.toggle('active', s === step);
    el.classList.toggle('done', s < step);
  });

  // Update pages
  document.querySelectorAll('.onboarding-page').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.page) === step);
  });

  // Update navigation buttons
  const btnBack = document.getElementById('ob-btn-back');
  const btnNext = document.getElementById('ob-btn-next');

  if (btnBack) btnBack.classList.toggle('hidden', step === 0);

  if (btnNext) {
    if (step === 0) {
      btnNext.textContent = t('onboarding.letsStart');
    } else if (step === TOTAL_STEPS - 1) {
      btnNext.textContent = t('onboarding.finish');
    } else {
      btnNext.textContent = t('onboarding.next');
    }
  }

  // Step-specific actions
  if (step === 3) {
    checkClaude();
  }
  if (step === 4) {
    updateSummary();
  }
}

async function onNext() {
  // Validation per step
  if (currentStep === 1) {
    if (!wizardData.folderPath) {
      showToast(t('onboarding.noFolder'), 'error');
      return;
    }
    if (!wizardData.isGitRepo) {
      showToast(t('onboarding.notGitRepo'), 'error');
      return;
    }
    wizardData.projectName = document.getElementById('ob-project-name').value.trim();
    if (!wizardData.projectName) {
      showToast(t('onboarding.projectName') + '!', 'error');
      return;
    }
  }

  if (currentStep === 2) {
    const prefix = document.getElementById('ob-ticket-prefix').value.trim().toUpperCase();
    if (!prefix || !/^[A-Z0-9]+$/.test(prefix)) {
      showToast(t('onboarding.ticketPrefix') + '!', 'error');
      return;
    }
    wizardData.ticketPrefix = prefix;
  }

  if (currentStep === 3) {
    wizardData.claudePath = document.getElementById('ob-claude-path').value.trim();
  }

  if (currentStep === TOTAL_STEPS - 1) {
    // Final step — create project
    await finishOnboarding();
    return;
  }

  showStep(currentStep + 1);
}

function onBack() {
  if (currentStep > 0) {
    showStep(currentStep - 1);
  }
}

async function pickFolder() {
  try {
    const folder = await invoke('pick_folder');
    if (!folder) return;

    wizardData.folderPath = folder;

    // Show folder info
    const info = document.getElementById('ob-folder-info');
    const pathEl = document.getElementById('ob-folder-path');
    const gitEl = document.getElementById('ob-git-status');

    if (info) info.classList.remove('hidden');
    if (pathEl) pathEl.textContent = folder.replace(/^\\\\\?\\/, '');

    // Derive project name from folder
    const parts = folder.replace(/\\/g, '/').split('/');
    const name = parts[parts.length - 1] || 'project';
    const nameInput = document.getElementById('ob-project-name');
    if (nameInput) {
      nameInput.value = name;
      wizardData.projectName = name;
    }

    // Auto-derive prefix
    const prefixInput = document.getElementById('ob-ticket-prefix');
    if (prefixInput && !prefixInput._userEdited) {
      prefixInput.value = derivePrefix(name);
      wizardData.ticketPrefix = prefixInput.value;
    }

    // Check if git repo
    if (gitEl) {
      gitEl.className = 'ob-git-status';
      gitEl.textContent = t('onboarding.checking');
    }

    try {
      const isGit = await invoke('validate_git_repo', { path: folder });
      wizardData.isGitRepo = isGit;
      if (gitEl) {
        if (isGit) {
          gitEl.className = 'ob-git-status ok';
          gitEl.innerHTML = '&#10004; ' + esc(t('onboarding.isGitRepo'));
        } else {
          gitEl.className = 'ob-git-status err';
          gitEl.innerHTML = '&#10008; ' + esc(t('onboarding.notGitRepo'));
        }
      }
    } catch (err) {
      wizardData.isGitRepo = false;
      if (gitEl) {
        gitEl.className = 'ob-git-status err';
        gitEl.innerHTML = '&#10008; ' + esc(String(err));
      }
    }
  } catch (err) {
    appendLog('Onboarding pick folder error: ' + err, true);
  }
}

async function checkClaude() {
  const statusEl = document.getElementById('ob-claude-status');
  const cliPath = document.getElementById('ob-claude-path')?.value?.trim() || '';

  if (statusEl) {
    statusEl.className = 'ob-claude-status';
    statusEl.innerHTML = '<span class="ob-claude-spinner"></span> ' + esc(t('onboarding.checking'));
  }

  try {
    const version = await invoke('check_claude_cli', { cliPath: cliPath || null });
    wizardData.claudeFound = true;
    wizardData.claudeVersion = version;
    if (statusEl) {
      statusEl.className = 'ob-claude-status ok';
      statusEl.innerHTML = '&#10004; ' + esc(t('onboarding.claudeFound')) + ' <span class="text-muted text-small">(' + esc(version) + ')</span>';
    }
  } catch (err) {
    wizardData.claudeFound = false;
    wizardData.claudeVersion = '';
    if (statusEl) {
      statusEl.className = 'ob-claude-status err';
      statusEl.innerHTML = '&#9888; ' + esc(t('onboarding.claudeNotFound'));
    }
  }
}

function updateSummary() {
  const projectEl = document.getElementById('ob-summary-project');
  const prefixEl = document.getElementById('ob-summary-prefix');
  const claudeEl = document.getElementById('ob-summary-claude');

  if (projectEl) projectEl.textContent = wizardData.projectName;
  if (prefixEl) prefixEl.textContent = wizardData.ticketPrefix;
  if (claudeEl) {
    if (wizardData.claudeFound) {
      claudeEl.textContent = '✓ ' + t('onboarding.available');
      claudeEl.style.color = 'var(--green, #22c55e)';
    } else {
      claudeEl.textContent = '✗ ' + t('onboarding.notAvailable');
      claudeEl.style.color = 'var(--red, #ef4444)';
    }
  }
}

async function finishOnboarding() {
  try {
    // 1. Add project
    await invoke('add_project', {
      name: wizardData.projectName,
      path: wizardData.folderPath,
    });

    // 2. Set ticket prefix
    if (wizardData.ticketPrefix) {
      await invoke('set_ticket_prefix', {
        projectName: wizardData.projectName,
        prefix: wizardData.ticketPrefix,
      });
    }

    // 3. Save Claude CLI path in settings if custom
    if (wizardData.claudePath) {
      const settings = { ...state.settings, claude_cli_path: wizardData.claudePath };
      await invoke('save_settings', { settings });
      state.settings = settings;
    }

    // 4. Switch to the new project
    state.board = await invoke('switch_project', { name: wizardData.projectName });
    state.project = await invoke('get_current_project');
    state.projects = await invoke('get_projects');
    state.runningTicket = await invoke('get_running_ticket');

    closeModal('modal-onboarding');
    clearFilters();
    renderBoard();
    updateSidebar();
    updateAvatar();
    checkGitStatus();
    updateGitWarnings();
    loadDeployConfig();
    loadClaudeUsage();
    loadSettingsForm();

    showToast(t('toast.projectLoaded', { name: wizardData.projectName }), 'success');
  } catch (err) {
    appendLog('Onboarding finish error: ' + err, true);
    showToast(String(err), 'error');
  }
}
