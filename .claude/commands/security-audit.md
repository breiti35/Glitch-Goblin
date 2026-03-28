# Security Audit fuer Glitch Goblin

## Eingabe
$ARGUMENTS

## Anweisungen

1. **Scan** -- security-reviewer Agent starten fuer die initiale Analyse
2. **Security Review** -- `/security-review` ausfuehren fuer den offiziellen Claude Code Security-Check
3. **Bewerten** -- Findings aus beiden Scans nach Severity sortieren
4. **Fixen** -- KRITISCH und HOCH sofort beheben
5. **Build** -- `cargo check` und `cd frontend && npm run build` muessen fehlerfrei sein
6. **Tests** -- `cargo test` muss fehlerfrei sein
7. **CHANGELOG** -- Eintrag unter ### Security hinzufuegen
8. **Commit** -- Aussagekraeftige Commit-Message auf Deutsch
