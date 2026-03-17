# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

### Fixed
- Terminal-Panel: Einklappen nach Drag-Resize ließ keinen leeren Bereich mehr — inline height wird beim Einklappen entfernt und beim Aufklappen wiederhergestellt
- KANBAN-004: `copy_claude_config()` in `src/git.rs` kopierte bisher den kompletten `.claude/` Ordner in den Worktree inklusive Runtime-Daten (`kanban.json`, `activity-log.json`, `kanban-backups/` etc.) — Fix: Nur `agents/` und `commands/` werden explizit kopiert, alle Runtime-Daten werden übersprungen; `.unwrap_or_default()` beim Lesen von `.gitignore` durch echtes Error-Handling ersetzt
