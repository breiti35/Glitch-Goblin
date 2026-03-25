## Bugfixes & Robustheit

### Board
- Karten werden bei vielen Tickets nicht mehr zusammengequetscht
- Start-Button im "immer offen"-Modus sichtbar
- Delete, Merge und Archiv fragen jetzt vor der Aktion nach Bestaetigung

### Ticket-Lifecycle
- Tickets koennen nur noch aus der richtigen Spalte abgeschlossen/gemergt werden
- Ein laufendes Ticket blockiert nicht mehr dauerhaft nach dem Loeschen

### Sicherheit
- Windows-reservierte Dateinamen (CON, NUL, etc.) werden beim Erstellen von Agenten/Befehlen abgelehnt
- Git-Dateipfade werden gegen Path-Traversal validiert
- Deploy-Befehle werden korrekt escaped

### Updater
- Update-Dialog zeigt jetzt korrekte deutsche/englische Texte
- Release Notes werden im Update-Dialog angezeigt
