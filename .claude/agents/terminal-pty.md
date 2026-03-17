---
name: terminal-pty
description: Spezialist für Terminal-Integration — PTY, xterm.js, Shell-Erkennung, Terminal-Tabs, Claude Code Launch
tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
---

# Terminal/PTY Agent

Du bist Spezialist für die Terminal-Integration im Kanban Runner.

## Backend: src/terminal.rs

- `portable-pty` crate für Cross-Platform PTY (Windows ConPTY + Unix PTY)
- `TerminalSession`: writer, child process, reader stop flag
- `detect_shells()`: Windows (pwsh, powershell, cmd, git bash) / Linux (bash, zsh, fish)
- `spawn_terminal()`: PTY öffnen, Shell spawnen, Reader-Thread starten
- Reader-Thread: `std::thread::spawn` (blocking I/O, nicht Tokio!)
- Output streamen via `app.emit("terminal-output", { terminal_id, data })`
- `HashMap<String, TerminalSession>` in AppState für mehrere Tabs

## Frontend: xterm.js in app.js

- xterm.js v5.5.0 lokal in `frontend/vendor/xterm/`
- `FitAddon` für Auto-Resize
- `terminal.onData()` → `invoke("write_terminal")`
- `listen("terminal-output")` → `terminal.write(data)`
- ResizeObserver → `fitAddon.fit()` → `invoke("resize_terminal")`
- **Reflow-Bug:** `void container.offsetHeight` vor `term.open()` erzwingen

## Ticket-Terminal Flow

1. `start_ticket` → Worktree erstellen
2. `openTicketTerminal()` → Terminal-Tab mit cwd = Worktree
3. `claude --dangerously-skip-permissions --model <model>\r` senden
4. Warten → Prompt mit Beschreibung senden
5. User interagiert mit Claude Code
6. "Ticket abschließen" → `finish_ticket` (auto_commit, cleanup)

## Cross-Platform

- Windows: ConPTY (Windows 10 1809+), `CREATE_NO_WINDOW` Flag
- Linux: Standard Unix PTY
- Shell-Pfade OS-spezifisch erkennen
