# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

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

### Fixed
- **[HOCH]** `restore_backup` schrieb das wiederhergestellte Board nur in JSON, nicht in SQLite — bei aktiver DB-Verbindung hatte die Wiederherstellung daher keinen Effekt. Fix: `kanban::save_board()` durch `s.save_and_backup()` ersetzt, das je nach Runtime-Kontext SQLite und/oder JSON beschreibt (`src/commands.rs`, KANBAN-010)
- **[MITTEL]** Frontend: `loadInitialState()` catch verwendete `console.error` statt `appendLog` — Initialisierungsfehler waren für den User unsichtbar (`app.js`)
- **[MITTEL]** Frontend: `spawn_terminal` hatte kein `try/catch` — Fehler beim Terminal-Start brach die Funktion still ab ohne User-Feedback (`app.js`)
- **[MITTEL]** Frontend: `loadDeployConfig()` catch verwendete `console.error` statt `appendLog` (`app.js`)
- **[MITTEL]** `activity::log_activity` Aufrufe zentralisiert in `AppState::log_activity()` — routet automatisch zu SQLite oder JSON-Fallback je nach verfügbarer DB-Verbindung
- **[NIEDRIG]** `AppState::log_activity()` wird nicht mehr aufgerufen wenn kein Projekt aktiv ist (vorher: silent no-op)
- **[HOCH]** Ticket-ID-Vergabe in `create_ticket_from_template` und `import_tickets` nutzt jetzt monoton steigenden `next_ticket_id`-Zähler statt `tickets.len() + 1`, um Duplikat-IDs nach Löschungen zu vermeiden

### Security
- **[HOCH]** API-Token im Klartext in `settings.json`: Token wird jetzt mit ChaCha20-Poly1305 verschlüsselt gespeichert, maschinengebunden via `/etc/machine-id`



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
- **[HOCH]** `activity.rs` verwendete `Vec::remove(0)` (O(n)) für Front-Removal: umgestellt auf `VecDeque::pop_front()` (O(1)) (`activity.rs`)
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
