# Bugfix fuer Glitch Goblin

## Eingabe
$ARGUMENTS

## Anweisungen

1. **Analyse** -- Root Cause finden, betroffene Dateien identifizieren
2. **Fix** -- Minimal, nur was noetig ist. Kein Refactoring nebenbei
3. **Pruefen** -- Beide Themes (Dark + Light), kein .unwrap() in Rust, Error Handling sauber
4. **Build** -- `cargo check` und `cd frontend && npm run build` muessen fehlerfrei sein
5. **Tests** -- `cargo test` muss fehlerfrei sein
6. **CHANGELOG** -- Eintrag unter ### Fixed hinzufuegen
7. **Commit** -- Aussagekraeftige Commit-Message auf Deutsch
8. **Security** -- `/security-review` ausfuehren um die Aenderungen auf Sicherheitsluecken zu pruefen
9. **Review** -- code-reviewer Agent starten um die Aenderungen zu pruefen

Keine Sub-Agents starten ausser dem code-reviewer am Ende.
