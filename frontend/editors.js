// ── Editors Module ──
// Agent and command editors.

import { invoke } from '@tauri-apps/api/core';
import { esc } from './utils.js';
import { state, appendLog } from './app.js';
import { t } from './i18n.js';

// ── Agents (Stitch Card-Grid) ──

export async function loadAgents() {
  const container = document.getElementById("agents-list");
  try {
    const agents = await invoke("list_agents");
    const countEl = document.getElementById("agent-count");
    if (countEl) countEl.textContent = agents.length;

    if (agents.length === 0) {
      container.innerHTML = '<p class="empty-state">' + esc(t('editors.noAgents')) + '</p>';
      return;
    }

    // Read content preview for each agent
    const cards = await Promise.all(agents.map(async name => {
      let preview = '';
      try {
        const content = await invoke("read_agent", { name });
        preview = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---')).slice(0, 2).join(' ').substring(0, 120);
      } catch {}

      const displayName = name.replace(/\.md$/i, '');
      return `<div class="agent-card" data-agent="${esc(name)}">
        <div class="agent-card-header">
          <div class="agent-card-icon" style="background:var(--accent-glow);color:var(--accent)">
            <span class="material-symbols-outlined">smart_toy</span>
          </div>
        </div>
        <div class="agent-card-name">${esc(displayName)}</div>
        <div class="agent-card-desc">${esc(preview) || 'Agent configuration file'}</div>
        <div class="agent-card-footer">
          <span class="agent-card-manage">Manage</span>
        </div>
      </div>`;
    }));

    container.innerHTML = cards.join('');

    container.querySelectorAll('.agent-card').forEach(card => {
      card.addEventListener('click', () => openAgentEditor(card.dataset.agent));
    });
  } catch (err) {
    container.innerHTML = `<p class="empty-state">${esc(String(err))}</p>`;
  }
}

export async function openAgentEditor(name) {
  try {
    const content = await invoke("read_agent", { name });
    state.editingAgent = name;
    document.getElementById("agent-editor-name").textContent = name + ".md";
    document.getElementById("agent-editor-content").value = content;
    document.getElementById("agent-editor-overlay").classList.remove("hidden");
  } catch (err) {
    appendLog("Error reading agent: " + err, true);
  }
}

function closeAgentEditor() {
  document.getElementById("agent-editor-overlay").classList.add("hidden");
  state.editingAgent = null;
}

export async function saveAgentEditor() {
  if (!state.editingAgent) return;
  const content = document.getElementById("agent-editor-content").value;
  try {
    await invoke("save_agent", { name: state.editingAgent, content });
    appendLog("Agent saved: " + state.editingAgent);
  } catch (err) {
    appendLog("Save agent error: " + err, true);
  }
}

export async function deleteAgentEditor() {
  if (!state.editingAgent) return;
  if (!confirm(`Delete agent "${state.editingAgent}"?`)) return;
  try {
    await invoke("delete_agent", { name: state.editingAgent });
    state.editingAgent = null;
    closeAgentEditor();
    loadAgents();
    appendLog("Agent deleted");
  } catch (err) {
    appendLog("Delete agent error: " + err, true);
  }
}

export async function newAgentFlow() {
  const name = prompt("Agent name:");
  if (!name || !name.trim()) return;
  try {
    await invoke("create_agent", { name: name.trim() });
    await loadAgents();
    openAgentEditor(name.trim());
  } catch (err) {
    appendLog("Create agent error: " + err, true);
  }
}

// Close button listener (called from app.js init or inline)
export function setupAgentEditorClose() {
  document.getElementById("btn-close-agent-editor")?.addEventListener("click", closeAgentEditor);
}

// ── Commands (Stitch Card-Grid) ──

export async function loadCommands() {
  const container = document.getElementById("commands-list");
  try {
    const cmds = await invoke("list_commands_available");
    const countEl = document.getElementById("command-count");
    if (countEl) countEl.textContent = cmds.length;

    if (cmds.length === 0) {
      container.innerHTML = '<p class="empty-state">' + esc(t('editors.noCommands')) + '</p>';
      return;
    }

    const cards = await Promise.all(cmds.map(async name => {
      let preview = '';
      try {
        const content = await invoke("read_command", { name });
        preview = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---')).slice(0, 2).join(' ').substring(0, 120);
      } catch {}

      const displayName = name.replace(/\.md$/i, '');
      return `<div class="agent-card" data-command="${esc(name)}">
        <div class="agent-card-header">
          <div class="agent-card-icon" style="background:rgba(20,105,109,0.12);color:var(--tertiary)">
            <span class="material-symbols-outlined">code</span>
          </div>
        </div>
        <div class="agent-card-name">${esc(displayName)}</div>
        <div class="agent-card-desc">${esc(preview) || 'Command configuration file'}</div>
        <div class="agent-card-footer">
          <span class="agent-card-manage">Manage</span>
        </div>
      </div>`;
    }));

    container.innerHTML = cards.join('');

    container.querySelectorAll('.agent-card').forEach(card => {
      card.addEventListener('click', () => openCommandEditor(card.dataset.command));
    });
  } catch (err) {
    container.innerHTML = `<p class="empty-state">${esc(String(err))}</p>`;
  }
}

export async function openCommandEditor(name) {
  try {
    const content = await invoke("read_command", { name });
    state.editingCommand = name;
    document.getElementById("command-editor-name").textContent = name + ".md";
    document.getElementById("command-editor-content").value = content;
    document.getElementById("command-editor-overlay").classList.remove("hidden");
  } catch (err) {
    appendLog("Error reading command: " + err, true);
  }
}

function closeCommandEditor() {
  document.getElementById("command-editor-overlay").classList.add("hidden");
  state.editingCommand = null;
}

export async function saveCommandEditor() {
  if (!state.editingCommand) return;
  const content = document.getElementById("command-editor-content").value;
  try {
    await invoke("save_command", { name: state.editingCommand, content });
    appendLog("Command saved: " + state.editingCommand);
  } catch (err) {
    appendLog("Save command error: " + err, true);
  }
}

export async function deleteCommandEditor() {
  if (!state.editingCommand) return;
  if (!confirm(`Delete command "${state.editingCommand}"?`)) return;
  try {
    await invoke("delete_command", { name: state.editingCommand });
    state.editingCommand = null;
    closeCommandEditor();
    loadCommands();
    appendLog("Command deleted");
  } catch (err) {
    appendLog("Delete command error: " + err, true);
  }
}

export async function newCommandFlow() {
  const name = prompt("Command name:");
  if (!name || !name.trim()) return;
  try {
    await invoke("create_command", { name: name.trim() });
    await loadCommands();
    openCommandEditor(name.trim());
  } catch (err) {
    appendLog("Create command error: " + err, true);
  }
}

export function setupCommandEditorClose() {
  document.getElementById("btn-close-command-editor")?.addEventListener("click", closeCommandEditor);
}
