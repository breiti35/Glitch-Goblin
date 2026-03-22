# Kanban Ticket abarbeiten

## Anweisungen

1. **Ticket lesen** -- Titel und Beschreibung genau lesen
2. **Typ erkennen** und passend arbeiten:
   - **feature** -- Implementieren (Backend + Frontend wo noetig)
   - **bugfix** -- Root Cause finden, minimal fixen
   - **security** -- security-reviewer Agent starten, Findings fixen
   - **docs** -- Dokumentation aktualisieren
3. **Build** -- `cargo check` und `cd frontend && npm run build` muessen fehlerfrei sein
4. **Tests** -- `cargo test` muss fehlerfrei sein
5. **CHANGELOG** -- Passenden Eintrag hinzufuegen
6. **Commit** -- Aussagekraeftige Commit-Message auf Deutsch
7. **Review** -- Bei feature/bugfix: code-reviewer Agent starten

Nur Dateien aendern die zur Aufgabe gehoeren.
Agents nur aufrufen wenn im Schritt angegeben.
