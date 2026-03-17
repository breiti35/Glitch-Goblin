# Kanban Runner

Ein Tauri-basiertes Desktop-Kanban-Board fuer Entwicklungsprojekte.
Verwaltet Tickets, Branches, Deployments und synchronisiert Bugs aus einem Portal Bug-Tracker -- alles in einer nativen App fuer Windows und Linux.

## Features

- **Kanban Board** -- Tickets mit Drag-and-Drop durch Spalten bewegen (Backlog, In Progress, Review, Done)
- **Multi-Projekt** -- Mehrere Projekte verwalten und zwischen ihnen wechseln
- **Git-Integration** -- Branch-Erstellung pro Ticket, Diff-Ansicht, Branch-Management, Commit-Log
- **Terminal** -- Integriertes PTY-Terminal mit konfigurierbarer Shell und Schriftgroesse
- **Bug-Sync (Portal)** -- Bugs aus einem Portal Bug-Tracker (alpha_bugs) automatisch als Bugfix-Tickets ins Backlog importieren
- **Deploy** -- Local Deploy (Docker) und Live Deploy (SSH) direkt aus der App
- **Templates** -- Ticket-Vorlagen erstellen und wiederverwenden
- **Import/Export** -- Tickets als JSON oder CSV exportieren und importieren
- **Agent & Command Editor** -- Claude-Agenten und Custom Commands direkt in der App bearbeiten
- **Activity Log & Kommentare** -- Aktivitaetsverlauf pro Ticket, Kommentare mit Zeitstempel
- **Dashboard** -- Projektinfo mit Ticket-Statistiken
- **Backups** -- Automatische Backups des Boards mit Restore-Funktion
- **Themes** -- Dark/Light Theme mit konfigurierbarer Akzentfarbe
- **Kostentracking** -- Token-Verbrauch und Kosten pro Ticket (Claude-Modelle)

## Installation

### Voraussetzungen

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (fuer Tauri CLI)
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

### Projekt hinzufuegen

1. Auf das **+** neben der Projektliste klicken
2. Projektordner auswaehlen (muss ein Git-Repository sein)
3. Projekt wird automatisch geladen

### Ticket erstellen

1. **Neues Ticket** Button im Board-Header
2. Titel, Beschreibung und Typ (Feature, Bugfix, Refactor, Docs) waehlen
3. Ticket landet im **Backlog**

### Workflow

1. **Backlog** -- Ticket erstellen
2. **Start** -- Ticket starten (erstellt Git-Branch, wechselt Status zu In Progress)
3. **Finish** -- Ticket abschliessen (wechselt zu Review)
4. **Merge** -- Branch mergen (wechselt zu Done)

### Bug-Sync (Portal Bug-Tracker)

Bugs aus einem Portal Bug-Tracker koennen automatisch ins Kanban Board importiert werden.

**Einrichtung:**

1. **Settings** oeffnen (Zahnrad-Icon)
2. Abschnitt **Bug-Sync (Portal)** konfigurieren:
   - **API URL** -- Basis-URL des Portal Bug-Tracker API-Endpunkts
   - **API Token** -- Bearer-Token fuer die Authentifizierung
   - **Sync-Intervall** -- Automatisches Polling (Standard: 5 Minuten, Minimum: 60 Sekunden)
   - **Aktiviert** -- Toggle zum Ein-/Ausschalten
3. Speichern

**Verwendung:**

- **Manueller Sync** -- Button "Bugs synchen" im Board-Header oder Sidebar
- **Automatischer Sync** -- Timer pollt das Portal im konfigurierten Intervall
- **Badge** -- Sidebar zeigt Anzahl verfuegbarer Bugs
- Synchronisierte Bugs erscheinen als **Bugfix-Tickets** im Backlog mit "Portal-Bug" Badge
- Im Ticket-Detail werden **Portal Bug ID** und **URL** angezeigt

**Portal API Endpunkte:**

| Endpunkt | Methode | Beschreibung |
|---|---|---|
| `/unsynced` | GET | Liefert ungesyncte Bugs |
| `/mark-synced` | POST | Markiert Bugs als gesynct (mit kanban_ticket_id) |

### Keyboard Shortcuts

| Shortcut | Aktion |
|---|---|
| `Ctrl+N` | Neues Ticket |
| `Ctrl+S` | Settings oeffnen |
| `Ctrl+T` | Terminal toggle |
| `Escape` | Dialog/Panel schliessen |

## Architektur

```
kanban-runner/
  Cargo.toml          # Rust-Dependencies (tauri, reqwest, tokio, serde, ...)
  tauri.conf.json      # Tauri-Konfiguration
  src/
    main.rs            # Tauri-Setup, State-Init, Bug-Sync Auto-Timer
    commands.rs        # Alle Tauri-Commands (invoke handler)
    kanban.rs          # Board, Ticket, File-Watcher
    state.rs           # AppState, Settings, BugSyncSettings
    bugsync.rs         # Portal Bug-Tracker HTTP Client (reqwest)
    git.rs             # Git-Operationen
    terminal.rs        # PTY Terminal
    deploy.rs          # Local/Live Deploy
    config.rs          # Projekt-/Settings-Persistenz
    activity.rs        # Activity Log
    runner.rs          # Claude Runner Integration
  frontend/
    index.html         # Single-Page App
    app.js             # Frontend-Logik (Vanilla JS)
    style.css          # Styling
```

## Version

Aktuelle Version: **0.2.0**

Siehe [CHANGELOG.md](CHANGELOG.md) fuer die vollstaendige Versionshistorie.

## Lizenz

Proprietaer -- Nur zur internen Verwendung.
