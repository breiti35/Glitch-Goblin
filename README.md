<p align="center">
  <img src="docs/screenshot-dark.png" alt="Glitch Goblin — Dark Theme" width="800">
</p>

<h1 align="center">Glitch Goblin</h1>

<p align="center">
  Desktop-Kanban-Board fuer Entwicklungsprojekte mit integriertem Terminal, Git-Workflow und Claude Code Integration.
  <br>
  <strong>Windows &bull; Linux</strong>
</p>

<p align="center">
  <a href="https://github.com/breiti35/Glitch-Goblin/actions"><img src="https://github.com/breiti35/Glitch-Goblin/actions/workflows/build.yml/badge.svg" alt="Build"></a>
  <a href="https://github.com/breiti35/Glitch-Goblin/releases/latest"><img src="https://img.shields.io/github/v/release/breiti35/Glitch-Goblin?label=Version" alt="Version"></a>
  <img src="https://img.shields.io/badge/Tauri-v2-blue" alt="Tauri v2">
  <img src="https://img.shields.io/badge/Rust-stable-orange" alt="Rust">
</p>

---

## Features

**Board & Workflow**
- Kanban Board mit Drag-and-Drop (Backlog, Progress, Review, Done)
- Fokus-Modus mit Vollbild-Terminal, Timer und Schnell-Notizen
- WIP-Limits, Schnellaktionen, Review-Diff, Ticket-Archivierung
- Tastatur-Navigation (Pfeiltasten, Shortcuts)

**Git-Integration**
- Automatische Branch-Erstellung beim Ticket-Start
- Branch-Ansicht mit Commits, Diffs, Merge und Branch-Management
- Review-Ansicht mit Diff aller Aenderungen vor dem Commit

**Terminal**
- Integriertes PTY-Terminal mit Multi-Tab und konfigurierbarer Shell
- Claude Code wird automatisch mit Ticket-Prompt gestartet
- Fortschritts-Anzeige mit Ticket-ID und Timer

**Claude Code Integration**
- Modell-Empfehlung pro Ticket-Typ (Opus, Sonnet, Haiku + 1M-Context)
- 5h/7d-Kontingent-Anzeige im Header und Fokus-Modus
- Token-Verbrauch und Kosten-Tracking pro Ticket

**Weitere Features**
- Multi-Projekt mit konfigurierbarem Ticket-Prefix
- Dashboard mit Action-Cards, Statistiken, Pie/Bar/Velocity-Charts
- Deploy (Docker Compose lokal, SSH live)
- Bug-Sync aus Portal Bug-Tracker
- Import/Export (JSON, CSV), Templates, Backups
- Dark / Light Theme mit konfigurierbarer Akzentfarbe
- Globale Suche, Notification-Center, Activity-Timeline

<details>
<summary><strong>Light Theme</strong></summary>
<p align="center">
  <img src="docs/screenshot-light.png" alt="Glitch Goblin — Light Theme" width="800">
</p>
</details>

---

## Installation

### Voraussetzungen

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (fuer Tauri CLI und Frontend-Build)
- Tauri CLI: `cargo install tauri-cli`

### Development

```bash
cd glitch-goblin
cargo tauri dev
```

### Release Build

```bash
cargo tauri build
```

### Download

Fertige Builds (Windows .exe + Installer, Linux Binary + AppImage) gibt es unter [Releases](https://github.com/breiti35/Glitch-Goblin/releases/latest).

---

## Usage

### Projekt hinzufuegen

1. **"+ Create Project"** im Header oder **"+ Add Project"** im Project-Picker
2. Projektordner auswaehlen (muss ein Git-Repository sein)
3. Projekt wird automatisch geladen

### Workflow

1. **Ticket erstellen** — `Ctrl+N` oder [+] im Backlog-Header
2. **Starten** — Erstellt Git-Branch, oeffnet Fokus-Modus mit Terminal
3. **Abschliessen** — Review-Modal zeigt Diff, Commit nach Bestaetigung
4. **Uebernehmen** — Branch in Hauptbranch mergen (Ticket -> Done)
5. **Archivieren** — Erledigte Tickets ins Archiv verschieben

### Keyboard Shortcuts

| Shortcut | Aktion |
|---|---|
| `Ctrl+N` | Neues Ticket |
| `Ctrl+F` | Filter-Bar togglen |
| `Ctrl+P` | Project Picker |
| `Ctrl+,` | Settings |
| `Ctrl+L` | Log-Panel togglen |
| `` Ctrl+` `` | Terminal togglen |
| `Pfeiltasten` | Board-Navigation |
| `Enter` | Ticket-Detail oeffnen |
| `Escape` | Dialog / Panel schliessen |
| `?` | Keyboard Shortcuts |

---

## Architektur

```
glitch-goblin/
  src/
    main.rs          Tauri-Setup, State-Init, Bug-Sync Timer
    commands.rs      Alle Tauri-Commands (~70 IPC Handler)
    state.rs         AppState, Settings
    kanban.rs        Board, Ticket, Backup
    db.rs            SQLite-Persistenz (einzige Datenquelle)
    git.rs           Git-Operationen (Branch, Diff, Commit, Merge)
    terminal.rs      PTY Terminal Sessions (portable-pty)
    config.rs        Projekt-/Settings-Konfiguration
    deploy.rs        Docker/SSH Deploy
    bugsync.rs       Portal Bug-Tracker Sync
    activity.rs      Activity Log
    crypto.rs        Token-Verschluesselung (ChaCha20)
    error.rs         Strukturierte Error-Typen
  frontend/
    index.html       Single-Page App
    app.js           Orchestrator (State, Init, Routing)
    board.js         Board-Rendering, Drag & Drop
    terminal.js      Terminal-Sessions, Tabs
    git.js           Git-View (Branch-Cards, Diffs)
    settings.js      Settings, Backups
    ...              + 10 weitere Module
    style.css        Dark/Light Theme (CSS Variables)
```

---

## Version

Aktuelle Version: **0.2.6** — Siehe [CHANGELOG.md](CHANGELOG.md)

## Lizenz

Proprietaer — Nur zur internen Verwendung.
