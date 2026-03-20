# Bugfix für Kanban Runner

## Eingabe
$ARGUMENTS

## Anweisungen

1. **Analyse** — Root Cause finden, betroffene Dateien identifizieren
2. **Fix** — Minimal, nur was nötig ist. Kein Refactoring nebenbei
3. **Prüfen** — Beide Themes (Dark + Light), kein .unwrap() in Rust, Error Handling sauber
4. **Build** — `cargo check` und `cd frontend && npm run build` müssen fehlerfrei sein
5. **CHANGELOG** — Eintrag unter ### Fixed hinzufügen
6. **Commit** — Aussagekräftige Commit-Message auf Deutsch

Keine Sub-Agents starten. Alles selbst erledigen.
