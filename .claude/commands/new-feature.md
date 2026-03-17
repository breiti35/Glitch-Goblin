# Neues Feature für Kanban Runner

## Eingabe
$ARGUMENTS

## Workflow

### 1. Backend (rust-backend Agent)
- Neue Structs/Commands in den passenden Modulen anlegen
- Neue Commands in main.rs registrieren
- Neue Settings-Felder mit #[serde(default)] hinzufügen
- cargo build + cargo clippy prüfen

### 2. Frontend (frontend-ui Agent)
- Neue View/Modal/Panel in index.html
- Logik in app.js (invoke, listen, DOM-Updates)
- Styling in style.css (beide Themes!)
- Tauri IPC korrekt verdrahten

### 3. Terminal (terminal-pty Agent, falls relevant)
- PTY-Integration falls Terminal-Features betroffen
- Shell-Erkennung falls neue OS-Features

### 4. Code Review (code-reviewer Agent)
- Rust: Mutex-Handling, Error-Handling, serde-Kompatibilität
- Frontend: CSS Variables, Theme-Support, keine Memory Leaks
- Cross-Platform: Windows + Linux getestet

### 5. Security Review (security-reviewer Agent)
- Input-Sanitization geprüft
- Keine Command-Injection möglich
- Tauri Permissions minimal

### 6. Dokumentation (doc-updater Agent)
- README.md Features-Liste aktualisieren
- CHANGELOG.md Eintrag
- Inline-Docs für neue Commands
- Versionsnummer bumpen falls nötig

### 7. Finaler Check
```bash
cargo build     # 0 Warnings
cargo clippy    # 0 Warnings
cargo test      # Alle Tests grün
```
