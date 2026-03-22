# Security Audit fuer Glitch Goblin

## Eingabe
$ARGUMENTS

## Anweisungen

1. **Scan** -- security-reviewer Agent starten fuer die Analyse
2. **Bewerten** -- Findings nach Severity sortieren
3. **Fixen** -- KRITISCH und HOCH sofort beheben
4. **Build** -- `cargo check` und `cd frontend && npm run build` muessen fehlerfrei sein
5. **Tests** -- `cargo test` muss fehlerfrei sein
6. **CHANGELOG** -- Eintrag unter ### Security hinzufuegen
7. **Commit** -- Aussagekraeftige Commit-Message auf Deutsch

Nur den security-reviewer Agent fuer die initiale Analyse starten.
