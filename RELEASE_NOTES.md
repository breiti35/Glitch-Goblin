## Neue Features

### Bug-Sync Inbox (GG-112)
- Einträge aus dem Portal werden nicht mehr automatisch als Tickets importiert
- Neue Inbox-Ansicht zum Sichten: Übernehmen oder Ablehnen pro Eintrag
- Sync-Modus konfigurierbar: "Automatisch" oder "Inbox" (neuer Default)

### Bug-Sync Status-Rückmeldung (GG-113)
- Übernahme meldet dem Portal "In Bearbeitung"
- Ticket nach Done → Portal zeigt "Behoben"
- Ablehnung → Portal zeigt "Abgelehnt"
- User im Portal sieht den aktuellen Status seiner Meldung

### Bug-Sync: Feedback & Ideen (GG-111)
- Nicht nur Bugs, auch Feedback und Ideen werden synchronisiert
- Typ-Mapping: Bug → Bugfix (high), Feedback → Docs (medium), Idee → Feature (medium)

### Plugins
- 7 offizielle Plugins installiert: Frontend Design, Code Review, Code Simplifier, Feature Dev, GitHub, Context7, Superpowers
- `/security-review` in alle Projekt-Skills eingebaut

## Bugfixes

- Terminal: Multiline-Prompts senden jetzt automatisch Enter nach dem Paste — kein manuelles Enter mehr nötig
- Bug-Sync: Status-Update URL korrekt zusammengebaut (`/api/bugs/:id/status`)
- README Editor: Save-Crash bei HTML-Inhalt behoben (GG-110)
- README: Badge-Bilder als Text-Badges statt kaputte externe Images
- CSS: Undefinierte Variablen korrigiert (--surface-low, --text-muted)
