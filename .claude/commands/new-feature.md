# Neues Feature für Kanban Runner

## Eingabe
$ARGUMENTS

## Anweisungen

1. **Verstehen** — Was genau soll gebaut werden? Welche Dateien sind betroffen?
2. **Backend** (falls nötig) — Neue Commands in `src/commands.rs`, Structs in passenden Modulen, in `src/main.rs` registrieren
3. **Frontend** (falls nötig) — HTML in `frontend/index.html`, Logik im passenden Modul (`frontend/board.js`, `frontend/git.js`, etc.), CSS in `frontend/style.css`
4. **Prüfen** — Beide Themes, CSS-Variablen statt Hardcoded-Farben, kein .unwrap() in Rust
5. **Build** — `cargo check` und `cd frontend && npm run build` müssen fehlerfrei sein
6. **CHANGELOG** — Eintrag unter ### Added hinzufügen
7. **Commit** — Aussagekräftige Commit-Message auf Deutsch

Keine Sub-Agents starten. Alles selbst erledigen.
Nur Dateien ändern die zum Feature gehören — kein Refactoring nebenbei.
