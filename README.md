<p align="center">
  <img src="docs/screenshot-dark.png" alt="Glitch Goblin — Dark Theme" width="800">
</p>

<h1 align="center">Glitch Goblin</h1>

<p align="center">
  Desktop-Kanban-Board fuer Entwicklungsprojekte mit integriertem Terminal, Git-Workflow und Claude Code Integration.
  <br>
  <strong>Windows &bull; Linux</strong>
</p>

<p align="center">
  <a href="https://github.com/breiti35/Glitch-Goblin/actions"><img src="https://github.com/breiti35/Glitch-Goblin/actions/workflows/build.yml/badge.svg" alt="Build"></a>
  <a href="https://github.com/breiti35/Glitch-Goblin/releases/latest"><img src="https://img.shields.io/github/v/release/breiti35/Glitch-Goblin?label=Version" alt="Version"></a>
  <img src="https://img.shields.io/badge/Tauri-v2-blue" alt="Tauri v2">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
</p>

---

## Features

- Kanban Board mit Drag-and-Drop, Fokus-Modus und Ticket-Archivierung
- Integriertes Terminal mit Multi-Tab und konfigurierbarer Shell
- Git-Integration: automatische Branches, Review-Diffs, Merge-Workflow
- Claude Code Integration mit Kontingent-Anzeige und Token-Tracking
- Multi-Projekt-Verwaltung mit Dashboard und Statistiken
- Dark / Light Theme
- Import/Export, Templates, Backups

<details>
<summary><strong>Light Theme</strong></summary>
<p align="center">
  <img src="docs/screenshot-light.png" alt="Glitch Goblin — Light Theme" width="800">
</p>
</details>

---

## Installation

### Download

Fertige Builds (Windows Installer + Portable, Linux AppImage) gibt es unter [Releases](https://github.com/breiti35/Glitch-Goblin/releases/latest).

### Aus dem Quellcode bauen

Voraussetzungen: [Rust](https://rustup.rs/) (stable), [Node.js](https://nodejs.org/), Tauri CLI (`cargo install tauri-cli`)

```bash
git clone https://github.com/breiti35/Glitch-Goblin.git
cd Glitch-Goblin
cargo tauri dev       # Development
cargo tauri build     # Release Build
```

---

## Schnellstart

1. **Projekt hinzufuegen** — Projektordner auswaehlen (muss ein Git-Repository sein)
2. **Ticket erstellen** — `Ctrl+N` oder [+] im Backlog
3. **Starten** — Erstellt Branch, oeffnet Fokus-Modus mit Terminal
4. **Abschliessen** — Review-Diff, dann Commit
5. **Mergen** — Branch in Hauptbranch uebernehmen

---

## Lizenz

[MIT](LICENSE) — Copyright (c) 2026 breiti35
