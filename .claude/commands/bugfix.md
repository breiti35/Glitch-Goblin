# Bugfix für Kanban Runner

## Eingabe
$ARGUMENTS

## Workflow

### 1. Analyse
- Bug reproduzieren und verstehen
- Betroffene Module identifizieren:
  - Rust Backend (src/*.rs) → rust-backend Agent
  - Frontend (frontend/*) → frontend-ui Agent
  - Terminal (terminal.rs + xterm.js) → terminal-pty Agent
- Root Cause finden (nicht nur Symptom fixen)

### 2. Fix implementieren
- Minimaler Fix — nur was nötig ist
- Bestehende Tests nicht brechen
- Windows + Linux Kompatibilität prüfen
- Bei CSS-Bugs: beide Themes (Dark + Cream Light) prüfen
- Bei Rust-Bugs: Error Handling sauber (kein .unwrap())

### 3. Code Review (code-reviewer Agent)
- Fix reviewen: Ist der Root Cause wirklich behoben?
- Keine Regressionen?
- Edge Cases berücksichtigt?

### 4. Security Check (security-reviewer Agent)
- Fix führt keine neuen Sicherheitslücken ein?

### 5. Dokumentation (doc-updater Agent)
- CHANGELOG.md: Fixed-Eintrag
- Falls bekanntes Problem: Doku aktualisieren

### 6. Finaler Check
```bash
cargo build     # 0 Warnings
cargo clippy    # 0 Warnings
cargo test      # Alle Tests grün
```
