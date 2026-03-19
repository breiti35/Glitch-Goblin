// ── Editors Module ──
// Agent and command editors.

import { invoke } from '@tauri-apps/api/core';
import { esc } from './utils.js';
import { state, appendLog } from './app.js';

// ── Agents ──

export async function loadAgents() {
  try {
    const agents = await invoke("list_agents");
    const list = document.getElementById("agents-list");
    if (agents.length === 0) {
      list.innerHTML = '<p class="empty-state">No agents found in .claude/agents/</p>';
    } else {
      list.innerHTML = agents.map(a => `
        <div class="editor-list-item ${state.editingAgent === a ? "active" : ""}" data-agent="${esc(a)}">
          ${esc(a)}
        </div>
      `).join("");
      list.querySelectorAll(".editor-list-item").forEach(item => {
        item.addEventListener("click", () => openAgentEditor(item.dataset.agent));
      });
    }
    document.getElementById("agent-count").textContent = agents.length;
  } catch (err) {
    document.getElementById("agents-list").innerHTML = `<p class="empty-state">${esc(String(err))}</p>`;
  }
}

export async function openAgentEditor(name) {
  try {
    const content = await invoke("read_agent", { name });
    state.editingAgent = name;
    document.getElementById("agent-editor-name").textContent = name + ".md";
    document.getElementById("agent-editor-content").value = content;
    document.getElementById("agent-editor").classList.remove("hidden");
    document.querySelectorAll("#agents-list .editor-list-item").forEach(i => {
      i.classList.toggle("active", i.dataset.agent === name);
    });
  } catch (err) {
    appendLog("Error reading agent: " + err, true);
  }
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
    document.getElementById("agent-editor").classList.add("hidden");
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

// ── Commands ──

export async function loadCommands() {
  try {
    const cmds = await invoke("list_commands_available");
    const list = document.getElementById("commands-list");
    if (cmds.length === 0) {
      list.innerHTML = '<p class="empty-state">No commands found in .claude/commands/</p>';
    } else {
      list.innerHTML = cmds.map(c => `
        <div class="editor-list-item ${state.editingCommand === c ? "active" : ""}" data-command="${esc(c)}">
          ${esc(c)}
        </div>
      `).join("");
      list.querySelectorAll(".editor-list-item").forEach(item => {
        item.addEventListener("click", () => openCommandEditor(item.dataset.command));
      });
    }
    document.getElementById("command-count").textContent = cmds.length;
  } catch (err) {
    document.getElementById("commands-list").innerHTML = `<p class="empty-state">${esc(String(err))}</p>`;
  }
}

export async function openCommandEditor(name) {
  try {
    const content = await invoke("read_command", { name });
    state.editingCommand = name;
    document.getElementById("command-editor-name").textContent = name + ".md";
    document.getElementById("command-editor-content").value = content;
    document.getElementById("command-editor").classList.remove("hidden");
    document.querySelectorAll("#commands-list .editor-list-item").forEach(i => {
      i.classList.toggle("active", i.dataset.command === name);
    });
  } catch (err) {
    appendLog("Error reading command: " + err, true);
  }
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
    document.getElementById("command-editor").classList.add("hidden");
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
