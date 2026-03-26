## Neue Features

### Projekt-Einstellungen
- Neues Projekt-Settings Modal: GitHub, Bug-Sync, Deploy und Ticket-Prefix an einem Ort
- Globale und projektspezifische Einstellungen sind jetzt sauber getrennt

### Onboarding
- Welcome-Modal beim ersten App-Start fuehrt durch die Ersteinrichtung
- Projekt anlegen, Ticket-Prefix und Claude Code Verbindung in einem Schritt

### Anthropic Login
- Mit Anthropic anmelden direkt in der App (ueber Claude Code Login)
- Usage-Anzeige funktioniert unabhaengig davon ob Claude Code parallel laeuft

### README im Dashboard
- README.md wird als gerendertes Markdown angezeigt (Ueberschriften, Listen, Code-Bloecke, Tabellen)
- Integrierter Editor mit Live-Preview zum Bearbeiten direkt in der App
- HTML-Inhalte werden sicher gerendert (XSS-geschuetzt)

## Bugfixes

- Terminal: Mehrzeiliger Prompt verschwindet nicht mehr (Bracketed Paste Mode)
- README Edit-Button: Pfad auf Windows korrekt, kein haesslicher System-Fehlerdialog mehr
- Badge-Bilder in README werden als Text-Badges dargestellt statt kaputte Platzhalter
