# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

### Added
- **GG-106 OAuth Login mit Anthropic direkt in der App:** Eigener OAuth 2.0 PKCE Login-Flow, unabhaengig von der Claude Code CLI. Neues Backend-Modul `oauth.rs` implementiert den vollstaendigen Authorization Code Flow mit PKCE (S256 Code Challenge), localhost Redirect-Server auf zufaelligem Port, State-Parameter gegen CSRF, und automatischem Token-Refresh. Drei neue Tauri-Commands: `start_anthropic_login` (oeffnet Browser, wartet auf Callback, tauscht Code gegen Tokens), `get_anthropic_auth_status` (Verbindungsstatus abfragen), `anthropic_logout` (Tokens loeschen). Access- und Refresh-Tokens werden mit ChaCha20-Poly1305 verschluesselt in settings.json gespeichert (bestehendes Crypto-Modul). Tokens werden nie an das Frontend gesendet. `get_claude_usage` nutzt jetzt eine 4-stufige Strategie: In-Memory-Cache, File-Cache, eigener OAuth-Token (mit automatischem Refresh), Fallback auf Claude Code Token. Neuer Bereich "Anthropic Verbindung" in den Systemeinstellungen mit Verbindungsstatus-Badge und Login/Logout-Buttons. Onboarding Step 3 erweitert mit Auswahl zwischen Claude Code CLI und Anthropic OAuth. Vollstaendig i18n-faehig (DE/EN). 14 neue Unit-Tests fuer PKCE, URL-Encoding, Query-Parameter-Parsing und Token-Expiry.
- **GG-105 Onboarding Welcome-Modal beim ersten Start:** Welcome-Wizard der beim allerersten App-Start erscheint (kein Projekt in projects.json). Fuehrt neue User in 5 Schritten durch die Ersteinrichtung: Willkommen (Logo + Begruessung), Projektordner auswaehlen (mit Git-Repository-Validierung, Projektname automatisch aus Ordnername), Ticket-Prefix festlegen (Default-Vorschlag aus Projektname-Initialen), Claude Code Erkennung (automatisch `claude --version` ausfuehren, manueller Pfad als Fallback), Zusammenfassung mit "Los geht's!"-Button. Stepper-UI im Stitch Design mit animierten Schritt-Indikatoren. Neue Backend-Commands `check_claude_cli` und `validate_git_repo`. Nach Abschluss wird Projekt angelegt, Prefix gesetzt, Settings gespeichert und das Board geladen. Modal erscheint nie wieder solange mindestens ein Projekt existiert. Vollstaendig i18n-faehig (DE/EN).
- **GG-104 Dashboard README als gerendertes Markdown anzeigen:** Die README.md wird im Dashboard jetzt als gerendertes Markdown dargestellt statt als Rohtext. Neuer leichtgewichtiger Markdown-Renderer (`markdown.js`) ohne externe Abhaengigkeiten — unterstuetzt Ueberschriften, Fettdruck, Kursiv, Code-Bloecke, Inline-Code, Listen, Links, Blockquotes, Horizontal Rules und Strikethrough. Bilder werden als Platzhalter angezeigt (lokale Pfade funktionieren nicht im WebView). Der Stift-Button oben rechts oeffnet die README im Standard-Editor (neuer Backend-Command `open_readme`). Markdown-Output ist XSS-sicher durch HTML-Escaping vor dem Rendering. README-Preview-Limit von 500 auf 3000 Zeichen erhoeht. CSS-Styling passend zum Stitch Design mit CSS-Variablen.
- **GG-103 Projekt-Einstellungen von globalen Settings trennen:** Neues Modal "Projekt-Einstellungen" (oeffnen per Rechtsklick/Klick auf Projekt-Avatar). GitHub, Bug-Sync und Deploy-Einstellungen sind jetzt projektspezifisch und werden in `projects.json` pro Projekt gespeichert. Der globale Settings-Tab enthaelt nur noch systemweite Einstellungen (Theme, Sprache, Akzentfarbe, Claude CLI, Modell, Terminal, Benachrichtigungen). Bestehende globale GitHub- und Bug-Sync-Einstellungen werden automatisch ins Default-Projekt migriert. Neue Backend-Commands `get_project_settings` und `save_project_settings`.

### Fixed
- **GG-102 validate_api_token fehlt in mark_bugs_synced:** `mark_bugs_synced` in `bugsync.rs` rief `validate_api_url` auf, validierte den API-Token aber nicht. Ein Token mit eingebettetem `\n` oder `\r` haette Header Injection im `Authorization`-Header ermoeglichen koennen. Analog zu `fetch_unsynced_bugs` wird jetzt `validate_api_token(api_token)?` vor dem Setzen des Headers aufgerufen.
- **GG-101 TOCTOU Race Condition in create_agent und create_command:** Beide Funktionen prueften Datei-Existenz mit synchronem `Path::exists()` in async-Kontext und erstellten die Datei erst danach mit `tokio::fs::write()`. Zwischen Check und Write konnte eine parallele Task dieselbe Datei anlegen — silent overwrite. `exists()` + `write()` wurde durch `tokio::fs::OpenOptions::new().write(true).create_new(true).open()` ersetzt, das Pruefen und Erstellen atomar kombiniert (O_EXCL/CREATE_NEW auf OS-Ebene). Fehler mit `ErrorKind::AlreadyExists` werden auf die bisherige Fehlermeldung gemappt.
- **GG-100 reqwest Client pro Aufruf neu erstellt:** `get_build_status` und `get_claude_usage` in `commands.rs` sowie `fetch_unsynced_bugs` und `mark_bugs_synced` in `bugsync.rs` erstellten jeweils einen neuen `reqwest::Client` mit eigenem Connection-Pool. Vier separate Stellen nutzen jetzt je einen dateiweiten `static HTTP_CLIENT` via `std::sync::LazyLock`, der einmalig initialisiert und fuer alle Aufrufe wiederverwendet wird. Der bisher auf Client-Ebene gesetzte Timeout in `get_claude_usage` wurde auf den RequestBuilder verschoben, sodass beide Files einen schlanken `Client::new()` teilen.
- **GG-099 Fehlender DB-Index auf ticket_comments(ticket_id):** SQLite erstellt keinen automatischen Index fuer Foreign Keys. Alle `SELECT`- und `DELETE`-Queries auf `ticket_comments` nach `ticket_id` (Kommentare laden, Kommentare beim Sync loeschen) fuehrten dadurch einen Full-Table-Scan durch. Schema-Migration v2→v3 fuegt `CREATE INDEX IF NOT EXISTS idx_comments_ticket ON ticket_comments(ticket_id)` hinzu. Bestehende Datenbanken werden beim naechsten Start automatisch migriert. Hinweis: `activity_log.id` ist `INTEGER PRIMARY KEY` und damit in SQLite bereits implizit als Rowid-B-Tree indiziert — kein zusaetzlicher Index noetig.
- **GG-098 Fehlende Null-Checks vereinheitlichen:** In `statistics.js`, `board.js`, `activity.js` und `dashboard.js` wurden ca. 14 `getElementById()`-Aufrufe ohne Null-Check gefunden, die inkonsistent mit dem Rest der Codebase (if-Guards, optional chaining) waren. `statistics.js`: `stat-total`, `stat-done`, `stat-cycle`, `stats-badge`, `pie-chart`, `pie-legend`, `bar-chart`, `recent-completed` erhalten jetzt if-Guards oder fruehe returns. `activity.js`: `activity-list` in `loadActivityView` und `renderActivityList` werden mit `if (!list) return` abgesichert. `dashboard.js`: `dashboard-project-name`, `dash-readme-body`, `dash-commits-body`, `dash-activity-body` erhalten if-Guards. `board.js`: `ticket-count`, `board-title` werden per Variable + Guard geschrieben; `running-badge` wird in einen if-Block eingepackt; `closeContextMenu` nutzt jetzt `?.classList.add("hidden")`.
- **GG-097 Variable-t-Shadowing der i18n-Funktion:** In `board.js`, `statistics.js`, `dashboard.js` und `detail.js` verwendeten `.filter(t => ...)`, `.map(t => ...)`, `.find(t => ...)`, `.forEach(t => ...)` und `.reduce((sum, t) => ...)` den Parameternamen `t`, der den Import `t` aus `i18n.js` ueberschattete. 14 betroffene Stellen umbenannt: Callback-Parameter sind jetzt durchgehend `tk` (Tickets) bzw. `tech` (Tech-Stack-Strings) und `tmpl` (Template-Objekte).
- **GG-096 i18n Hardcoded Strings:** ~15 hardcoded deutsche/englische Strings in Frontend-Dateien (statistics.js, activity.js, detail.js, git.js, app.js, projects.js) wurden durch `t()`-Aufrufe ersetzt. Neue i18n-Keys für KATEGORIEN, Timeline-Labels (Created/Started/Review/Done), Activity-Filter-Labels (TODAY/YESTERDAY/THIS WEEK/OLDER), Git-Headers, Archive-Messages und Validierungsmeldungen hinzugefügt. Beide Sprachen (DE/EN) werden korrekt unterstützt.
- **GG-095 Terminal Code-Duplizierung (Board vs Page):** `createTerminalInstance`/`createPageTerminalInstance`, `cleanupTerminal`/`cleanupPageTerminal` und `refitBoardTerminal`/`refitPageTerminal` waren je nahezu identische Funktionspaare (~200 Zeilen Duplikat). Zwei Kontext-Deskriptoren `BOARD_CTX` und `PAGE_CTX` (je mit `containerId`, `tabsId`, `emptyStateId`, `stateKey`, `activeKey`) ersetzen die hardcodierten Bezeichner. Vier generische Hilfsfunktionen (`createTerminalInstance`, `cleanupTerminalInContext`, `refitTerminal`, `switchTerminalTab`) nehmen einen Kontext als Parameter; die oeffentlichen Exports (`cleanupTerminal`, `cleanupPageTerminal`, `refitBoardTerminal`, `refitPageTerminal`) sind jetzt duenne Wrapper. Nebeneffekt: `cleanupTerminal` verwendete global `.terminal-tab`/`.terminal-instance` statt scope-gebundener Selektoren — behebt latenten Bug, bei dem Board-Cleanup auch Page-Tabs betraf.
- **GG-094 list_branches: N+2 sequentielle Git-Prozesse pro Branch:** `list_branches` rief `get_branch_counts` fuer jeden Branch sequentiell auf, was 2 Git-Prozesse pro Branch startete (`rev-list` + `diff --numstat`). Bei 50 Branches resultierten daraus 100+ sequentielle Prozesse. Zweistufige Umstrukturierung: Erst werden alle Branch-Metadaten geparst, dann werden alle `get_branch_counts`-Aufrufe per `tokio::spawn` parallel gestartet und die Handles sequentiell joined. Wall-Clock-Zeit skaliert jetzt mit der langsamsten Query statt mit der Summe aller Queries.
- **GG-093 Mutex in Agenten-Commands ueber async I/O gehalten:** Alle 8 CRUD-Commands fuer Agents und Commands (`read_agent`, `save_agent`, `create_agent`, `delete_agent`, `read_command`, `save_command`, `create_command`, `delete_command`) hielten den AppState-Mutex waehrend der gesamten tokio::fs-Operation. Da `project_path()` einen `PathBuf` klont, wird der Lock-Guard jetzt in einem Block-Scope erstellt, der `PathBuf` extrahiert, und der Guard vor dem ersten `.await` gedroppt.
- **GG-068 JSON-Import replace-Modus ohne Validierung:** Im replace-Modus wurde das Board ohne Validierung durch den Import ersetzt. Ein JSON mit leerem `project_name` (z.B. `{"project_name": "", "tickets": []}`) wurde von serde korrekt geparst, zerstoerte aber das bestehende Board. Vor dem Ersetzen wird jetzt geprueft, dass `project_name` nicht leer oder rein whitespace ist; andernfalls wird der Import mit einer Fehlermeldung abgelehnt. Die Pflichtfeld-Praesenz von `tickets` wird bereits durch serde erzwungen (kein `#[serde(default)]`).
- **GG-067 create_ticket_from_template ignoriert DB-Templates:** `create_ticket_from_template` lud Templates ausschliesslich ueber `config::load_templates` aus dem Dateisystem. Seit der SQLite-Migration werden Templates in der `ticket_templates`-Tabelle gespeichert. DB-Templates waren in der UI sichtbar (da `list_templates` korrekt DB-first ist), konnten aber nicht zum Erstellen von Tickets genutzt werden — der Aufruf scheiterte mit "Template not found". Die Funktion prueft jetzt zuerst die DB (`db::load_templates`) und faellt nur auf das Dateisystem zurueck wenn keine DB-Verbindung besteht, analog zu `list_templates` und `save_templates`.
- **GG-066 switchProject ohne Guard — Race Condition bei schnellem Wechsel:** `switchProject()` machte fuenf sequentielle `invoke`-Aufrufe ohne Guard. Bei schnellem Doppelklick konnten sich die Aufrufe ueberlappen und erzeugte inkonsistenten State (z.B. board von Projekt A, project von Projekt B). `switchProject` wird jetzt mit `withGuard()` aus utils.js gewrappt, das verhindert gleichzeitige Ausfuehrung durch eine `running`-Flag. Beim naechsten Doppelklick returniert die zweite Anfrage sofort ohne Aktion.
- **GG-065 esc() gibt leeren String fuer 0 und false zurueck:** `esc(str)` pruefte `if (!str) return ""` — das behandelt falsy Werte wie `0`, `false`, `null`, `undefined` als Error und gibt einen leeren String zurueck. Wird `esc(0)` aufgerufen (z.B. bei der Kostenanzeige bei Kosten von 0 USD), kommt jetzt korrekt "0" statt "". Die Funktion prueft jetzt `if (str == null) return ""` (nur `null` und `undefined`) und konvertiert alle anderen Werte mit `String(str)`.
- **GG-064 Leerer Token ueberschreibt gespeicherten Token beim Settings-Speichern:** Wenn der User die Settings öffnete und speicherte ohne den API- oder GitHub-Token einzugeben, wurde ein leerer String ans Backend geschickt und überschrieb den gespeicherten Token. `save_settings` ruft jetzt `preserve_token_if_empty` auf: ist der eingehende Token leer und der gespeicherte Token nicht leer, bleibt der bestehende Token erhalten. Die Hilfsfunktion ist isoliert unit-getestet (4 Szenarien).

### Security
- **GG-063 validate_safe_name blockiert keine Windows-reservierten Namen:** `validate_safe_name` pruefte nur auf Path-Traversal-Zeichen (`..`, `/`, `\`, `\0`), liess aber Windows-Geraete-Namen (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) und den Doppelpunkt (`:`) durch. Ein Agent oder Command mit dem Namen `NUL` haette alle Schreiboperationen still verworfen; `CON` haette den Backend-Thread auf stdin blockiert; `COM1` haette die serielle Schnittstelle angesprochen. Ein Doppelpunkt in einem Namen erlaubt auf NTFS Alternate Data Streams (`agent:stream`). Neue Konstante `WINDOWS_RESERVED_NAMES` und Hilfsfunktion `is_windows_reserved_name` (case-insensitiv). `validate_safe_name` blockt jetzt `:` und alle reservierten Namen. `validate_backup_filename` prueft zusaetzlich den Stem (ohne `.json`-Erweiterung) auf reservierte Namen.

## [0.2.10-alpha] - 2026-03-24

### Security
- **GG-058 Git file_path Parameter ohne Path-Traversal-Validierung:** `get_file_diff`, `get_commit_file_diff` und `get_working_file_diff` uebergaben `file`-Parameter vom Frontend direkt an Git-Kommandos. Obwohl der `--`-Separator Option-Injection verhindert, ermoeglichte ein Wert wie `../../.env` den Zugriff auf Dateien ausserhalb des Repositories. Neue Funktion `validate_file_path` lehnt leere Pfade, Null-Bytes, absolute Pfade (Unix `/`, Windows `\` und Laufwerksbuchstaben wie `C:`) sowie `..`-Komponenten ab.
- **GG-056 Deploy SSH-Commands ohne Shell-Escaping:** Zwei Shell-Injection-Luecken im Deploy-Modul geschlossen. (1) `executeLocalDeployStop` baute Compose-Dateinamen ohne `shellEscapeLocal` in den PTY-Befehl ein — analog zu `executeLocalDeploy` wird jetzt `shellEscapeLocal(f)` verwendet. (2) `validateDeployParam` liess doppelte Anfuehrungszeichen (`"`) und Backslashes (`\`) durch, die die aeussere SSH-Befehlsquotierung haetten aufbrechen koennen — beide Zeichen sind jetzt in der Blocklist.

### Added
- **GG-050 Auto-Updater:** Tauri Updater Plugin mit GitHub Releases integriert. Update-Modal im Stitch Design mit drei Zustaenden (Update gefunden mit Release Notes, Download-Fortschritt, Neustart-Prompt). Automatischer Check beim App-Start (5s Verzoegerung). Manueller Check-Button in den Settings. Build-Pipeline generiert Signing-Artefakte (.sig) und latest.json fuer den Updater-Endpoint.
- **GG-047 Zentrales Prozess-Modul:** `CREATE_NO_WINDOW`-Konstante und -Pattern aus `git.rs`, `deploy.rs`, `crypto.rs` und `terminal.rs` in gemeinsames Modul `process_util.rs` extrahiert. Zwei Hilfsfunktionen (`cmd_no_window` fuer sync, `async_cmd_no_window` fuer async) verhindern, dass das Flag bei neuen `Command::new()`-Aufrufen vergessen wird.

### Fixed
- **GG-062 update_ticket erlaubt Full-Replace aller Felder:** `update_ticket` uebernahm das komplette Ticket-Objekt vom Frontend und ersetzte das bestehende 1:1. Das Frontend konnte systemkontrollierte Felder (id, slug, column, created_at, started_at, done_at, branch, tokens_used, cost_usd u.a.) ueberschreiben. Jetzt werden nur die editierbaren Felder (title, description, prio, ticket_type) aus dem Frontend-Objekt uebernommen; alle Systemfelder bleiben vom bestehenden Ticket erhalten.
- **GG-061 running_ticket wird bei fehlendem Ticket nie geloescht:** Wenn ein Ticket geloescht wird (via `delete_ticket`), bleibt `running_ticket` auf der alten ID stehen. Jeder weitere `start_ticket` schlaegt mit "A ticket is already running" fehl, obwohl kein Ticket mehr laueft. Jetzt wird in `delete_ticket` geprueft ob das geloeschte Ticket == `running_ticket` ist, und wenn ja `running_ticket` auf None gesetzt.
- **GG-060 finish_ticket und merge_ticket pruefen nicht die aktuelle Spalte:** `finish_ticket()` (Zeile 781) prueft nicht ob das Ticket in Progress-Spalte ist. `merge_ticket()` (Zeile 849) prueft nicht ob das Ticket in Review-Spalte ist. Ein Ticket konnte dadurch aus jeder beliebigen Spalte finished/gemergt werden. Jetzt wird vor jeder Operation die korrekte Column geprueft: finish nur aus Progress, merge nur aus Review. Bei falscher Spalte wird ein aussagekraeftiger `InvalidInput`-Fehler zurueckgegeben.
- **GG-057 Branch-Loeschen immer mit Force:** `deleteBranch()` uebergab stets `force: true` an `delete_branch_cmd`, wodurch ungemergte Branches ohne Warnung per `git branch -D` geloescht wurden. Jetzt wird `force: false` verwendet (`git branch -d`). Schlaegt das Loeschen fehl weil der Branch ungemergte Aenderungen enthaelt, erscheint ein zweiter Bestaetigungsdialog mit explizitem Hinweis auf die verlorenen Aenderungen — erst nach dessen Bestaetigung wird mit `force: true` erneut versucht.
- **GG-055 merge_ticket ignoriert save_and_backup Fehler:** `merge_ticket()` verschluckte Save-Fehler mit `let _ = s.save_and_backup()`. Nach erfolgreichem Git-Merge (Branch war bereits gelöscht) konnte die DB nicht gespeichert werden. Bei Neustart gingen Ticket-Änderungen (Status Done, done_at Zeitstempel) verloren. Jetzt wird `s.save_and_backup()?` verwendet (wie in `start_ticket` und `finish_ticket`), um Fehler korrekt zu propagieren.
- **GG-054 Delete-Button im Detail-Panel ohne Bestaetigung:** `deleteDetailTicket()` loeschte Tickets direkt via `invoke("delete_ticket")` ohne Bestaetigungsdialog. Im Kontrast dazu hatte die Kontextmenu-Delete-Action korrekt einen `confirm()`-Dialog. Jetzt wird `deleteDetailTicket()` mit dem gleichen Bestaetigungsdialog versehen wie die Kontextmenu-Aktion.
- **GG-053 Kein atomares Schreiben fuer Config und Projects:** `save_projects` und `save_settings_to_disk` schrieben direkt per `std::fs::write` in die Zieldatei — ein Absturz waehrend des Schreibens hinterliess eine halb geschriebene oder leere Datei. Jetzt wird zuerst in eine `.tmp`-Datei im selben Verzeichnis geschrieben und dann per `std::fs::rename` atomar ersetzt. Bei Fehler beim Umbenennen wird die `.tmp`-Datei aufgeraeumt.
- **GG-052 Backups wurden seit SQLite-Migration nie erstellt:** `save_and_backup` rief `kanban::backup_board` auf, das `std::fs::copy` auf die nicht mehr existierende `kanban.json` versuchte. Jetzt wird `db::backup` genutzt, das die SQLite Online Backup API verwendet und timestampierte `.db`-Backups in `kanban-backups/` ablegt (mit Rotation auf `max_backups`).
- **GG-051 Ticket-in-Projekt-verschieben verlor Ticket:** `move_ticket_to_project` lud das Zielprojekt-Board per `kanban::load_board` aus der nicht mehr existierenden `kanban.json`. Nach der SQLite-Migration wird jetzt die SQLite-DB des Zielprojekts per `db::open` geoeffnet und das Board per `db::load_board`/`db::save_board` gelesen und geschrieben.
- **GG-048 Board: Drag & Drop funktioniert nicht, Start-Button verschwindet:** Fuenf Ursachen behoben: (1) Fehlende `effectAllowed`/`dropEffect`-Properties liessen den Browser Drop-Zonen als ungueltig betrachten. (2) Ghost-Element wurde per `requestAnimationFrame` zu frueh entfernt bevor WebView2 es capturen konnte — jetzt `setTimeout(100ms)`. (3) Tauri v2 File-Drop-Interferenz: `dragDropEnabled: false` in `tauri.conf.json` gesetzt, damit Tauri native Drag-Events nicht abfaengt. (4) `expanded`-Klasse wurde bei `dragstart` sofort entfernt — Start-Button verschwand auch bei fehlgeschlagenem Drag. Jetzt wird der Zustand gespeichert und bei abgebrochenem Drag wiederhergestellt. (5) Click-nach-Drag Race-Condition: `isDragging`-Flag verhindert ungewolltes Toggle der Karten-Expansion nach einem Drag-Vorgang.
- **GG-046 Usage-Anzeige erholt sich nicht von Offline-Zustand:** Drei Ursachen behoben: (1) Frontend-Catch-Block zeigte Offline-Icon auch dann, wenn bereits Daten vorhanden waren — jetzt wird die letzte bekannte Anzeige beibehalten statt auf Offline umzuschalten (nur beim allerersten Fehler ohne Vordaten wird das Offline-Icon gezeigt). (2) `reqwest::Client` hatte keinen Timeout — haengende API-Aufrufe konnten spaeter eintreffend das Online-Display wieder ueberschreiben; jetzt 10-Sekunden-Timeout. (3) Datei-Cache-Altersgrenze von 120s auf 300s erhoeht, damit kurze Update-Pausen des Statusline-Scripts toleriert werden. Ausserdem: Clock-Skew-Robustheit in `read_file_cache` (falls `elapsed()` fehlschlaegt, wird die Datei als frisch behandelt).
- **GG-045 Konsolenfenster bei Kindprozessen:** `CREATE_NO_WINDOW`-Flag fuer `reg.exe` (crypto.rs) und `where.exe` (terminal.rs) gesetzt, damit keine sichtbaren Konsolenfenster aufblitzen. Machine-ID wird per `OnceLock` gecacht, sodass `reg.exe` nur noch einmal pro App-Laufzeit gestartet wird statt bei jedem encrypt/decrypt.

## [0.2.9-alpha] - 2026-03-23

### Added
- **Notizen-View:** Neuer Sidebar-View zeigt alle Notizen pro Projekt (auch archivierte). Ticket-ID + Titel als klickbarer Header, Badges, Suchfeld. "Kommentare" und "Notizen" vereinheitlicht.
- **Projekt-Logo/Avatar:** Upload pro Projekt, Rechtsklick-Menue fuer Projekt-Einstellungen, Fallback auf Initialen
- **GitHub Build-Status projektspezifisch:** GitHub-Settings (Owner/Repo/Token) pro Projekt statt global

### Fixed
- **GG-034 Branches aufraeumen:** Dialog wartete nicht auf Bestaetigung, Branches wurden sofort geloescht
- **GG-035 Modell/Tokens/Kosten:** Felder werden jetzt korrekt im Ticket-Detail angezeigt
- **GG-036 Leere Felder:** Werden ausgeblendet wenn keine Werte vorhanden
- **GG-037 Bug-Sync Felder:** Portal-Bug/URL nur sichtbar wenn Bug-Sync aktiviert
- **GG-038 Ticket-Verschiebung:** Rechtsklick, Drag&Drop und Start-Button funktionieren wieder
- **GG-039 Usage-Anzeige:** Kein Offline mehr bei 429 Rate-Limit, zentraler Polling-Timer, Datei-Cache
- **GG-044 Notizen-View Scrollbar:** Unsichtbar per scrollbar-width: none auf #view-notes

## [0.2.8-alpha] - 2026-03-23

### Fixed
- **Notizen-View unübersichtlich + Eingabefeld zu klein:** Notizen-View überarbeitet: Ticket-ID und Titel als klickbarer Header mit Badges (statt aufklappbarem `<details>`), lange Notizen werden nach 200 Zeichen abgeschnitten mit "Mehr anzeigen/Weniger anzeigen"-Toggle, bessere visuelle Trennung durch Karten-Layout mit Header/Body/Footer. Notiz-Eingabefeld im Ticket-Detail von 2 auf 4 Zeilen vergrößert mit min-height 80px, Button von `btn-secondary` auf `btn-primary` geändert.
- **GitHub Build-Status war global statt projektspezifisch:** Beim Projektwechsel zeigte das Dashboard weiterhin den Build-Status des vorherigen Repos. GitHub-Settings (Owner/Repo/Token/Enabled/Poll-Intervall) werden jetzt pro Projekt in `projects.json` gespeichert statt in den globalen Settings. Beim Projektwechsel werden die projektspezifischen GitHub-Settings geladen. Bestehende globale GitHub-Konfiguration wird beim ersten Start automatisch ins Default-Projekt migriert. Tokens werden pro Projekt verschlüsselt gespeichert.
- **Focus-Mode: Usage-Anzeige zeigte Offline trotz vorhandener Daten:** Mehrere unabhängige API-Aufrufe (Header alle 120s, Focus-Mode alle 60s) überschritten zusammen mit dem externen Statusline-Script das Anthropic Rate-Limit (429). Fix: Backend liest zuerst den Datei-Cache des Statusline-Scripts (`%TEMP%/claude/statusline-usage-cache.json`), bei 429-Response 5-Minuten-Backoff mit Rückgabe des letzten bekannten Werts. Frontend: Ein zentraler Polling-Timer (60s) statt separater Timer — Focus-Mode liest nur den gecachten Wert.
- **Board: Ticket-Verschiebung kaputt (Rechtsklick, Drag&Drop):** `move_ticket` erlaubte keine Transitions von der Progress-Spalte — Rechtsklick "Verschieben" gab einen Error, Drag&Drop schlug fehl. Transition-Whitelist durch offene Regel ersetzt: alle Verschiebungen zwischen Board-Spalten sind erlaubt, nur Archived bleibt geschützt. Kontextmenü blendet die aktuelle Spalte im Move-Submenu jetzt aus.
- **Ticket-Detail: Leere Felder (Modell/Tokens/Kosten/Portal-Bug/Portal-URL) wurden immer angezeigt:** Die CSS-Regel `.panel-cost-info.hidden { display: none; }` fehlte — das Hinzufügen der `hidden`-Klasse per JS hatte daher keinen visuellen Effekt, weil `.panel-cost-info` mit `display: flex` stärker griff. Leere Felder werden jetzt korrekt ausgeblendet.
- **Ticket-Detail: Modell/Tokens/Kosten wurden nicht angezeigt:** `finish_ticket` akzeptierte keine `tokens_used`/`cost_usd`-Parameter — die Felder blieben immer leer. Review-Modal erhält jetzt optionale Eingabefelder für Tokens und Kosten (USD), die beim Abschließen in der DB gespeichert werden. Außerdem wurde `model_used` (wird beim Start eines Tickets gesetzt) nie im Detail-Panel angezeigt, weil die Sichtbarkeitsbedingung nur auf `tokens_used || cost_usd` prüfte — jetzt genügt auch ein gesetztes `model_used`.
- **Branches aufräumen: Sofortiges Löschen ohne Bestätigung abzuwarten:** `window.confirm()` in Tauri/WebView2 blockiert die JavaScript-Ausführung nicht zuverlässig — der Dialog erschien, aber die Branches wurden sofort gelöscht. Ersetzt durch einen eigenen asynchronen Bestätigungs-Modal. Betrifft auch "Branch mergen" und "Branch löschen" (selbes Problem).

### Added
- **Projekt-Logo/Avatar mit Rechtsklick-Menü:** Oben rechts wird ein Projekt-Avatar angezeigt (Initialen oder hochgeladenes Logo). Klick/Rechtsklick öffnet ein Kontextmenü mit Logo-Upload, Logo entfernen und Projekt-Einstellungen. Logos werden als PNG im Projekt-Data-Dir gespeichert (max. 2 MB). Avatar wird automatisch beim Projektwechsel aktualisiert. Neue Backend-Commands: `set_project_logo`, `get_project_logo`, `remove_project_logo`.
- **Notizen-View (Vereinheitlichung + Sidebar):** "Kommentare" und "Notizen" zu einem einheitlichen System "Notizen" zusammengelegt. Neuer Sidebar-View zeigt alle Notizen des Projekts sortiert nach Datum (neueste oben) mit Suchfeld. Jede Notiz als Karte mit Text und Datum, darunter aufklappbar das zugehörige Ticket (ID, Titel, Typ-Badge, Status). Klick auf Ticket öffnet das Detail-Panel. Archivierte Tickets werden einbezogen.
- **Bug-Sync: Portal-Felder abschaltbar:** Portal-Bug und Portal-URL im Ticket-Detail-Panel und Portal-Bug-Badge auf Karten werden nur noch angezeigt, wenn Bug-Sync in den Settings aktiviert ist (`bug_sync.enabled`). Bei deaktiviertem Bug-Sync werden diese Felder komplett ausgeblendet.
- **Terminal-Seite (Vollbild Multi-Tab):** Neuer Sidebar-Eintrag "Terminal" öffnet eine eigene Vollbild-Ansicht mit Multi-Tab-Support für mehrere unabhängige Terminal-Sessions. Das eingeklappte Terminal-Panel wird auf der Terminal-Seite automatisch ausgeblendet und bei Wechsel zu anderen Views wieder eingeblendet. Alle drei Terminal-Bereiche (Ticket-Terminal, Panel, Terminal-Seite) sind komplett unabhängig voneinander. Sessions laufen im Hintergrund weiter beim View-Wechsel.
- **Filter-Persistenz:** Filter-State (Suchtext, Typ-Filter, Prioritäts-Filter) wird in localStorage gespeichert und beim nächsten Start automatisch wiederhergestellt. Filter-Leiste öffnet sich automatisch wenn gespeicherte Filter aktiv sind. "Filter löschen" entfernt auch den gespeicherten State.
- **Undo/Redo für Ticket-Aktionen:** Ctrl+Z/Ctrl+Y machen Ticket-Aktionen (Erstellen, Löschen, Verschieben, Bearbeiten, Archivieren) rückgängig bzw. stellen sie wieder her. Undo/Redo-Buttons in der Board-Toolbar mit Tooltip-Beschreibung der nächsten Aktion. Undo-Stack speichert bis zu 50 Aktionen, wird bei Projektwechsel zurückgesetzt.
- **GitHub Actions Build-Status:** Neue KPI-Karte im Dashboard zeigt den Live-Status des letzten GitHub Actions Workflow-Runs (success/failure/pending) mit farbigem Badge, Commit-Hash und Laufzeit. Polling-Intervall konfigurierbar (Standard: 60s). GitHub Token (PAT) wird verschluesselt in den Settings gespeichert. Neuer Settings-Tab "GitHub" fuer Owner, Repo, Token und Poll-Intervall.
- **Merged Branches aufraeumen:** Neuer "Alle aufräumen"-Button in der Git-Ansicht bei den erledigten Branches. Löscht alle lokalen Branches die bereits im Default-Branch enthalten sind (mit Bestätigungsdialog). Aktueller und Default-Branch werden nie gelöscht.

## [0.2.7] - 2026-03-22

### Fixed
- **Ticket-Karten Layout:** Typ-Badge (Feature/Bugfix/Docs/Security) fehlte komplett — wird jetzt links neben dem Prio-Badge in der Kopfzeile angezeigt. Beschreibung war im ausklappbaren Bereich versteckt — sie ist jetzt immer sichtbar (max. 2 Zeilen, Ellipsis). Meta-Zeile (Branch, Kommentare, Kosten, Portal-Bug) ist jetzt immer sichtbar wenn vorhanden, statt doppelt im Expand-Bereich. Doppelte Darstellung von Kommentaren und Kosten entfernt.

## [0.2.7] - 2026-03-22

### Added
- **Ticket-Sortierung:** Neues Setting `ticket_sort_mode` (Standard: Priorität). Zwei Modi: "Nach Priorität (High → Medium → Low, dann nach ID)" und "Nach ID aufsteigend". Einstellbar in den Settings unter "Ticket-Sortierung".
- **Fortschrittsbalken pro Ticket:** Dünne Akzentfarb-Linie am unteren Rand jeder Ticket-Karte zeigt den Workflow-Fortschritt (Backlog=0%, Progress=33%, Review=66%, Done=100%). Done-Spalte nutzt `--success`-Farbe.

### Fixed
- **WIP-Limit-Balken entfernt:** Die Fortschrittsbalken unter den Spaltentiteln "In Arbeit" und "Review" wurden entfernt — bringen keinen Mehrwert für Solo-Entwickler.
- **Git View: Default-Branch in "Erledigte Branches":** Der Default-Branch (z.B. `master`) wurde inkonsistent in der "Erledigte Branches"-Sektion angezeigt, weil `git branch --merged master` den Default-Branch selbst mit zurückgibt. Der Default-Branch wird jetzt aus dem Merged-Set gefiltert.
- **Usage-Anzeige: Offline-Symbol bei API-Fehler:** Wenn die Anthropic API nicht erreichbar ist oder der OAuth-Token abgelaufen ist, zeigen die Usage-Balken (Header und Focus-Modus) jetzt ein `cloud_off`-Symbol statt leere Balken.

## [0.2.6] - 2026-03-22

### Changed
- **Dead Code Cleanup:** Ungenutzte Re-Exports `renderBoard` und `updateSidebar`/`loadClaudeUsage` aus `app.js` entfernt (wurden nie von anderen Modulen ueber `app.js` importiert); 3 veraltete CSS-Kommentare (`removed — replaced by Stitch`) aus `style.css` geloescht
- **Commands optimiert:** `cargo test` als Pflichtschritt in /bugfix, /new-feature, /security-audit, /kanban. code-reviewer und security-reviewer Agents werden gezielt aufgerufen. App-Name auf Glitch Goblin korrigiert.
- **Agents verschlankt:** 5 ueberflüssige Agents geloescht (rust-backend, frontend-ui, terminal-pty, security-fixer, doc-updater). code-reviewer und security-reviewer auf ~15 Zeilen reduziert.
- **Release-Workflow:** Linux AppImage und Windows NSIS-Installer werden jetzt als Release-Artefakte hochgeladen
- **Kein Konsolenfenster:** Release-Build oeffnet kein separates Konsolenfenster mehr auf Windows (`windows_subsystem = "windows"`)

### Added
- **1M-Context Modelle:** Modellauswahl um `claude-sonnet-4-6[1m]` (Sonnet 4.6 1M) und `claude-opus-4-6[1m]` (Opus 4.6 1M) erweitert — im Confirm-Dialog, in den Settings und bei Kosten-Presets
- **Konfigurierbares Ticket-Prefix pro Projekt:** Jedes Projekt hat ein eigenes Ticket-Prefix (z.B. "GG", "VTC", "DCT") statt hartkodiertem "GG-". Das Prefix wird in der Projektkonfiguration gespeichert und im Projekt-Picker editiert. Commit-Prefix und Branch-Prefix werden automatisch abgeleitet (z.B. Prefix "VTC" → Ticket "VTC-001", Branch "vtc/VTC-001-slug", Commit "vtc:VTC-001: Titel"). Das separate Commit-Prefix-Feld wurde aus den Settings entfernt.
- **Ticket-Archivierung:** Erledigte Tickets koennen einzeln (Kontextmenue/Archiv-Button) oder gesammelt (Button im Done-Header) archiviert werden. Archivierte Tickets verschwinden vom Board und sind ueber den neuen Archiv-View (Sidebar) mit Suche und Wiederherstellen-Funktion zugaenglich. Schema-Migration v1→v2 fuegt `archived_at`-Spalte hinzu.
- **Board-Spalten scrollbar:** Spalten scrollen jetzt per Mausrad/Trackpad wenn sie mehr Karten enthalten als der sichtbare Bereich fasst. Scrollbar ist unsichtbar (scrollbar-width: none).
- **Focus Mode Claude-Kontingent:** 5h- und 7d-Auslastung als Mini-Balken mit Prozentwert im Focus-Sidebar (unter Branch/Modell/Laufzeit). Nutzt den bestehenden `get_claude_usage`-Command, aktualisiert automatisch alle 60 Sekunden.
- **Statusleiste Git-Info:** `updateStatusBar()` zeigt jetzt Branch-Name, Dirty-Indikator (●) und Ahead/Behind-Zaehler (↑/↓) aus dem `get_git_status`-Command. Neues `ahead_behind()`-Backend in `git.rs` via `git rev-list --left-right --count @{u}...HEAD`. Automatisches Refresh alle 30 Sekunden.
- **Frontend Modul-Split:** `app.js` (1.394 Zeilen) in 5 Module aufgeteilt — `notifications.js` (Toasts, Sounds, Notification-Center), `projects.js` (Projektverwaltung, Sidebar, Usage), `focus-mode.js` (Focus-Modus Logik), `recovery.js` (Crash-Recovery Dialog), `search.js` (Spotlight/Global Search). `app.js` enthaelt nur noch Init, State, Event-Binding und Execution-Logik
- **Integration Tests Ticket-Lifecycle:** 6 neue End-to-End Tests fuer den kritischen Ticket-Workflow — vollstaendiger Flow (start → commit → finish → merge → Done), Merge mit Auto-Push via Remote, Finish ohne Aenderungen, Start ohne Git-Repo, sowie DB-Lifecycle-Roundtrip (Backlog → Done mit allen Timestamps/Feldern)

### Security
- **DB-Backup vor Schema-Migration:** `db::open()` erstellt automatisch ein Backup (`kanban.db.pre-migration`) via SQLite Online Backup API bevor Schema-Upgrades ausgefuehrt werden. Bei fehlgeschlagener Migration wird das Backup automatisch wiederhergestellt (inkl. WAL/SHM Cleanup)
- **Branch-Name Laengenlimit:** `validate_git_ref()` begrenzt Branch-Namen auf maximal 100 Zeichen — verhindert DoS durch extrem lange Referenz-Namen
- **Deploy-Parameter Haertung:** `validateDeployParam()` blockiert zusaetzliche gefaehrliche Zeichen (`< > ( ) { } ! ~ # % ^ * ? [ ]`) und erzwingt ein Laengenlimit von 500 Zeichen
- **CSP Audit:** `unsafe-inline` fuer `style-src` geprueft — wird benoetigt (30+ inline Styles), akzeptiertes Risiko dokumentiert

### Docs
- **JSDoc Frontend:** Alle exportierten Funktionen in `app.js` (15 Exporte), `board.js` (11), `git.js` (3), `dashboard.js` (4) und `settings.js` (5) mit JSDoc-Kommentaren versehen
- **Rust-Dokumentation:** Alle `#[tauri::command]`-Funktionen in `src/commands.rs` (73 Commands) und alle öffentlichen Funktionen in `src/git.rs` mit `///`-Kommentaren versehen

### Fixed
- **GG-022 UTF-8 Sanitization beim Board-Laden:** Ungueltige UTF-8-Bytes in der SQLite-DB (z.B. durch externe Tools mit CP1252-Encoding geschrieben) fuehren nicht mehr zu einem `load_board`-Crash. Alle String-Felder in `tickets`, `ticket_comments` und `board_meta` werden beim Lesen via `String::from_utf8_lossy` bereinigt — ungueltige Bytes werden durch U+FFFD ersetzt statt einen Fehler auszuloesen.
- **GG-019 Focus Mode Layout:** "Ticket abschließen"-Button und Terminal rechts wurden bei zu viel Inhalt oder kleinem Viewport abgeschnitten. Sidebar-Inhalt in `.focus-sidebar-scroll` (scroll-inner) ausgelagert, damit `.focus-actions` immer am unteren Rand sichtbar bleibt. `.focus-terminal` mit `overflow: hidden` gesichert, damit xterm-Canvas nicht aus dem Bereich ragt.
- **GG-018 kanban.json-Fallback entfernt:** SQLite ist jetzt die einzige Datenquelle. Der stille JSON-Fallback in `switch_project()` und beim App-Start wurde entfernt — laesst sich die DB nicht oeffnen oder das Board nicht laden, wird jetzt eine klare Fehlermeldung ausgegeben statt veraltete Daten aus `kanban.json` zu lesen. JSON-Sync-Code aus `save_and_backup()` entfernt. `watch_kanban()` (JSON-Datei-Watcher) entfernt. board-changed-Events in `start_ticket`, `finish_ticket` und `merge_ticket` lesen nicht mehr redundant aus der DB, sondern nutzen den aktuellen In-Memory-State.
- **Frontend Fehler-Logging:** Alle `console.error`/`console.warn` Aufrufe in `app.js`, `dashboard.js`, `deploy.js` und `terminal.js` durch `logError()` aus `utils.js` ersetzt — Fehler landen jetzt sichtbar im Log-Panel der App statt nur in der DevConsole
- **Stille Fehler beseitigt:** `invoke("get_running_ticket").catch(() => {})` gibt Fehler jetzt weiter; `invoke("save_settings").catch(console.error)` durch typisiertes `logError()` ersetzt

## v0.2.0 — Stitch Design System (2026-03-21)

### Design-System: "Goblin Gloss" (Stitch)

Komplettes visuelles Redesign aller Views basierend auf dem Stitch Design System "Goblin Gloss".
Dual-Typeface-System (Space Grotesk + Inter + JetBrains Mono), No-Line Rule, Ambient Shadows,
Glassmorphism, Tonal Layering. Material Symbols Outlined als selbst gehostete Icon-Font.

### Added
- **Material Symbols Icons:** Selbst gehostete WOFF2-Font (`material-symbols-outlined.woff2`) fuer alle UI-Icons — Dashboard, Sidebar, Status-Bar, Git, Activity, Settings
- **Eigene Titelleiste:** Windows-Titelleiste deaktiviert (`decorations: false`), eigene Window-Controls (Minimize/Maximize/Close) im App-Header mit `data-tauri-drag-region`
- **Spotlight-Suche (Ctrl+K):** Command-Palette-Style Suche als zentriertes Overlay mit Blur-Backdrop, ersetzt die alte inline Suchleiste im Header
- **Usage-Widget im Header:** Claude-Kontingent (5h/7d) als kompakte Balken neben den Header-Icons
- **Stitch KPI-Cards (Statistiken):** BUILD STATUS (orange), COVERAGE (teal), UPTIME mit Mini-Balken, EFFICIENCY SCORE als Prozent
- **Velocity KW-Labels:** Woechentliche Velocity mit ISO-Kalenderwochen (KW 10, KW 11...) statt Datumsformat
- **Pie-Chart Center-Text:** Donut-Chart zeigt Anzahl Kategorien in der Mitte
- **Activity Spotlight-Style:** Grosse 40px Circle-Icons mit Material Symbols, Source-Links (Terminal, Git, Kanban Board), Ticket-Badges, Uhrzeit statt relative Zeit
- **Agent/Command Card-Grid:** Von 2-Pane-Editor zu Card-Grid mit Content-Preview. Editor oeffnet als Modal-Overlay
- **Git Commit-Tabelle:** Tabellarische Commit-Anzeige mit HASH/MESSAGE/TIME Spalten, Hash als oranges Badge
- **Git Merged-Branches Grid:** 2-Spalten-Grid mit Merge-Icons und teal Akzent-Linie

### Changed
- **App-Header:** "Glitch Goblin" in Orange (Space Grotesk), Deploy-Buttons mit Material Icons, Notification/Settings/Theme als runde Icon-Buttons, Avatar mit Primary-Fixed Border
- **Sidebar:** Projekt-Name in Orange (Space Grotesk), alle Nav-Items mit Material Symbols Icons, "PROJECT"-Label entfernt, Nav-Badges versteckt, `unfold_more` Pfeil am Projekt-Selector
- **Dashboard:** README-Card mit orangem Akzent-Balken + description/edit Icons. Commits als Timeline mit vertikaler Linie. Activity-Sektion mit farbigen Circle-Icons in linker Spalte. KPI-Cards mit farbigen Hintergruenden (Primary/Tertiary)
- **Kanban Board:** Spalten ohne Hintergrund-Box (transparent), farbige Dots + Uppercase-Titel (Space Grotesk), Cards mit ID+Prio oben und Titel darunter, keine Profil-Avatare, Progress inline als Prozent+Bar
- **Statistiken:** "Statistiken Dashboard" mit Analytics-Icon, KPI-Cards links-ausgerichtet mit farbigen Badges, Velocity-Chart breiter (5fr:3fr), Recent Completed mit check_circle Material Icons
- **Git-View:** Branch-Badge in Teal oben, "Git Repository" H1 mit Project-ID, Commits als Tabelle, Merged-Branches als offenes 2-Spalten-Grid mit Merge-Icons
- **Activity:** Pill-foermige Filter-Tabs, "THIS WEEK" Heading, Group-Labels als Badges, Items ohne Card-Background auf Timeline
- **Einstellungen:** Bento-Grid-Layout mit Cards (Basis Konfiguration, Git Integration, Claude-Modell & Kosten, Auto-Execute, Benachrichtigungen), Deploy-Tab als 2-Spalten Docker+SSH
- **Theme-Toggle:** Von Sidebar-Footer in den Header verschoben als `dark_mode`/`light_mode` Material Icon
- **Buttons:** Primary-Buttons mit Gradient (accent → primary-container), Secondary als Ghost-Style, Active-States mit scale() Transforms
- **Cards/Panels:** 16px Border-Radius, Ghost-Borders, Ambient Shadows, Glassmorphism fuer Overlays
- **Inputs:** Minimalistisch mit nur Bottom-Border (2px), Focus-State mit Accent-Glow
- **Status-Bar:** Material Icons (code, sync, cloud_done, label), Hover-Effekt auf Items
- **Toasts:** Links-Akzent statt Umrandung, Blur-Backdrop

### Fixed
- **Dashboard leer:** `dash-tech-badges` und `dash-stats-body` Elemente fehlten nach Redesign — Null-Checks hinzugefuegt, damit README/Commits/Activity trotzdem laden
- **Akzentfarbe unwirksam:** `applyAccentColor()` setzte `--user-accent` (existierte nicht in CSS) statt `--accent` auf `document.body` — jetzt werden `--accent`, `--accent-hover`, `--accent-glow`, `--primary-container` direkt auf body gesetzt
- **Model-Preset matcht nie:** `setupModelPresetListener()` nutzte kurze Keys (`sonnet`/`opus`) statt volle Model-IDs (`claude-sonnet-4-6`) — Kosten werden jetzt korrekt vorausgefuellt
- **Commit-Daten falsch:** `get_commit_log()` und `check_uncommitted()` in `src/git.rs` nutzten Pfad ohne `strip_unc_prefix()` — Windows UNC-Prefix (`\\?\`) fuehrte zu falschen Git-Ergebnissen
- **Notification-Panel schliesst nicht:** X-Button loeschte nur Nachrichten, schloss aber das Panel nicht
- **Window-Controls ohne Permissions:** Fehlende Tauri-Capabilities (`core:window:allow-minimize/maximize/close`) in `capabilities/default.json` hinzugefuegt
- **Pfad-Anzeige:** `\\?\` Windows UNC-Prefix aus der Sidebar-Pfadanzeige entfernt

### Removed
- **Sidebar "Documentation" und "Support" Links** — waren Platzhalter, verdeckten den Theme-Toggle
- **Inline-Suchleiste im Header** — ersetzt durch Spotlight-Overlay (Ctrl+K)
- **"New Task" Text-Button im Header** — redundant mit "+ Ticket" in der Sidebar
- **Health-Bar im Board-Header** — vereinfacht zu Filter/Search Icons
- **2-Pane Editor-Layout (Agents/Commands)** — ersetzt durch Card-Grid + Modal-Overlay

## v0.1.0 — Glitch Goblin (2026-03-20)

### Rename
- App umbenannt von "Aufgabenhelfer" zu "Glitch Goblin"
- Ticket-ID-Prefix geändert von KANBAN- zu GG-
- Config-Verzeichnis migriert von kanban-runner/ zu glitch-goblin/
- Branch-Prefix geändert von kanban/ zu gg/

## [0.0.2] - 2026-03-19

### Added
- **Code-Modularisierung:** `app.js` (3021 Zeilen) in 13 ES-Module aufgeteilt (board, detail, git, terminal, settings, statistics, dashboard, activity, editors, deploy, bugsync, utils, error-handler)
- **Git-View Redesign:** Card-basierte Branch-Ansicht mit Gruppierung (In Arbeit / Weitere / Erledigte), Lazy-Loading Details, letzte Commits direkt auf der master-Card sichtbar
- **BranchInfo erweitert:** `is_merged`, `files_changed`, `ahead_count`, `ticket_id` Felder im Backend
- **Review-Modal:** "Abschließen" zeigt Diff aller Änderungen vor dem Commit. "Änderungen anzeigen" Button in der Review-Spalte zeigt Branch-Diff
- **Fokus-Modus:** Vollbild-Arbeitsplatz bei laufendem Ticket — großer Terminal + Ticket-Sidebar (Titel, Branch, Modell, Timer, Schnell-Notizen). Automatisches Exit wenn Ticket fertig
- **Dashboard-Actions:** "Weitermachen" (Running/letztes Ticket), "Nächste Aufgabe" (High-Prio), "Review-Erinnerung" als Action-Cards
- **Dashboard-Redesign:** Kompaktes 2-Spalten-Layout, Tech Stack + Stats kombiniert, README begrenzt
- **Usage-Anzeige:** Claude 5h/7d-Kontingent als farbcodierte Balken im Sidebar (Anthropic OAuth API, 60s Cache, Auto-Refresh)
- **Modell-Empfehlung:** Automatische Vorauswahl im Execute-Dialog (Opus für Security/Feature, Sonnet für Bugfix/Docs)
- **Toast-System:** Slide-in-Benachrichtigungen (success/error/info) mit Auto-Dismiss
- **Notification-Center:** Glocken-Dropdown sammelt alle Benachrichtigungen mit Zeitstempel
- **Loading-Skeletons:** Animierte Platzhalter für Git-View und Activity statt "Loading..." Text
- **Modal-Animationen:** Fade-in + Scale-in für Modals, View-Fade bei Navigation, smootheres Slide-Panel
- **Kompakte Karten:** Titel + Prio immer sichtbar, Details (Beschreibung, Datum, Aktionen) gleiten bei Hover ein
- **WIP-Limits:** Progress (max 3), Review (max 5) mit visueller Warnung und Fortschrittsbalken
- **Empty States:** Spalten-spezifische Hinweistexte wenn keine Tickets vorhanden
- **Spalten-Statistiken:** Durchschnittliches Alter (Progress), ältestes Ticket (Review), Abschlussrate (Done)
- **Verbessertes Drag & Drop:** Ghost-Preview, Drop-Indikator-Linie
- **Ticket-Schnellaktionen:** Priorität und Typ direkt auf der Karte per Dropdown ändern
- **Globale Suche:** Header-Suche durchsucht Tickets (ID, Titel, Beschreibung) und Settings-Keywords
- **Velocity-Chart:** Wöchentliche Ticket-Abschlussrate als Balkendiagramm (letzte 8 Wochen)
- **Tastatur-Navigation:** Pfeiltasten für Board-Navigation, Enter öffnet Detail-Panel
- **Responsive Board:** 2 Spalten unter 1024px, 1 Spalte unter 600px
- **Settings-Tabs:** Allgemein | Terminal | Deploy | Bug-Sync statt endlosem Scroll
- **Plus-Button:** [+] im Backlog-Header zum schnellen Erstellen neuer Tickets
- **Terminal-Fortschritt:** Pulsierende Status-Bar mit Ticket-ID und Elapsed-Timer
- **Schnell-Notizen:** Textfeld im Fokus-Modus, speichert als Kommentar am Ticket
- **`withGuard` Utility:** Verhindert Doppelklick bei async Aktionen (executeTicket, mergeTicket)
- **`get_working_diff` / `get_working_file_diff` Commands:** Working-Tree Diffs für Review-Modal
- **`get_claude_usage` Command:** OAuth API Abfrage mit 60s Caching

### Changed
- **Farbsystem:** Hartkodierte Badge- und Diff-Farben in CSS-Variablen umgewandelt (vollständige Dark/Light-Theme-Konsistenz)
- **Deutsche Bezeichnungen:** "Merge" → "Übernehmen", "Merged Branches" → "Erledigte Branches (bereits in master eingebaut)", "clean" → "alles committed"
- **Projektwechsel:** Aktualisiert jetzt automatisch die aktive View (Dashboard, Git, Activity, etc.)
- **Drag & Drop:** Auf Event-Delegation umgestellt (Listener einmal registriert statt pro renderBoard)
- **renderBoard():** Debounced via requestAnimationFrame gegen DOM-Thrashing
- **Formularelemente:** Globaler CSS-Reset für input/select/textarea mit Theme-Variablen (Fix für weiße Dropdowns im Dark Mode)

### Fixed
- **Running-Ticket hängt:** Backend-State wird bei Fehler synchronisiert, Terminal-Fehler fängt ab ohne Lock-State zu verlieren
- **Finish ignoriert Commit-Fehler:** `auto_commit()` Fehlschlag wird jetzt propagiert — Ticket bleibt in Progress
- **Event-Listener Leak:** setupDragDrop() registrierte bei jedem renderBoard() neue Listener
- **Terminal-Interval:** checkInterval und fallbackTimeout werden bei cleanupTerminal() gestoppt
- **Projekt-Pfad:** switch_project() prüft ob Pfad noch existiert
- **Git-Verfügbarkeit:** start_ticket() prüft ob git installiert ist
- **DB-Fehler:** `.ok()` auf DB-Queries ersetzt durch Error-Logging
- **Duplicate ID:** `branch-count` existierte zweimal (Sidebar + View-Header)

## [Unreleased]

### Added
- **SQLite-Persistenz (`src/db.rs`):** Alle Projektdaten (Board, Aktivitätslog, Deploy-Konfiguration, Templates) werden in einer SQLite-Datenbank gespeichert statt in fragilen JSON-Dateien
  - Datei: `~/.config/kanban-runner/projects/<name>/kanban.db`
  - WAL-Modus für bessere Nebenläufigkeit und schnellere Writes
  - Vollständige atomare Transaktionen – kein Datenverlust mehr bei Absturz mid-Write
  - Einmalige automatische Migration: bestehende JSON-Dateien werden importiert und zu `*.migrated` umbenannt
  - `rusqlite 0.32` mit `bundled`-Feature (statisches SQLite, kein System-Package nötig)
- **Strukturierte Error-Typen (`src/error.rs`):** `AppError`-Enum mit 22 Varianten und deutschsprachigen Fehlermeldungen
  - Alle Commands bleiben `Result<T, String>` (kein Breaking Change)
  - `From<AppError> for String` erlaubt `?`-Operator ohne Typ-Konvertierung
  - Fehler enthalten jetzt Kontext (Dateiname, Ticket-ID, Branch-Name)
- **API-Token-Verschlüsselung (`src/crypto.rs`):** Bug-Sync API-Token wird verschlüsselt gespeichert
  - ChaCha20-Poly1305 Algorithmus
  - Schlüssel aus `/etc/machine-id` + Salt via SHA-256 abgeleitet (maschinengebunden)
  - Format: `v1:<nonce_hex>: <cipher_hex>` — rückwärtskompatibel zu Plaintext-Tokens
  - Bestehende Plaintext-Tokens werden beim nächsten Save automatisch migriert
- **Terminal-Cleanup beim App-Exit (`src/state.rs`, `src/main.rs`):**
  - `AppState::cleanup_terminals()` sendet `Close`-Signal an alle laufenden PTY-Sessions
  - `Drop`-Implementierung auf `AppState` als sicherer Fallback
  - `on_window_event(Destroyed)` am Hauptfenster als primärer Cleanup-Pfad
  - Verhindert Zombie-Shell-Prozesse nach App-Exit

### Changed
- **[MITTEL]** [UI] Git-Historie: Commit-Darstellung verbessert — Merge-Commits werden mit Badge gekennzeichnet, Author-Info wird angezeigt, deutsche relative Zeitangaben ("vor 2 Std.", "vor 3 Tagen") statt englischer Defaults (`app.js`, KANBAN-015)

### Fixed
- **[MITTEL]** [UI] Git-Historie zeigte "NaNd ago" statt lesbarer Zeitangaben — Ursache: `git log --format=%ci` lieferte Datumsformat, das von JavaScript `new Date()` nicht zuverlässig geparst wurde. Fix: Umstellung auf ISO 8601 strict (`%cI`), das von allen JS-Engines korrekt geparst wird (`app.js`, KANBAN-015)
- **[MITTEL]** [UI] Merge-Commits zeigten "No changes" in der Datei-Ansicht — `git show` ohne Merge-spezifische Flags liefert bei Merge-Commits keinen Diff. Fix: `-m --first-parent` Flags hinzugefügt, sodass der Diff gegen den ersten Parent angezeigt wird (`app.js`, KANBAN-015)
- **[MITTEL]** [UI] Terminal wechselte in Schwarz-Weiß wenn Claude Code startete — KANBAN-014 hatte `getTerminalTheme()` entfernt, um ANSI-Farbüberschreibung zu verhindern, dadurch fehlte xterm.js aber jegliche Theme-Konfiguration. Fix: Neue Funktion `getTerminalTheme()` setzt nur `background`, `foreground` und `cursor` aus CSS-Variablen (`--terminal-bg`, `--terminal-fg`, `--terminal-cursor`), ohne die ANSI-Farbpalette zu definieren — xterm.js behält seine eingebauten ANSI-Farben. Neue Funktion `applyTerminalThemes()` aktualisiert alle aktiven Terminal-Instanzen beim Theme-Wechsel (`app.js`, KANBAN-016)
- **[MITTEL]** [UI] Terminal startet korrekt, wechselt aber in Schwarz-Weiß: Hardcodierte xterm.js-Theme-Optionen (`background`, `foreground`, `cursor`) aus allen drei `new Terminal()`-Aufrufen in `openTicketTerminal()`, `openBoardTerminal()` und `openDeployTerminal()` entfernt. xterm.js nutzt jetzt seine eingebaute ANSI-Farbpalette, sodass Programmfarben (ANSI Escape Codes) nicht mehr überschrieben werden. Nicht mehr benötigte Funktionen `getTerminalTheme()` und `applyTerminalTheme()` sowie deren Aufrufstellen entfernt. Tote CSS-Variablen `--terminal-fg` und `--terminal-cursor` aus `style.css` entfernt (`app.js`, `style.css`, KANBAN-014)
- **[MITTEL]** [UI] Terminal-Theme: xterm.js verwendete hardcodierte Dunkel-Farben und blieb im Light Mode schwarz. Terminal-Theme-Farben werden jetzt dynamisch aus CSS-Variablen (`--terminal-bg`, `--terminal-fg`, `--terminal-cursor`) gelesen; alle aktiven Terminal-Instanzen werden beim Theme-Wechsel live aktualisiert (`app.js`, KANBAN-013)
- **[HOCH]** `restore_backup` schrieb das wiederhergestellte Board nur in JSON, nicht in SQLite — bei aktiver DB-Verbindung hatte die Wiederherstellung daher keinen Effekt. Fix: `kanban::save_board()` durch `s.save_and_backup()` ersetzt, das je nach Runtime-Kontext SQLite und/oder JSON beschreibt (`src/commands.rs`, KANBAN-010)
- **[MITTEL]** Frontend: `loadInitialState()` catch verwendete `console.error` statt `appendLog` — Initialisierungsfehler waren für den User unsichtbar (`app.js`)
- **[MITTEL]** Frontend: `spawn_terminal` hatte kein `try/catch` — Fehler beim Terminal-Start brach die Funktion still ab ohne User-Feedback (`app.js`)
- **[MITTEL]** Frontend: `loadDeployConfig()` catch verwendete `console.error` statt `appendLog` (`app.js`)
- **[MITTEL]** `activity::log_activity` Aufrufe zentralisiert in `AppState::log_activity()` — routet automatisch zu SQLite oder JSON-Fallback je nach verfügbarer DB-Verbindung
- **[NIEDRIG]** `AppState::log_activity()` wird nicht mehr aufgerufen wenn kein Projekt aktiv ist (vorher: silent no-op)
- **[HOCH]** Ticket-ID-Vergabe in `create_ticket_from_template` und `import_tickets` nutzt jetzt monoton steigenden `next_ticket_id`-Zähler statt `tickets.len() + 1`, um Duplikat-IDs nach Löschungen zu vermeiden

### Security
- **[HOCH]** API-Token im Klartext in `settings.json`: Token wird jetzt mit ChaCha20-Poly1305 verschlüsselt gespeichert, maschinengebunden via `/etc/machine-id`
- **[HOCH]** Crypto-KDF zu schwach: SHA-256 als Key-Derivation-Function für API-Token-Verschlüsselung ersetzt durch PBKDF2-HMAC-SHA256 mit 100.000 Runden (`src/crypto.rs`, KANBAN-011)
  - Maschinengebundene ID jetzt plattformspezifisch: Linux `/etc/machine-id`, macOS `IOPlatformUUID` (via `ioreg`), Windows `MachineGuid` (Registry)
  - Statischer Fallback-Key entfernt; fehlende Machine-ID erzeugt stattdessen eine zufällige UUID, die persistent in `~/.config/kanban-runner/machine-seed.txt` gespeichert wird
  - Token-Format von `v1` auf `v2` angehoben; bestehende `v1`-Tokens werden weiterhin entschlüsselt (vollständige Rückwärtskompatibilität)
  - Neue Abhängigkeit: `pbkdf2` crate
- **[HOCH]** IPC-Angriffsfläche reduziert: `withGlobalTauri: false` in `tauri.conf.json` gesetzt — `window.__TAURI__` wird nicht mehr global exponiert (`tauri.conf.json`, KANBAN-012)
  - `window.__TAURI__.core`/`window.__TAURI__.event`-Zugriffe in `frontend/app.js` durch explizite ES-Module-Imports aus `@tauri-apps/api` ersetzt
  - Vite als Frontend-Build-System eingeführt (`frontend/package.json`, `frontend/vite.config.js`)
  - `tauri.conf.json` Build-Sektion aktualisiert: `frontendDist` zeigt auf `./frontend/dist`; `devUrl`, `beforeDevCommand` und `beforeBuildCommand` hinzugefügt
  - `.gitignore` angepasst: `package.json`-Ignore auf Root-Ebene beschränkt, um `frontend/package.json` nicht zu ignorieren



### Added
- **Bug-Sync (Portal Bug-Tracker):** Bugs aus der Portal `alpha_bugs`-Tabelle koennen automatisch als Bugfix-Tickets ins Kanban Board importiert werden
  - Neues Rust-Modul `bugsync.rs` mit HTTP-Client (reqwest) fuer Portal API
  - Neue Tauri-Commands: `sync_portal_bugs` (synchronisiert Bugs und erstellt Tickets), `get_bug_sync_settings` (liest aktuelle Sync-Konfiguration)
  - Settings-Abschnitt "Bug-Sync (Portal)" mit API URL, API Token, Sync-Intervall und Enable/Disable Toggle
  - Board-Header Button "Bugs synchen" fuer manuellen Sync
  - Sidebar-Badge zeigt Anzahl verfuegbarer Bugs
  - Auto-Sync Timer mit konfigurierbarem Intervall (Standard: 5 min, Minimum: 60 s)
  - Portal-Bugs werden als Bugfix-Tickets im Backlog angelegt mit "Portal-Bug" Badge
  - Ticket-Detail zeigt Portal Bug ID und URL an
  - Neue Felder auf Ticket: `portal_bug_id`, `portal_bug_url`
  - Duplikat-Erkennung: bereits synchronisierte Bugs (gleiche `portal_bug_id`) werden uebersprungen
  - Portal API Endpunkte: `GET /unsynced` (Bugs abrufen), `POST /mark-synced` (Bugs als gesynct markieren mit `kanban_ticket_id`)
  - Plattformuebergreifend (HTTP-basiert, funktioniert auf Windows + Linux)
  - Dependency hinzugefuegt: `reqwest 0.12` mit `json` und `rustls-tls` Features

### Fixed
- **[NIEDRIG]** Dead Code entfernt: `runner.rs` (`parse_token_usage`, `calculate_cost`, `TokenUsage`) war mit `#[allow(dead_code)]` gesilenced und nie exponiert — Modul gelöscht, `mod runner` aus `main.rs` entfernt
- **[NIEDRIG]** `TerminalCmd::Resize(u32, u32)` Parameterreihenfolge (cols, rows) dokumentiert — Code war korrekt, aber unkommentiert und damit missverständlich
- **[NIEDRIG]** Frontend/Backend Model-ID Mismatch: HTML-Selects verwenden jetzt Full-IDs (`claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5-20251001`) statt Shorthands; `modelToFlag()` behandelt alte Shorthand-Werte rückwärtskompatibel; alle `|| "sonnet"`-Fallbacks auf `|| "claude-sonnet-4-6"` aktualisiert
- **[MITTEL]** PTY Read-Fehler wurde komplett ignoriert (`Err(_) => break`): Fehlertyp wird jetzt via `eprintln!` geloggt, damit unerwartete PTY-Fehler von normalem Prozess-Exit unterscheidbar sind (`terminal.rs`)
- **[MITTEL]** Path-Traversal-Härtung in `project_data_dir()`: zusätzlich zum Char-Sanitizing werden jetzt (1) All-Dash-Namen abgelehnt und (2) nach `create_dir_all` ein Canonicalize-Check durchgeführt, der Symlink-basierte Escapes erkennt (`config.rs`)
- **[MITTEL]** Default-Modell von unspezifischem `"sonnet"` auf konkretes `"claude-sonnet-4-6"` aktualisiert; Cost-Defaults ($3/$15) mit Kommentar versehen, dass sie Sonnet 4.6-Preisen entsprechen (`state.rs`)
- **[HOCH]** Nicht-atomarer Board-Save: `save_board()` schreibt jetzt zuerst in `kanban.json.tmp` und benennt dann atomar um — verhindert korrupte Datei bei Absturz mitten im Write (`kanban.rs`)
- **[HOCH]** Backup-Deletion ignorierte Fehler (`let _ = remove_file()`): Fehler werden jetzt via `?` propagiert, damit Disk-Space-Lecks dem Aufrufer gemeldet werden (`kanban.rs`)
- **[HOCH]** Log-Panel ohne Größenlimit: `appendLog()` entfernt jetzt älteste Zeilen sobald `LOG_MAX_LINES = 500` überschritten wird — verhindert DOM-Freeze (`app.js`)
- **[HOCH]** `activity.rs` verwendete `Vec::Remove(0)` (O(n)) für Front-Removal: umgestellt auf `VecDeque::pop_front()` (O(1)) (`activity.rs`)
- **[KRITISCH]** `validate_git_ref()` erlaubte Leerzeichen in Branch-Namen → Leerzeichen aus der Allowlist entfernt, verhindert Argument-Splitting in Git-Aufrufen (`git.rs`)
- **[KRITISCH]** Bug-Sync Timer las Credentials vor dem optionalen Extra-Sleep, verwendete dann möglicherweise veraltete API-URL/Token → Settings werden jetzt *nach* dem Sleep neu gelesen, direkt vor dem HTTP-Request (`main.rs`)
- **[KRITISCH]** `shellEscape()` verwendete POSIX Single-Quote-Escaping für lokale Shell-Argumente, das in Windows CMD nicht funktioniert → neue Funktion `shellEscapeLocal()` mit Double-Quote-Escaping (bash/PowerShell/CMD-kompatibel) für SSH-Key und SSH-Host; `shellEscape()` bleibt für Remote-Bash-Argumente innerhalb des SSH-Command-Strings (`app.js`)

### Security
- **[KRITISCH]** Path Traversal in Agent/Command Editor und Backup-Restore: Namen mit `../` konnten beliebige Dateien lesen/schreiben/löschen. Fix: `validate_safe_name()` und `validate_backup_filename()` prüfen alle Eingaben
- **[KRITISCH]** Command Injection in SSH Deploy: User-Input wurde unescaped in Shell-Befehle interpoliert. Fix: `shell_escape()` und `validate_deploy_param()` in Backend und Frontend
- **[HOCH]** Terminal `spawn_terminal` erlaubte beliebige Shell-Pfade. Fix: Whitelist-Validierung gegen `detect_shells()` in allen Terminal-Spawn-Aufrufen (inkl. Deploy-Funktionen)
- **[HOCH]** Git Branch-Namen wurden nicht validiert, Option-Injection möglich. Fix: `validate_git_ref()` und `--` Separator vor User-Input
- **[HOCH]** Ticket-IDs konnten nach Löschungen kollidieren. Fix: Monoton steigender `next_ticket_id` Counter im Board
- **[HOCH]** `deploy-config.json` war nur indirekt über `.claude/` in `.gitignore` geschützt. Fix: Expliziter Eintrag in `.gitignore`
- **[MITTEL]** Content Security Policy (CSP) im HTML hinzugefügt als Defense-in-Depth gegen XSS
- **[MITTEL]** `log_lines` von `Vec` auf `VecDeque` umgestellt für O(1) statt O(n) Entfernung
- Clippy-Warning in `git.rs` behoben (unnötiges `format!`)

### Fixed
- Terminal-Panel: Einklappen nach Drag-Resize ließ keinen leeren Bereich mehr — inline height wird beim Einklappen entfernt und beim Aufklappen wiederhergestellt
- KANBAN-004: `copy_claude_config()` in `src/git.rs` kopierte bisher den kompletten `.claude/` Ordner in den Worktree inklusive Runtime-Daten (`kanban.json`, `activity-log.json`, `kanban-backups/` etc.) — Fix: Nur `agents/` und `commands/` werden explizit kopiert, alle Runtime-Daten werden übersprungen; `.unwrap_or_default()` beim Lesen von `.gitignore` durch echtes Error-Handling ersetzt
- KANBAN-007: Desktop-Icon zeigte oranges Quadrat statt Raketen-Icon
  - `icon.ico` hatte fehlerhafte nicht-quadratische Dimensionen (32x31, 48x47, 64x62, 128x125, 256x249) — wurde mit korrekten Größen neu generiert: 16x16, 32x32, 48x48, 64x64, 128x128, 256x256
  - `tauri.conf.json` fehlte der `bundle`-Abschnitt mit Icon-Konfiguration vollständig — wurde hinzugefügt
