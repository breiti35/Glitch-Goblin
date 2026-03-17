# Security Audit für Kanban Runner

## Eingabe
$ARGUMENTS

## Workflow

### 1. Review (security-reviewer Agent)
Prüfe ALLE Sicherheitsbereiche:

- **Tauri Permissions:** capabilities/default.json minimal?
- **XSS im WebView:** innerHTML mit User-Input? Template-Literal Injection?
- **Command Injection:** Shell-Befehle mit User-Input (Ticket-Titel, Branch-Namen)?
- **SSH Security:** Keys nie gespeichert? deploy-config.json in .gitignore?
- **PTY Security:** Terminal-Escape-Sequences? Sandbox-Ausbruch?
- **Data Leakage:** Sensible Daten in Logs/Activity/Backups?
- **Dependencies:** `cargo audit` ausführen, bekannte CVEs?

Erstelle einen vollständigen Bericht mit Severity-Level.

### 2. Fix (security-fixer Agent)
- Alle KRITISCH und HOCH Findings beheben
- MITTEL Findings wenn möglich beheben
- NIEDRIG dokumentieren für spätere Bearbeitung

### 3. Re-Verify (security-reviewer Agent)
- Alle Fixes nochmal prüfen
- Keine neuen Probleme eingeführt?
- Findings-Liste aktualisieren (behoben markieren)

### 4. Dokumentation (doc-updater Agent)
- CHANGELOG.md: Security-Fixes dokumentieren
- README.md: Security-Hinweise falls nötig

### 5. Finaler Check
```bash
cargo build     # 0 Warnings
cargo clippy    # 0 Warnings
cargo test      # Alle Tests grün
cargo audit     # Keine bekannten CVEs
```
