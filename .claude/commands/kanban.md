# Kanban Ticket abarbeiten

## Workflow

### 1. Board lesen
Lies `.claude/kanban.json` und finde das höchstpriorisierte Ticket im Backlog:
- Prio: high > medium > low
- Bei gleicher Prio: ältestes zuerst (createdAt)

### 2. Ticket-Typ erkennen und passenden Workflow starten

| Typ | Workflow |
|---|---|
| feature | /new-feature [Ticket-Titel]: [Ticket-Beschreibung] |
| bugfix | /bugfix [Ticket-Titel]: [Ticket-Beschreibung] |
| security | /security-audit [Ticket-Titel]: [Ticket-Beschreibung] |
| docs | Nutze den doc-updater Agent und aktualisiere die Doku: [Ticket-Titel] |

### 3. Ticket-Status aktualisieren
- Vor Start: column → "progress", startedAt setzen
- Nach Abschluss: column → "review", reviewAt setzen
- Bei Fehler: column → "backlog"

### 4. Board zurückschreiben
Schreibe das aktualisierte Board zurück in `.claude/kanban.json`.

### Wichtig
- Ändere NUR Dateien die zum Projekt gehören
- Der .claude/ Ordner ist für Konfiguration, nicht für Code-Änderungen
- Beschreibung des Tickets genau lesen und als Anforderung umsetzen
