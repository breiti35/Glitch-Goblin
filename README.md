# Aufgabenhelfer

Ein Tauri-basiertes Desktop-Kanban-Board für Entwicklungsprojekte.
Verwaltet Tickets, Git-Branches, Deployments und synchronisiert Bugs aus einem Portal Bug-Tracker — alles in einer nativen App für Windows und Linux.

## Features

### Board & Workflow
- **Kanban Board** — Tickets mit Drag-and-Drop durch Spalten (Backlog, Progress, Review, Done)
- **Kompakte Karten** — Titel + Prio immer sichtbar, Details bei Hover (Beschreibung, Datum, Aktionen)
- **WIP-Limits** — Progress (max 3) und Review (max 5) mit visueller Warnung bei Überschreitung
- **Schnellaktionen** — Priorität und Typ direkt auf der Karte ändern per Dropdown
- **Review-Ansicht** — Vor dem Commit: Diff aller Änderungen prüfen. In der Review-Spalte: "Änderungen anzeigen" zeigt Branch-Diff
- **Fokus-Modus** — Vollbild-Arbeitsplatz bei laufendem Ticket: großer Terminal + Ticket-Sidebar mit Timer und Schnell-Notizen
- **Tastatur-Navigation** — Pfeiltasten zum Navigieren zwischen Karten und Spalten, Enter öffnet Detail

### Dashboard
- **Action-Cards** — "Weitermachen" (letztes Ticket), "Nächste Aufgabe" (High-Prio), "Review-Erinnerung"
- **Projektinfo** — Tech Stack, Quick Stats, README-Vorschau
- **Recent Commits & Activity** — Letzte Commits und Aktivitäten auf einen Blick

### Git-Integration
- **Card-basierte Branch-Ansicht** — Branches gruppiert nach "In Arbeit", "Weitere", "Erledigte"
- **Letzte Commits** direkt auf der aktuellen Branch-Card sichtbar
- **Lazy-Loading Details** — Commits und Diffs erst beim Aufklappen laden
- **Branch-Management** — Übernehmen (Merge), Löschen, Diff-Vorschau

### Terminal
- **Integriertes PTY-Terminal** mit konfigurierbarer Shell und Schriftgröße
- **Ticket-Terminal** — Claude Code wird automatisch mit Ticket-Prompt gestartet
- **Fortschritts-Anzeige** — Pulsierende Status-Bar mit Ticket-ID und Elapsed-Timer
- **Multi-Tab** — Mehrere Terminal-Sessions parallel

### Claude-Integration
- **Usage-Anzeige** — 5h- und 7d-Kontingent als farbcodierte Balken im Sidebar (via Anthropic OAuth API)
- **Modell-Empfehlung** — Opus für Security/Feature, Sonnet für Bugfix/Docs (automatische Vorauswahl)
- **Kostentracking** — Token-Verbrauch und Kosten pro Ticket

### Weitere Features
- **Multi-Projekt** — Mehrere Projekte verwalten, automatischer View-Refresh beim Wechsel
- **Globale Suche** — Tickets und Settings durchsuchen mit Dropdown-Ergebnissen
- **Toast-Benachrichtigungen** — Slide-in-Meldungen bei Aktionen (Erfolg/Fehler/Info)
- **Notification-Center** — Glocken-Button sammelt alle Benachrichtigungen mit Zeitstempel
- **Bug-Sync (Portal)** — Bugs aus Portal Bug-Tracker automatisch als Tickets importieren
- **Deploy** — Local Deploy (Docker Compose) und Live Deploy (SSH) aus der App
- **Statistiken** — Pie/Bar-Charts, Velocity-Chart (Tickets/Woche), Cycle-Time, Kosten
- **Agent & Command Editor** — Claude-Agenten und Custom Commands bearbeiten
- **Templates** — Ticket-Vorlagen erstellen und wiederverwenden
- **Import/Export** — Tickets als JSON oder CSV
- **Backups** — Automatische Board-Backups mit Restore-Funktion
- **Dark / Light Theme** — Solarized Light + Teal-Akzent, konfigurierbare Akzentfarbe

## Installation

### Voraussetzungen

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (für Tauri CLI und Frontend-Build)
- Tauri CLI: `cargo install tauri-cli`

### Development Build

```bash
cd kanban-runner
cargo tauri dev
```

### Release Build

```bash
cargo tauri build
```

Das fertige Binary liegt unter `target/release/kanban-runner` (Linux) bzw. `target/release/kanban-runner.exe` (Windows).

## Usage

### Projekt hinzufügen

1. **"+ Create Project"** im Header oder **"+ Add Project"** im Project-Picker klicken
2. Projektordner auswählen (muss ein Git-Repository sein)
3. Projekt wird automatisch geladen

### Ticket erstellen

1. **"+ New Task"** Button in der Sidebar, **[+]** im Backlog-Header oder `Ctrl+N`
2. Titel, Beschreibung, Typ (Feature, Bugfix, Security, Docs) und Priorität wählen
3. Ticket landet im **Backlog**

### Workflow

1. **Backlog** — Ticket erstellen
2. **Start** — Ticket starten (erstellt Git-Branch, öffnet Fokus-Modus mit Terminal)
3. **Ticket abschließen** — Review-Modal zeigt Diff, nach Bestätigung wird committed
4. **Änderungen anzeigen** — In Review-Spalte: Diff aller Änderungen prüfen
5. **Übernehmen** — Branch in Hauptbranch übernehmen (Ticket → Done)

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
| `Enter` | Ticket-Detail öffnen |
| `Escape` | Dialog / Panel schließen |
| `?` | Keyboard Shortcuts |

## Architektur

```
kanban-runner/
  Cargo.toml              # Rust-Dependencies
  tauri.conf.json          # Tauri-Konfiguration
  src/
    main.rs                # Tauri-Setup, State-Init, Bug-Sync Timer
    commands.rs            # Alle Tauri-Commands (~50 IPC Handler)
    kanban.rs              # Board, Ticket, File-Watcher
    state.rs               # AppState, Settings
    git.rs                 # Git-Operationen (Branch, Diff, Commit)
    terminal.rs            # PTY Terminal Sessions
    db.rs                  # SQLite-Persistenz
    config.rs              # Projekt-/Settings-Persistenz
    deploy.rs              # Docker/SSH Deploy
    bugsync.rs             # Portal Bug-Tracker Sync
    activity.rs            # Activity Log
    crypto.rs              # Token-Verschlüsselung (ChaCha20)
    error.rs               # Strukturierte Error-Typen
  frontend/
    index.html             # Single-Page App (HTML)
    app.js                 # Orchestrator (State, Init, Routing)
    board.js               # Board-Rendering, Drag & Drop, Filter
    detail.js              # Ticket-Detail, Timeline, Kommentare
    git.js                 # Git-View (Branch-Cards, Diffs)
    terminal.js            # Terminal-Sessions, Tabs
    settings.js            # Settings-Form, Tabs, Backups
    statistics.js          # Charts, Metriken
    dashboard.js           # Dashboard, Templates, Import/Export
    activity.js            # Activity-Timeline
    editors.js             # Agent/Command-Editoren
    deploy.js              # Deploy-Operationen
    bugsync.js             # Bug-Sync UI
    utils.js               # Utilities (esc, timeAgo, debounce, ...)
    error-handler.js       # Globaler Error-Handler
    style.css              # Styling (Dark/Light Theme, CSS Variables)
    vite.config.js         # Vite Build-Konfiguration
    vendor/xterm/          # xterm.js für Terminal-Rendering
```

## Version

Aktuelle Version: **0.0.2**

Siehe [CHANGELOG.md](CHANGELOG.md) für die vollständige Versionshistorie.

## Lizenz

Proprietär — Nur zur internen Verwendung.
