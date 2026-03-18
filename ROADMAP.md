# Kanban Runner — Roadmap

Priorisierte Feature-Ideen und geplante Verbesserungen, geordnet nach Aufwand und Nutzen.

---

## Kurzfristig (machbar, niedrige Komplexität)

Diese Verbesserungen sind in einem oder wenigen Tagen umsetzbar ohne strukturelle Änderungen.

- **Undo/Redo für Ticket-Aktionen** — Letzte Moves/Edits rückgängig machen (in-memory History)
- **Keyboard-Only Navigation** — Vollständige Bedienung ohne Maus; Tab/Arrow-Keys zwischen Tickets, Shortcuts für alle Hauptaktionen
- **Markdown-Editor für Ticket-Beschreibungen** — Split-View: linke Seite Markdown, rechte Seite gerenderte Vorschau
- **Filter-State persistieren** — Aktive Text-/Typ-/Prio-Filter überleben einen App-Reload (localStorage)
- **Bulk-Aktionen** — Mehrere Tickets gleichzeitig auswählen und verschieben, löschen oder Prio ändern
- **Backup-Strategie verbessern** — Bei korrupter DB/JSON automatisch letztes Backup laden und User benachrichtigen
- **File-Watcher Fehler an UI melden** — Watcher-Fehler in `appendLog` statt nur als `s.log`

---

## Mittelfristig (höherer Aufwand, klarer Mehrwert)

Diese Features brauchen mehr Planung, liefern aber substanziellen Mehrwert.

- **Ticket-Dependencies (Blocked-By / Related)** — Tickets können andere Tickets als Blocker oder verwandt markieren; Board zeigt Blocker-Badges
- **Webhook-Integration** — Outgoing Webhooks bei Ticket-Status-Änderungen (Slack, GitHub Issues, Linear, benutzerdefiniert)
- **HTML/Excel-Reports exportieren** — Projektbericht mit Burn-down-Chart, Durchlaufzeiten, Ticket-Statistiken
- **Virtual Scrolling im Frontend** — Performance bei 500+ Tickets durch DOM-Virtualisierung (z.B. mit `@tanstack/virtual`)
- **Erweiterte Suche** — Volltextsuche über Titel + Beschreibung + Kommentare, Suche über alle Projekte
- **Ticket-Tags/Labels** — Frei definierbare Tags ergänzend zur Typ-Klassifikation
- **Drag-and-Drop zwischen Projekten** — Tickets direkt per Drag aus einem Projekt in ein anderes verschieben

---

## Längerfristig / Innovativ

Ambitioniertere Features, die neue Technologien oder größere Umbauarbeiten erfordern.

- **AI-gestütztes Ticket-Scoring** — Claude analysiert automatisch Ticket-Titel und -Beschreibung und schlägt Priorität und Komplexitäts-Estimate vor
- **Smart Sprint-Planung** — Claude schlägt eine optimale Sprint-Zusammenstellung basierend auf gemessener Velocity, Ticket-Prioritäten und Team-Kapazität vor
- **Multi-User / Team-Modus** — Gemeinsames Board über Git-Sync (Board-State in einem dedizierten Branch); Offline-first mit Merge-Conflict-Auflösung
- **Automatische Changelog-Generierung** — Aus abgeschlossenen Tickets (Done-Spalte) einen strukturierten Changelog-Eintrag erzeugen (Claude-gestützt)
- **Voice-Input für Tickets** — Spracheingabe für Ticket-Erstellung und -Beschreibung via Whisper API
- **Plugin-System** — Drittanbieter-Integrationen als WASM-Plugins (Jira-Import, GitHub-PR-Verknüpfung, etc.)

---

## Technische Schulden (bekannt, niedrige Priorität)

- `block_on()` im Setup-Closure in `main.rs` — potentieller Deadlock bei hoher Last; Umbau auf vollständig async Setup
- Frontend-Komponenten sind monolithisch in `app.js` — schrittweise in Web Components / kleinere Module aufteilen
- Keine automatisierten Integration-Tests — E2E-Tests mit Tauri Test-Framework aufsetzen
- `activity.rs` JSON-Fallback langfristig entfernen — sobald alle bestehenden Installationen migriert sind

---

*Zuletzt aktualisiert: März 2026*
