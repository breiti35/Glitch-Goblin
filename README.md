# Aufgabenhelfer

Ein Tauri-basiertes Desktop-Kanban-Board für Entwicklungsprojekte.
Verwaltet Tickets, Git-Branches, Deployments und synchronisiert Bugs aus einem Portal Bug-Tracker — alles in einer nativen App für Windows und Linux.

## Features

- **Kanban Board** — Tickets mit Drag-and-Drop durch Spalten (Backlog, Progress, Review, Done)
- **Globaler Header** — App-weite Suche, Projekt-Avatar, Benachrichtigungs-Bell und "+ Create Project" Button
- **Project Health Bar** — Visualisiert den Fortschritt (Done / Review / Offen) direkt im Board-Header
- **Multi-Projekt** — Mehrere Projekte verwalten und zwischen ihnen wechseln
- **Git-Integration** — Branch-Erstellung pro Ticket, Diff-Ansicht, Branch-Management, Commit-Log
- **Terminal** — Integriertes PTY-Terminal mit konfigurierbarer Shell und Schriftgröße
- **Bug-Sync (Portal)** — Bugs aus einem Portal Bug-Tracker automatisch als Bugfix-Tickets ins Backlog importieren
- **Deploy** — Local Deploy (Docker) und Live Deploy (SSH) direkt aus der App
- **Templates** — Ticket-Vorlagen erstellen und wiederverwenden
- **Import/Export** — Tickets als JSON oder CSV exportieren und importieren
- **Agent & Command Editor** — Claude-Agenten und Custom Commands direkt in der App bearbeiten
- **Activity Log & Kommentare** — Aktivitätsverlauf pro Ticket, Kommentare mit Zeitstempel
- **Dashboard** — Projektinfo mit Ticket-Statistiken, Tech-Stack, README-Vorschau, Recent Commits
- **Backups** — Automatische Backups des Boards mit Restore-Funktion
- **Dark / Light Theme** — Teal-Akzent mit konfigurierbarer Akzentfarbe
- **Kostentracking** — Token-Verbrauch und Kosten pro Ticket (Claude-Modelle)

## Installation

### Voraussetzungen

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (für Tauri CLI)
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

1. **"+ New Task"** Button in der Sidebar oder `Ctrl+N`
2. Titel, Beschreibung, Typ (Feature, Bugfix, Security, Docs) und Priorität wählen
3. Ticket landet im **Backlog**

### Workflow

1. **Backlog** — Ticket erstellen
2. **▷ Start** — Ticket starten (erstellt Git-Branch, setzt Status auf Progress)
3. **✔ Ticket abschließen** — Ticket fertigstellen (wechselt zu Review)
4. **Merge** — Branch mergen (wechselt zu Done)

### Suche & Filter

- **Globale Suche** im Header filtert das Board in Echtzeit
- **Filter-Bar** (`Ctrl+F`) ermöglicht zusätzlich Filterung nach Typ und Priorität

### Bug-Sync (Portal Bug-Tracker)

Bugs aus einem Portal Bug-Tracker können automatisch ins Kanban Board importiert werden.

**Einrichtung:**

1. **Settings** öffnen (Sidebar → Settings)
2. Abschnitt **Bug-Sync (Portal)** konfigurieren:
   - **API URL** — Basis-URL des Portal Bug-Tracker API-Endpunkts
   - **API Token** — Bearer-Token für die Authentifizierung
   - **Sync-Intervall** — Automatisches Polling (Standard: 5 Minuten, Minimum: 60 Sekunden)
   - **Aktiviert** — Toggle zum Ein-/Ausschalten
3. Speichern

**Verwendung:**

- **Manueller Sync** — Button "Bugs synchen" im Board-Header
- **Automatischer Sync** — Timer pollt das Portal im konfigurierten Intervall
- **Bell-Badge** — Zeigt Anzahl neuer Bugs im globalen Header
- Synchronisierte Bugs erscheinen als **Bugfix-Tickets** im Backlog mit "Portal-Bug" Badge
- Im Ticket-Detail werden **Portal Bug ID** und **URL** angezeigt

**Portal API Endpunkte:**

| Endpunkt | Methode | Beschreibung |
|---|---|---|
| `/unsynced` | GET | Liefert ungesyncte Bugs |
| `/mark-synced` | POST | Markiert Bugs als gesynct (mit `kanban_ticket_id`) |

### Keyboard Shortcuts

| Shortcut | Aktion |
|---|---|
| `Ctrl+N` | Neues Ticket |
| `Ctrl+F` | Filter-Bar togglen |
| `Ctrl+P` | Project Picker öffnen |
| `Ctrl+,` | Settings öffnen |
| `Ctrl+L` | Log-Panel togglen |
| `Ctrl+\`` | Terminal togglen |
| `Escape` | Dialog / Panel schließen |
| `?` | Keyboard Shortcuts anzeigen |

## Architektur

```
kanban-runner/
  Cargo.toml           # Rust-Dependencies (tauri, reqwest, tokio, serde, ...)
  tauri.conf.json       # Tauri-Konfiguration
  src/
    main.rs             # Tauri-Setup, State-Init, Bug-Sync Auto-Timer
    commands.rs         # Alle Tauri-Commands (invoke handler)
    kanban.rs           # Board, Ticket, File-Watcher
    state.rs            # AppState, Settings, BugSyncSettings
    bugsync.rs          # Portal Bug-Tracker HTTP Client (reqwest)
    git.rs              # Git-Operationen
    terminal.rs         # PTY Terminal
    deploy.rs           # Local/Live Deploy
    config.rs           # Projekt-/Settings-Persistenz
    activity.rs         # Activity Log
    runner.rs           # Claude Runner Integration
  frontend/
    index.html          # Single-Page App
    app.js              # Frontend-Logik (Vanilla JS)
    style.css           # Styling (Dark/Light Theme, CSS Custom Properties)
    vendor/
      xterm/            # xterm.js für Terminal-Rendering
```

## Version

Aktuelle Version: **0.3.0**

Siehe [CHANGELOG.md](CHANGELOG.md) für die vollständige Versionshistorie.

## Lizenz

Proprietär — Nur zur internen Verwendung.
