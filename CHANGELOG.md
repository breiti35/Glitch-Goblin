# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

## v0.1.0 — Glitch Goblin (2026-03-20)

### Rename
- App umbenannt von "Aufgabenhelfer" zu "Glitch Goblin"
- Ticket-ID-Prefix geändert von KANBAN- zu GG-
- Config-Verzeichnis migriert von kanban-runner/ zu glitch-goblin/
- Branch-Prefix geändert von kanban/ zu gg/

## [0.0.2] - 2026-03-19

### Added
- **Code-Modularisierung:** `app.js` (3021 Zeilen) in 13 ES-Module aufgeteilt (board, detail, git, terminal, settings, statistics, dashboard, activity, editors, deploy, bugsync, utils, error-handler)
- **Git-View Redesign:** Card-basierte Branch-Ansicht mit Gruppierung (In Arbeit / Weitere / Erledigte), Lazy-Loading Details, letzte Commits direkt auf der master-Card sichtbar
- **BranchInfo erweitert:** `is_merged`, `files_changed`, `ahead_count`, `ticket_id` Felder im Backend
- **Review-Modal:** "Abschließen" zeigt Diff aller Änderungen vor dem Commit. "Änderungen anzeigen" Button in der Review-Spalte zeigt Branch-Diff
- **Fokus-Modus:** Vollbild-Arbeitsplatz bei laufendem Ticket — großer Terminal + Ticket-Sidebar (Titel, Branch, Modell, Timer, Schnell-Notizen). Automatisches Exit wenn Ticket fertig
- **Dashboard-Actions:** "Weitermachen" (Running/letztes Ticket), "Nächste Aufgabe" (High-Prio), "Review-Erinnerung" als Action-Cards
- **Dashboard-Redesign:** Kompaktes 2-Spalten-Layout, Tech Stack + Stats kombiniert, README begrenzt
- **Usage-Anzeige:** Claude 5h/7d-Kontingent als farbcodierte Balken im Sidebar (Anthropic OAuth API, 60s Cache, Auto-Refresh)
- **Modell-Empfehlung:** Automatische Vorauswahl im Execute-Dialog (Opus für Security/Feature, Sonnet für Bugfix/Docs)
- **Toast-System:** Slide-in-Benachrichtigungen (success/error/info) mit Auto-Dismiss
- **Notification-Center:** Glocken-Dropdown sammelt alle Benachrichtigungen mit Zeitstempel
- **Loading-Skeletons:** Animierte Platzhalter für Git-View und Activity statt "Loading..." Text
- **Modal-Animationen:** Fade-in + Scale-in für Modals, View-Fade bei Navigation, smootheres Slide-Panel
- **Kompakte Karten:** Titel + Prio immer sichtbar, Details (Beschreibung, Datum, Aktionen) gleiten bei Hover ein
- **WIP-Limits:** Progress (max 3), Review (max 5) mit visueller Warnung und Fortschrittsbalken
- **Empty States:** Spalten-spezifische Hinweistexte wenn keine Tickets vorhanden
- **Spalten-Statistiken:** Durchschnittliches Alter (Progress), ältestes Ticket (Review), Abschlussrate (Done)
- **Verbessertes Drag & Drop:** Ghost-Preview, Drop-Indikator-Linie
- **Ticket-Schnellaktionen:** Priorität und Typ direkt auf der Karte per Dropdown ändern
- **Globale Suche:** Header-Suche durchsucht Tickets (ID, Titel, Beschreibung) und Settings-Keywords
- **Velocity-Chart:** Wöchentliche Ticket-Abschlussrate als Balkendiagramm (letzte 8 Wochen)
- **Tastatur-Navigation:** Pfeiltasten für Board-Navigation, Enter öffnet Detail-Panel
- **Responsive Board:** 2 Spalten unter 1024px, 1 Spalte unter 600px
- **Settings-Tabs:** Allgemein | Terminal | Deploy | Bug-Sync statt endlosem Scroll
- **Plus-Button:** [+] im Backlog-Header zum schnellen Erstellen neuer Tickets
- **Terminal-Fortschritt:** Pulsierende Status-Bar mit Ticket-ID und Elapsed-Timer
- **Schnell-Notizen:** Textfeld im Fokus-Modus, speichert als Kommentar am Ticket
- **`withGuard` Utility:** Verhindert Doppelklick bei async Aktionen (executeTicket, mergeTicket)
- **`get_working_diff` / `get_working_file_diff` Commands:** Working-Tree Diffs für Review-Modal
- **`get_claude_usage` Command:** OAuth API Abfrage mit 60s Caching

### Changed
- **Farbsystem:** Hartkodierte Badge- und Diff-Farben in CSS-Variablen umgewandelt (vollständige Dark/Light-Theme-Konsistenz)
- **Deutsche Bezeichnungen:** "Merge" → "Übernehmen", "Merged Branches" → "Erledigte Branches (bereits in master eingebaut)", "clean" → "alles committed"
- **Projektwechsel:** Aktualisiert jetzt automatisch die aktive View (Dashboard, Git, Activity, etc.)
- **Drag & Drop:** Auf Event-Delegation umgestellt (Listener einmal registriert statt pro renderBoard)
- **renderBoard():** Debounced via requestAnimationFrame gegen DOM-Thrashing
- **Formularelemente:** Globaler CSS-Reset für input/select/textarea mit Theme-Variablen (Fix für weiße Dropdowns im Dark Mode)

### Fixed
- **Running-Ticket hängt:** Backend-State wird bei Fehler synchronisiert, Terminal-Fehler fängt ab ohne Lock-State zu verlieren
- **Finish ignoriert Commit-Fehler:** `auto_commit()` Fehlschlag wird jetzt propagiert — Ticket bleibt in Progress
- **Event-Listener Leak:** setupDragDrop() registrierte bei jedem renderBoard() neue Listener
- **Terminal-Interval:** checkInterval und fallbackTimeout werden bei cleanupTerminal() gestoppt
- **Projekt-Pfad:** switch_project() prüft ob Pfad noch existiert
- **Git-Verfügbarkeit:** start_ticket() prüft ob git installiert ist
- **DB-Fehler:** `.ok()` auf DB-Queries ersetzt durch Error-Logging
- **Duplicate ID:** `branch-count` existierte zweimal (Sidebar + View-Header)

## [Unreleased]

### Added
- **SQLite-Persistenz (`src/db.rs`):** Alle Projektdaten (Board, Aktivitätslog, Deploy-Konfiguration, Templates) werden in einer SQLite-Datenbank gespeichert statt in fragilen JSON-Dateien
  - Datei: `~/.config/kanban-runner/projects/<name>/kanban.db`
  - WAL-Modus für bessere Nebenläufigkeit und schnellere Writes
  - Vollständige atomare Transaktionen – kein Datenverlust mehr bei Absturz mid-Write
  - Einmalige automatische Migration: bestehende JSON-Dateien werden importiert und zu `*.migrated` umbenannt
  - `rusqlite 0.32` mit `bundled`-Feature (statisches SQLite, kein System-Package nötig)
- **Strukturierte Error-Typen (`src/error.rs`):** `AppError`-Enum mit 22 Varianten und deutschsprachigen Fehlermeldungen
  - Alle Commands bleiben `Result<T, String>` (kein Breaking Change)
  - `From<AppError> for String` erlaubt `?`-Operator ohne Typ-Konvertierung
  - Fehler enthalten jetzt Kontext (Dateiname, Ticket-ID, Branch-Name)
- **API-Token-Verschlüsselung (`src/crypto.rs`):** Bug-Sync API-Token wird verschlüsselt gespeichert
  - ChaCha20-Poly1305 Algorithmus
  - Schlüssel aus `/etc/machine-id` + Salt via SHA-256 abgeleitet (maschinengebunden)
  - Format: `v1:<nonce_hex>: <cipher_hex>` — rückwärtskompatibel zu Plaintext-Tokens
  - Bestehende Plaintext-Tokens werden beim nächsten Save automatisch migriert
- **Terminal-Cleanup beim App-Exit (`src/state.rs`, `src/main.rs`):**
  - `AppState::cleanup_terminals()` sendet `Close`-Signal an alle laufenden PTY-Sessions
  - `Drop`-Implementierung auf `AppState` als sicherer Fallback
  - `on_window_event(Destroyed)` am Hauptfenster als primärer Cleanup-Pfad
  - Verhindert Zombie-Shell-Prozesse nach App-Exit

### Changed
- **[MITTEL]** [UI] Git-Historie: Commit-Darstellung verbessert — Merge-Commits werden mit Badge gekennzeichnet, Author-Info wird angezeigt, deutsche relative Zeitangaben ("vor 2 Std.", "vor 3 Tagen") statt englischer Defaults (`app.js`, KANBAN-015)

### Fixed
- **[MITTEL]** [UI] Git-Historie zeigte "NaNd ago" statt lesbarer Zeitangaben — Ursache: `git log --format=%ci` lieferte Datumsformat, das von JavaScript `new Date()` nicht zuverlässig geparst wurde. Fix: Umstellung auf ISO 8601 strict (`%cI`), das von allen JS-Engines korrekt geparst wird (`app.js`, KANBAN-015)
- **[MITTEL]** [UI] Merge-Commits zeigten "No changes" in der Datei-Ansicht — `git show` ohne Merge-spezifische Flags liefert bei Merge-Commits keinen Diff. Fix: `-m --first-parent` Flags hinzugefügt, sodass der Diff gegen den ersten Parent angezeigt wird (`app.js`, KANBAN-015)
- **[MITTEL]** [UI] Terminal wechselte in Schwarz-Weiß wenn Claude Code startete — KANBAN-014 hatte `getTerminalTheme()` entfernt, um ANSI-Farbüberschreibung zu verhindern, dadurch fehlte xterm.js aber jegliche Theme-Konfiguration. Fix: Neue Funktion `getTerminalTheme()` setzt nur `background`, `foreground` und `cursor` aus CSS-Variablen (`--terminal-bg`, `--terminal-fg`, `--terminal-cursor`), ohne die ANSI-Farbpalette zu definieren — xterm.js behält seine eingebauten ANSI-Farben. Neue Funktion `applyTerminalThemes()` aktualisiert alle aktiven Terminal-Instanzen beim Theme-Wechsel (`app.js`, KANBAN-016)
- **[MITTEL]** [UI] Terminal startet korrekt, wechselt aber in Schwarz-Weiß: Hardcodierte xterm.js-Theme-Optionen (`background`, `foreground`, `cursor`) aus allen drei `new Terminal()`-Aufrufen in `openTicketTerminal()`, `openBoardTerminal()` und `openDeployTerminal()` entfernt. xterm.js nutzt jetzt seine eingebaute ANSI-Farbpalette, sodass Programmfarben (ANSI Escape Codes) nicht mehr überschrieben werden. Nicht mehr benötigte Funktionen `getTerminalTheme()` und `applyTerminalTheme()` sowie deren Aufrufstellen entfernt. Tote CSS-Variablen `--terminal-fg` und `--terminal-cursor` aus `style.css` entfernt (`app.js`, `style.css`, KANBAN-014)
- **[MITTEL]** [UI] Terminal-Theme: xterm.js verwendete hardcodierte Dunkel-Farben und blieb im Light Mode schwarz. Terminal-Theme-Farben werden jetzt dynamisch aus CSS-Variablen (`--terminal-bg`, `--terminal-fg`, `--terminal-cursor`) gelesen; alle aktiven Terminal-Instanzen werden beim Theme-Wechsel live aktualisiert (`app.js`, KANBAN-013)
- **[HOCH]** `restore_backup` schrieb das wiederhergestellte Board nur in JSON, nicht in SQLite — bei aktiver DB-Verbindung hatte die Wiederherstellung daher keinen Effekt. Fix: `kanban::save_board()` durch `s.save_and_backup()` ersetzt, das je nach Runtime-Kontext SQLite und/oder JSON beschreibt (`src/commands.rs`, KANBAN-010)
- **[MITTEL]** Frontend: `loadInitialState()` catch verwendete `console.error` statt `appendLog` — Initialisierungsfehler waren für den User unsichtbar (`app.js`)
- **[MITTEL]** Frontend: `spawn_terminal` hatte kein `try/catch` — Fehler beim Terminal-Start brach die Funktion still ab ohne User-Feedback (`app.js`)
- **[MITTEL]** Frontend: `loadDeployConfig()` catch verwendete `console.error` statt `appendLog` (`app.js`)
- **[MITTEL]** `activity::log_activity` Aufrufe zentralisiert in `AppState::log_activity()` — routet automatisch zu SQLite oder JSON-Fallback je nach verfügbarer DB-Verbindung
- **[NIEDRIG]** `AppState::log_activity()` wird nicht mehr aufgerufen wenn kein Projekt aktiv ist (vorher: silent no-op)
- **[HOCH]** Ticket-ID-Vergabe in `create_ticket_from_template` und `import_tickets` nutzt jetzt monoton steigenden `next_ticket_id`-Zähler statt `tickets.len() + 1`, um Duplikat-IDs nach Löschungen zu vermeiden

### Security
- **[HOCH]** API-Token im Klartext in `settings.json`: Token wird jetzt mit ChaCha20-Poly1305 verschlüsselt gespeichert, maschinengebunden via `/etc/machine-id`
- **[HOCH]** Crypto-KDF zu schwach: SHA-256 als Key-Derivation-Function für API-Token-Verschlüsselung ersetzt durch PBKDF2-HMAC-SHA256 mit 100.000 Runden (`src/crypto.rs`, KANBAN-011)
  - Maschinengebundene ID jetzt plattformspezifisch: Linux `/etc/machine-id`, macOS `IOPlatformUUID` (via `ioreg`), Windows `MachineGuid` (Registry)
  - Statischer Fallback-Key entfernt; fehlende Machine-ID erzeugt stattdessen eine zufällige UUID, die persistent in `~/.config/kanban-runner/machine-seed.txt` gespeichert wird
  - Token-Format von `v1` auf `v2` angehoben; bestehende `v1`-Tokens werden weiterhin entschlüsselt (vollständige Rückwärtskompatibilität)
  - Neue Abhängigkeit: `pbkdf2` crate
- **[HOCH]** IPC-Angriffsfläche reduziert: `withGlobalTauri: false` in `tauri.conf.json` gesetzt — `window.__TAURI__` wird nicht mehr global exponiert (`tauri.conf.json`, KANBAN-012)
  - `window.__TAURI__.core`/`window.__TAURI__.event`-Zugriffe in `frontend/app.js` durch explizite ES-Module-Imports aus `@tauri-apps/api` ersetzt
  - Vite als Frontend-Build-System eingeführt (`frontend/package.json`, `frontend/vite.config.js`)
  - `tauri.conf.json` Build-Sektion aktualisiert: `frontendDist` zeigt auf `./frontend/dist`; `devUrl`, `beforeDevCommand` und `beforeBuildCommand` hinzugefügt
  - `.gitignore` angepasst: `package.json`-Ignore auf Root-Ebene beschränkt, um `frontend/package.json` nicht zu ignorieren



### Added
- **Bug-Sync (Portal Bug-Tracker):** Bugs aus der Portal `alpha_bugs`-Tabelle koennen automatisch als Bugfix-Tickets ins Kanban Board importiert werden
  - Neues Rust-Modul `bugsync.rs` mit HTTP-Client (reqwest) fuer Portal API
  - Neue Tauri-Commands: `sync_portal_bugs` (synchronisiert Bugs und erstellt Tickets), `get_bug_sync_settings` (liest aktuelle Sync-Konfiguration)
  - Settings-Abschnitt "Bug-Sync (Portal)" mit API URL, API Token, Sync-Intervall und Enable/Disable Toggle
  - Board-Header Button "Bugs synchen" fuer manuellen Sync
  - Sidebar-Badge zeigt Anzahl verfuegbarer Bugs
  - Auto-Sync Timer mit konfigurierbarem Intervall (Standard: 5 min, Minimum: 60 s)
  - Portal-Bugs werden als Bugfix-Tickets im Backlog angelegt mit "Portal-Bug" Badge
  - Ticket-Detail zeigt Portal Bug ID und URL an
  - Neue Felder auf Ticket: `portal_bug_id`, `portal_bug_url`
  - Duplikat-Erkennung: bereits synchronisierte Bugs (gleiche `portal_bug_id`) werden uebersprungen
  - Portal API Endpunkte: `GET /unsynced` (Bugs abrufen), `POST /mark-synced` (Bugs als gesynct markieren mit `kanban_ticket_id`)
  - Plattformuebergreifend (HTTP-basiert, funktioniert auf Windows + Linux)
  - Dependency hinzugefuegt: `reqwest 0.12` mit `json` und `rustls-tls` Features

### Fixed
- **[NIEDRIG]** Dead Code entfernt: `runner.rs` (`parse_token_usage`, `calculate_cost`, `TokenUsage`) war mit `#[allow(dead_code)]` gesilenced und nie exponiert — Modul gelöscht, `mod runner` aus `main.rs` entfernt
- **[NIEDRIG]** `TerminalCmd::Resize(u32, u32)` Parameterreihenfolge (cols, rows) dokumentiert — Code war korrekt, aber unkommentiert und damit missverständlich
- **[NIEDRIG]** Frontend/Backend Model-ID Mismatch: HTML-Selects verwenden jetzt Full-IDs (`claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5-20251001`) statt Shorthands; `modelToFlag()` behandelt alte Shorthand-Werte rückwärtskompatibel; alle `|| "sonnet"`-Fallbacks auf `|| "claude-sonnet-4-6"` aktualisiert
- **[MITTEL]** PTY Read-Fehler wurde komplett ignoriert (`Err(_) => break`): Fehlertyp wird jetzt via `eprintln!` geloggt, damit unerwartete PTY-Fehler von normalem Prozess-Exit unterscheidbar sind (`terminal.rs`)
- **[MITTEL]** Path-Traversal-Härtung in `project_data_dir()`: zusätzlich zum Char-Sanitizing werden jetzt (1) All-Dash-Namen abgelehnt und (2) nach `create_dir_all` ein Canonicalize-Check durchgeführt, der Symlink-basierte Escapes erkennt (`config.rs`)
- **[MITTEL]** Default-Modell von unspezifischem `"sonnet"` auf konkretes `"claude-sonnet-4-6"` aktualisiert; Cost-Defaults ($3/$15) mit Kommentar versehen, dass sie Sonnet 4.6-Preisen entsprechen (`state.rs`)
- **[HOCH]** Nicht-atomarer Board-Save: `save_board()` schreibt jetzt zuerst in `kanban.json.tmp` und benennt dann atomar um — verhindert korrupte Datei bei Absturz mitten im Write (`kanban.rs`)
- **[HOCH]** Backup-Deletion ignorierte Fehler (`let _ = remove_file()`): Fehler werden jetzt via `?` propagiert, damit Disk-Space-Lecks dem Aufrufer gemeldet werden (`kanban.rs`)
- **[HOCH]** Log-Panel ohne Größenlimit: `appendLog()` entfernt jetzt älteste Zeilen sobald `LOG_MAX_LINES = 500` überschritten wird — verhindert DOM-Freeze (`app.js`)
- **[HOCH]** `activity.rs` verwendete `Vec::Remove(0)` (O(n)) für Front-Removal: umgestellt auf `VecDeque::pop_front()` (O(1)) (`activity.rs`)
- **[KRITISCH]** `validate_git_ref()` erlaubte Leerzeichen in Branch-Namen → Leerzeichen aus der Allowlist entfernt, verhindert Argument-Splitting in Git-Aufrufen (`git.rs`)
- **[KRITISCH]** Bug-Sync Timer las Credentials vor dem optionalen Extra-Sleep, verwendete dann möglicherweise veraltete API-URL/Token → Settings werden jetzt *nach* dem Sleep neu gelesen, direkt vor dem HTTP-Request (`main.rs`)
- **[KRITISCH]** `shellEscape()` verwendete POSIX Single-Quote-Escaping für lokale Shell-Argumente, das in Windows CMD nicht funktioniert → neue Funktion `shellEscapeLocal()` mit Double-Quote-Escaping (bash/PowerShell/CMD-kompatibel) für SSH-Key und SSH-Host; `shellEscape()` bleibt für Remote-Bash-Argumente innerhalb des SSH-Command-Strings (`app.js`)

### Security
- **[KRITISCH]** Path Traversal in Agent/Command Editor und Backup-Restore: Namen mit `../` konnten beliebige Dateien lesen/schreiben/löschen. Fix: `validate_safe_name()` und `validate_backup_filename()` prüfen alle Eingaben
- **[KRITISCH]** Command Injection in SSH Deploy: User-Input wurde unescaped in Shell-Befehle interpoliert. Fix: `shell_escape()` und `validate_deploy_param()` in Backend und Frontend
- **[HOCH]** Terminal `spawn_terminal` erlaubte beliebige Shell-Pfade. Fix: Whitelist-Validierung gegen `detect_shells()` in allen Terminal-Spawn-Aufrufen (inkl. Deploy-Funktionen)
- **[HOCH]** Git Branch-Namen wurden nicht validiert, Option-Injection möglich. Fix: `validate_git_ref()` und `--` Separator vor User-Input
- **[HOCH]** Ticket-IDs konnten nach Löschungen kollidieren. Fix: Monoton steigender `next_ticket_id` Counter im Board
- **[HOCH]** `deploy-config.json` war nur indirekt über `.claude/` in `.gitignore` geschützt. Fix: Expliziter Eintrag in `.gitignore`
- **[MITTEL]** Content Security Policy (CSP) im HTML hinzugefügt als Defense-in-Depth gegen XSS
- **[MITTEL]** `log_lines` von `Vec` auf `VecDeque` umgestellt für O(1) statt O(n) Entfernung
- Clippy-Warning in `git.rs` behoben (unnötiges `format!`)

### Fixed
- Terminal-Panel: Einklappen nach Drag-Resize ließ keinen leeren Bereich mehr — inline height wird beim Einklappen entfernt und beim Aufklappen wiederhergestellt
- KANBAN-004: `copy_claude_config()` in `src/git.rs` kopierte bisher den kompletten `.claude/` Ordner in den Worktree inklusive Runtime-Daten (`kanban.json`, `activity-log.json`, `kanban-backups/` etc.) — Fix: Nur `agents/` und `commands/` werden explizit kopiert, alle Runtime-Daten werden übersprungen; `.unwrap_or_default()` beim Lesen von `.gitignore` durch echtes Error-Handling ersetzt
- KANBAN-007: Desktop-Icon zeigte oranges Quadrat statt Raketen-Icon
  - `icon.ico` hatte fehlerhafte nicht-quadratische Dimensionen (32x31, 48x47, 64x62, 128x125, 256x249) — wurde mit korrekten Größen neu generiert: 16x16, 32x32, 48x48, 64x64, 128x128, 256x256
  - `tauri.conf.json` fehlte der `bundle`-Abschnitt mit Icon-Konfiguration vollständig — wurde hinzugefügt
