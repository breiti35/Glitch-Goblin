# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

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
