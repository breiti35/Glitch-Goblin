# Neues Feature fuer Glitch Goblin

## Eingabe
$ARGUMENTS

## Anweisungen

1. **Verstehen** -- Was genau soll gebaut werden? Welche Dateien sind betroffen?
2. **Backend** (falls noetig) -- Neue Commands in `src/commands.rs`, Structs in passenden Modulen, in `src/main.rs` registrieren
3. **Frontend** (falls noetig) -- HTML in `frontend/index.html`, Logik im passenden Modul, CSS in `frontend/style.css`
4. **Pruefen** -- Beide Themes, CSS-Variablen statt Hardcoded-Farben, kein .unwrap() in Rust
5. **Build** -- `cargo check` und `cd frontend && npm run build` muessen fehlerfrei sein
6. **Tests** -- `cargo test` muss fehlerfrei sein
7. **CHANGELOG** -- Eintrag unter ### Added hinzufuegen
8. **Commit** -- Aussagekraeftige Commit-Message auf Deutsch
9. **Security** -- `/security-review` ausfuehren um die Aenderungen auf Sicherheitsluecken zu pruefen
10. **Review** -- code-reviewer Agent starten um die Aenderungen zu pruefen

Keine Sub-Agents starten ausser dem code-reviewer am Ende.
Nur Dateien aendern die zum Feature gehoeren -- kein Refactoring nebenbei.
