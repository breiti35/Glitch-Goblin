# Security Audit für Kanban Runner

## Eingabe
$ARGUMENTS

## Anweisungen

1. **Prüfen** — Folgende Bereiche durchgehen:
   - Input-Validierung (Ticket-Titel, Branch-Namen, Agent-Namen)
   - Command Injection (Shell-Befehle, Git-Befehle, SSH)
   - XSS im WebView (innerHTML mit User-Input)
   - Tauri Permissions (capabilities minimal?)
   - Token/Key Speicherung (verschlüsselt?)
   - Dependencies (`cargo audit` ausführen)
2. **Bericht** — Findings mit Severity (KRITISCH/HOCH/MITTEL/NIEDRIG), Datei und Zeile auflisten
3. **Fixen** — KRITISCH und HOCH sofort beheben
4. **Build** — `cargo check` und `cd frontend && npm run build` müssen fehlerfrei sein
5. **CHANGELOG** — Eintrag unter ### Security hinzufügen
6. **Commit** — Aussagekräftige Commit-Message auf Deutsch

Keine Sub-Agents starten. Alles selbst erledigen.
