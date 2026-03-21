/// SQLite persistence layer for Kanban Runner.
///
/// Replaces kanban.json / activity-log.json / deploy-config.json /
/// ticket-templates.json with a single kanban.db per project.
///
/// JSON files (settings.json, projects.json) are intentionally kept as-is
/// because they are small, global, and user-editable.
use rusqlite::{params, Connection, Result as SqlResult};
use std::path::Path;
use tracing::info;

use crate::activity::ActivityEntry;
use crate::config::TicketTemplate;
use crate::deploy::DeployConfig;
use crate::kanban::{Column, KanbanBoard, Ticket, TicketComment, TicketType};

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA_VERSION: i64 = 1;

const CREATE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER NOT NULL,
    applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS board_meta (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    project_name   TEXT    NOT NULL DEFAULT '',
    next_ticket_id INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tickets (
    id           TEXT    PRIMARY KEY,
    title        TEXT    NOT NULL,
    slug         TEXT    NOT NULL DEFAULT '',
    ticket_type  TEXT    NOT NULL,
    col          TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    prio         TEXT,
    created_at   TEXT,
    started_at   TEXT,
    review_at    TEXT,
    done_at      TEXT,
    has_changes  INTEGER,
    branch       TEXT,
    tokens_used  INTEGER,
    cost_usd     REAL,
    model_used   TEXT,
    portal_bug_id  INTEGER,
    portal_bug_url TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ticket_comments (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT    NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    timestamp TEXT    NOT NULL,
    text      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp    TEXT NOT NULL,
    action       TEXT NOT NULL,
    ticket_id    TEXT,
    ticket_title TEXT,
    details      TEXT
);

CREATE TABLE IF NOT EXISTS deploy_config (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    deploy_type     TEXT NOT NULL DEFAULT 'compose',
    compose_files   TEXT NOT NULL DEFAULT '[]',
    env_file        TEXT NOT NULL DEFAULT '',
    local_url       TEXT NOT NULL DEFAULT '',
    live_enabled    INTEGER NOT NULL DEFAULT 0,
    ssh_host        TEXT NOT NULL DEFAULT '',
    ssh_key         TEXT NOT NULL DEFAULT '',
    ssh_port        INTEGER NOT NULL DEFAULT 22,
    server_path     TEXT NOT NULL DEFAULT '',
    server_branch   TEXT NOT NULL DEFAULT '',
    pre_commands    TEXT NOT NULL DEFAULT '[]',
    deploy_commands TEXT NOT NULL DEFAULT '[]',
    post_commands   TEXT NOT NULL DEFAULT '[]',
    live_url        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ticket_templates (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    sort_order           INTEGER NOT NULL DEFAULT 0,
    name                 TEXT    NOT NULL,
    ticket_type          TEXT    NOT NULL,
    default_prio         TEXT    NOT NULL DEFAULT 'medium',
    title_prefix         TEXT    NOT NULL DEFAULT '',
    description_template TEXT    NOT NULL DEFAULT ''
);
";

// ── Open / Init ───────────────────────────────────────────────────────────────

/// Open (or create) the project database at `<data_dir>/kanban.db`.
pub fn open(data_dir: &Path) -> Result<Connection, String> {
    let db_path = data_dir.join("kanban.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("DB öffnen fehlgeschlagen '{}': {e}", db_path.display()))?;

    // WAL mode: better concurrency, faster writes
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("PRAGMA fehlgeschlagen: {e}"))?;

    // Create schema
    conn.execute_batch(CREATE_SCHEMA)
        .map_err(|e| format!("Schema-Erstellung fehlgeschlagen: {e}"))?;

    // Record schema version if not already present
    let version: SqlResult<i64> =
        conn.query_row("SELECT version FROM schema_version LIMIT 1", [], |r| r.get(0));
    if version.is_err() {
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            params![SCHEMA_VERSION],
        )
        .map_err(|e| format!("Schema-Version eintragen fehlgeschlagen: {e}"))?;
    }

    Ok(conn)
}

// ── Board R/W ─────────────────────────────────────────────────────────────────

pub fn load_board(conn: &Connection) -> Result<KanbanBoard, String> {
    // Meta row
    let (project_name, next_ticket_id): (String, u32) = conn
        .query_row(
            "SELECT project_name, next_ticket_id FROM board_meta WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or_else(|_| (String::new(), 1));

    // Tickets
    let mut stmt = conn
        .prepare(
            "SELECT id, title, slug, ticket_type, col, description, prio,
                    created_at, started_at, review_at, done_at,
                    has_changes, branch, tokens_used, cost_usd, model_used,
                    portal_bug_id, portal_bug_url
             FROM tickets
             ORDER BY sort_order, rowid",
        )
        .map_err(|e| format!("Tickets laden fehlgeschlagen: {e}"))?;

    let mut tickets = Vec::new();
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,  // id
                r.get::<_, String>(1)?,  // title
                r.get::<_, String>(2)?,  // slug
                r.get::<_, String>(3)?,  // ticket_type
                r.get::<_, String>(4)?,  // col
                r.get::<_, String>(5)?,  // description
                r.get::<_, Option<String>>(6)?,  // prio
                r.get::<_, Option<String>>(7)?,  // created_at
                r.get::<_, Option<String>>(8)?,  // started_at
                r.get::<_, Option<String>>(9)?,  // review_at
                r.get::<_, Option<String>>(10)?, // done_at
                r.get::<_, Option<i64>>(11)?,    // has_changes
                r.get::<_, Option<String>>(12)?, // branch
                r.get::<_, Option<i64>>(13)?,    // tokens_used
                r.get::<_, Option<f64>>(14)?,    // cost_usd
                r.get::<_, Option<String>>(15)?, // model_used
                r.get::<_, Option<i64>>(16)?,    // portal_bug_id
                r.get::<_, Option<String>>(17)?, // portal_bug_url
            ))
        })
        .map_err(|e| format!("Ticket-Zeilen lesen fehlgeschlagen: {e}"))?;

    for row in rows {
        let (
            id, title, slug, ticket_type_str, col_str, description, prio,
            created_at, started_at, review_at, done_at, has_changes,
            branch, tokens_used, cost_usd, model_used, portal_bug_id, portal_bug_url,
        ) = row.map_err(|e| format!("Ticket-Zeile lesen fehlgeschlagen: {e}"))?;

        let ticket_type = parse_ticket_type(&ticket_type_str);
        let column = parse_column(&col_str);

        // Load comments for this ticket
        let comments = load_comments(conn, &id).unwrap_or_default();

        tickets.push(Ticket {
            id,
            title,
            slug,
            ticket_type,
            column,
            description,
            prio,
            created_at,
            started_at,
            review_at,
            done_at,
            has_changes: has_changes.map(|v| v != 0),
            branch,
            tokens_used: tokens_used.map(|v| v as u64),
            cost_usd,
            model_used,
            comments: if comments.is_empty() { None } else { Some(comments) },
            portal_bug_id: portal_bug_id.map(|v| v as u64),
            portal_bug_url,
        });
    }

    Ok(KanbanBoard {
        project_name,
        tickets,
        next_ticket_id,
    })
}

fn load_comments(conn: &Connection, ticket_id: &str) -> Result<Vec<TicketComment>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT timestamp, text FROM ticket_comments WHERE ticket_id = ?1 ORDER BY id",
        )
        .map_err(|e| format!("Kommentare laden: {e}"))?;
    let rows = stmt
        .query_map(params![ticket_id], |r| {
            Ok(TicketComment {
                timestamp: r.get(0)?,
                text: r.get(1)?,
            })
        })
        .map_err(|e| format!("Kommentar-Zeilen lesen: {e}"))?;
    rows.collect::<SqlResult<Vec<_>>>()
        .map_err(|e| format!("Kommentar-Zeile: {e}"))
}

pub fn save_board(conn: &Connection, board: &KanbanBoard) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Transaktion starten fehlgeschlagen: {e}"))?;

    // Upsert meta
    tx.execute(
        "INSERT INTO board_meta (id, project_name, next_ticket_id) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET project_name=excluded.project_name,
                                       next_ticket_id=excluded.next_ticket_id",
        params![board.project_name, board.next_ticket_id],
    )
    .map_err(|e| format!("board_meta speichern fehlgeschlagen: {e}"))?;

    // Collect current ticket IDs from DB to detect deletions
    let existing_ids: Vec<String> = {
        let ids_result: SqlResult<Vec<String>> = {
            let mut s = tx
                .prepare("SELECT id FROM tickets")
                .map_err(|e| format!("Ticket-IDs laden: {e}"))?;
            let rows = s
                .query_map([], |r| r.get(0))
                .map_err(|e| format!("Ticket-IDs lesen: {e}"))?;
            rows.collect()
        };
        ids_result.map_err(|e| format!("Ticket-ID-Zeile: {e}"))?
    };

    let new_ids: std::collections::HashSet<&str> = board.tickets.iter().map(|t| t.id.as_str()).collect();

    // Delete removed tickets
    for old_id in &existing_ids {
        if !new_ids.contains(old_id.as_str()) {
            tx.execute("DELETE FROM tickets WHERE id = ?1", params![old_id])
                .map_err(|e| format!("Ticket löschen fehlgeschlagen: {e}"))?;
        }
    }

    // Upsert each ticket
    for (sort_order, ticket) in board.tickets.iter().enumerate() {
        tx.execute(
            "INSERT INTO tickets (id, title, slug, ticket_type, col, description, prio,
                                  created_at, started_at, review_at, done_at,
                                  has_changes, branch, tokens_used, cost_usd, model_used,
                                  portal_bug_id, portal_bug_url, sort_order)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
             ON CONFLICT(id) DO UPDATE SET
               title=excluded.title, slug=excluded.slug,
               ticket_type=excluded.ticket_type, col=excluded.col,
               description=excluded.description, prio=excluded.prio,
               created_at=excluded.created_at, started_at=excluded.started_at,
               review_at=excluded.review_at, done_at=excluded.done_at,
               has_changes=excluded.has_changes, branch=excluded.branch,
               tokens_used=excluded.tokens_used, cost_usd=excluded.cost_usd,
               model_used=excluded.model_used,
               portal_bug_id=excluded.portal_bug_id,
               portal_bug_url=excluded.portal_bug_url,
               sort_order=excluded.sort_order",
            params![
                ticket.id,
                ticket.title,
                ticket.slug,
                ticket_type_str(&ticket.ticket_type),
                column_str(&ticket.column),
                ticket.description,
                ticket.prio,
                ticket.created_at,
                ticket.started_at,
                ticket.review_at,
                ticket.done_at,
                ticket.has_changes.map(|b| b as i64),
                ticket.branch,
                ticket.tokens_used.map(|v| v as i64),
                ticket.cost_usd,
                ticket.model_used,
                ticket.portal_bug_id.map(|v| v as i64),
                ticket.portal_bug_url,
                sort_order as i64,
            ],
        )
        .map_err(|e| format!("Ticket '{}' speichern fehlgeschlagen: {e}", ticket.id))?;

        // Sync comments: delete old, insert fresh
        tx.execute(
            "DELETE FROM ticket_comments WHERE ticket_id = ?1",
            params![ticket.id],
        )
        .map_err(|e| format!("Kommentare löschen: {e}"))?;

        if let Some(comments) = &ticket.comments {
            for c in comments {
                tx.execute(
                    "INSERT INTO ticket_comments (ticket_id, timestamp, text) VALUES (?1,?2,?3)",
                    params![ticket.id, c.timestamp, c.text],
                )
                .map_err(|e| format!("Kommentar speichern: {e}"))?;
            }
        }
    }

    tx.commit()
        .map_err(|e| format!("Transaktion committen fehlgeschlagen: {e}"))
}

// ── Activity Log ──────────────────────────────────────────────────────────────

const MAX_ACTIVITY: i64 = 500;

pub fn log_activity(
    conn: &Connection,
    action: &str,
    ticket_id: Option<&str>,
    ticket_title: Option<&str>,
    details: Option<&str>,
) {
    let timestamp = chrono::Utc::now().to_rfc3339();
    let _ = conn.execute(
        "INSERT INTO activity_log (timestamp, action, ticket_id, ticket_title, details)
         VALUES (?1,?2,?3,?4,?5)",
        params![timestamp, action, ticket_id, ticket_title, details],
    );
    // Prune oldest entries
    let _ = conn.execute(
        "DELETE FROM activity_log WHERE id NOT IN (
            SELECT id FROM activity_log ORDER BY id DESC LIMIT ?1
         )",
        params![MAX_ACTIVITY],
    );
}

pub fn get_activity(conn: &Connection, limit: usize) -> Vec<ActivityEntry> {
    let mut stmt = match conn.prepare(
        "SELECT timestamp, action, ticket_id, ticket_title, details
         FROM activity_log ORDER BY id DESC LIMIT ?1",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map(params![limit as i64], |r| {
        Ok(ActivityEntry {
            timestamp: r.get(0)?,
            action: r.get(1)?,
            ticket_id: r.get(2)?,
            ticket_title: r.get(3)?,
            details: r.get(4)?,
        })
    })
    .ok()
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

// ── Deploy Config ─────────────────────────────────────────────────────────────

pub fn load_deploy_config(conn: &Connection) -> Option<DeployConfig> {
    conn.query_row(
        "SELECT deploy_type, compose_files, env_file, local_url,
                live_enabled, ssh_host, ssh_key, ssh_port, server_path,
                server_branch, pre_commands, deploy_commands, post_commands, live_url
         FROM deploy_config WHERE id = 1",
        [],
        |r| {
            let compose_files_json: String = r.get(1)?;
            let pre_commands_json: String = r.get(10)?;
            let deploy_commands_json: String = r.get(11)?;
            let post_commands_json: String = r.get(12)?;
            Ok((
                r.get::<_, String>(0)?,  // deploy_type
                compose_files_json,
                r.get::<_, String>(2)?,  // env_file
                r.get::<_, String>(3)?,  // local_url
                r.get::<_, i64>(4)?,     // live_enabled
                r.get::<_, String>(5)?,  // ssh_host
                r.get::<_, String>(6)?,  // ssh_key
                r.get::<_, i64>(7)?,     // ssh_port
                r.get::<_, String>(8)?,  // server_path
                r.get::<_, String>(9)?,  // server_branch
                pre_commands_json,
                deploy_commands_json,
                post_commands_json,
                r.get::<_, String>(13)?, // live_url
            ))
        },
    )
    .ok()
    .map(|(deploy_type, cf_json, env_file, local_url, live_enabled, ssh_host, ssh_key, ssh_port,
           server_path, server_branch, pre_json, deploy_json, post_json, live_url)| {
        DeployConfig {
            deploy_type,
            compose_files: serde_json::from_str(&cf_json).unwrap_or_default(),
            env_file,
            local_url,
            live_enabled: live_enabled != 0,
            ssh_host,
            ssh_key,
            ssh_port: ssh_port as u16,
            server_path,
            server_branch,
            pre_commands: serde_json::from_str(&pre_json).unwrap_or_default(),
            deploy_commands: serde_json::from_str(&deploy_json).unwrap_or_default(),
            post_commands: serde_json::from_str(&post_json).unwrap_or_default(),
            live_url,
        }
    })
}

pub fn save_deploy_config(conn: &Connection, cfg: &DeployConfig) -> Result<(), String> {
    conn.execute(
        "INSERT INTO deploy_config (id, deploy_type, compose_files, env_file, local_url,
                                    live_enabled, ssh_host, ssh_key, ssh_port, server_path,
                                    server_branch, pre_commands, deploy_commands, post_commands, live_url)
         VALUES (1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
         ON CONFLICT(id) DO UPDATE SET
           deploy_type=excluded.deploy_type, compose_files=excluded.compose_files,
           env_file=excluded.env_file, local_url=excluded.local_url,
           live_enabled=excluded.live_enabled, ssh_host=excluded.ssh_host,
           ssh_key=excluded.ssh_key, ssh_port=excluded.ssh_port,
           server_path=excluded.server_path, server_branch=excluded.server_branch,
           pre_commands=excluded.pre_commands, deploy_commands=excluded.deploy_commands,
           post_commands=excluded.post_commands, live_url=excluded.live_url",
        params![
            cfg.deploy_type,
            serde_json::to_string(&cfg.compose_files).unwrap_or_default(),
            cfg.env_file,
            cfg.local_url,
            cfg.live_enabled as i64,
            cfg.ssh_host,
            cfg.ssh_key,
            cfg.ssh_port as i64,
            cfg.server_path,
            cfg.server_branch,
            serde_json::to_string(&cfg.pre_commands).unwrap_or_default(),
            serde_json::to_string(&cfg.deploy_commands).unwrap_or_default(),
            serde_json::to_string(&cfg.post_commands).unwrap_or_default(),
            cfg.live_url,
        ],
    )
    .map_err(|e| format!("Deploy-Konfiguration speichern fehlgeschlagen: {e}"))?;
    Ok(())
}

// ── Templates ─────────────────────────────────────────────────────────────────

pub fn load_templates(conn: &Connection) -> Vec<TicketTemplate> {
    let mut stmt = match conn.prepare(
        "SELECT name, ticket_type, default_prio, title_prefix, description_template
         FROM ticket_templates ORDER BY sort_order, id",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([], |r| {
        Ok(TicketTemplate {
            name: r.get(0)?,
            ticket_type: r.get(1)?,
            default_prio: r.get(2)?,
            title_prefix: r.get(3)?,
            description_template: r.get(4)?,
        })
    })
    .ok()
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

pub fn save_templates(conn: &Connection, templates: &[TicketTemplate]) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Transaktion starten: {e}"))?;
    tx.execute("DELETE FROM ticket_templates", [])
        .map_err(|e| format!("Templates löschen: {e}"))?;
    for (i, t) in templates.iter().enumerate() {
        tx.execute(
            "INSERT INTO ticket_templates (sort_order, name, ticket_type, default_prio, title_prefix, description_template)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![i as i64, t.name, t.ticket_type, t.default_prio, t.title_prefix, t.description_template],
        )
        .map_err(|e| format!("Template '{}' speichern: {e}", t.name))?;
    }
    tx.commit()
        .map_err(|e| format!("Template-Transaktion committen: {e}"))
}

// ── JSON → SQLite Migration ───────────────────────────────────────────────────

/// Migrate existing JSON files to SQLite (runs once on first start with a new DB).
///
/// Migration is skipped if `board_meta` already has a row (= DB is populated).
/// After a successful commit the source JSON files are renamed to `*.migrated`.
pub fn migrate_from_json(conn: &Connection, data_dir: &Path) -> Result<bool, String> {
    // Already migrated?
    let has_meta: bool = conn
        .query_row("SELECT COUNT(*) FROM board_meta", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
        > 0;
    if has_meta {
        return Ok(false);
    }

    let kanban_path = data_dir.join("kanban.json");
    let activity_path = data_dir.join("activity-log.json");
    let deploy_path = data_dir.join("deploy-config.json");
    let templates_path = data_dir.join("ticket-templates.json");

    // Nothing to migrate if kanban.json doesn't exist
    if !kanban_path.exists() {
        return Ok(false);
    }

    // Load kanban board from JSON
    let board = crate::kanban::load_board(&kanban_path)
        .unwrap_or(KanbanBoard {
            project_name: String::new(),
            tickets: Vec::new(),
            next_ticket_id: 1,
        });

    // Load activity log from JSON
    let activity_entries: Vec<ActivityEntry> = activity_path
        .exists()
        .then(|| {
            std::fs::read_to_string(&activity_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
        })
        .flatten()
        .unwrap_or_default();

    // Load deploy config from JSON
    let deploy_cfg: Option<DeployConfig> = deploy_path
        .exists()
        .then(|| {
            std::fs::read_to_string(&deploy_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
        })
        .flatten();

    // Load templates from JSON
    let templates: Vec<TicketTemplate> = templates_path
        .exists()
        .then(|| {
            std::fs::read_to_string(&templates_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
        })
        .flatten()
        .unwrap_or_default();

    // Run everything inside one transaction
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Migration-Transaktion starten: {e}"))?;

    // Board meta
    tx.execute(
        "INSERT INTO board_meta (id, project_name, next_ticket_id) VALUES (1,?1,?2)",
        params![board.project_name, board.next_ticket_id],
    )
    .map_err(|e| format!("Migration board_meta: {e}"))?;

    // Tickets (sort_order = array index from JSON)
    for (i, ticket) in board.tickets.iter().enumerate() {
        tx.execute(
            "INSERT INTO tickets (id, title, slug, ticket_type, col, description, prio,
                                  created_at, started_at, review_at, done_at,
                                  has_changes, branch, tokens_used, cost_usd, model_used,
                                  portal_bug_id, portal_bug_url, sort_order)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
            params![
                ticket.id,
                ticket.title,
                ticket.slug,
                ticket_type_str(&ticket.ticket_type),
                column_str(&ticket.column),
                ticket.description,
                ticket.prio,
                ticket.created_at,
                ticket.started_at,
                ticket.review_at,
                ticket.done_at,
                ticket.has_changes.map(|b| b as i64),
                ticket.branch,
                ticket.tokens_used.map(|v| v as i64),
                ticket.cost_usd,
                ticket.model_used,
                ticket.portal_bug_id.map(|v| v as i64),
                ticket.portal_bug_url,
                i as i64,
            ],
        )
        .map_err(|e| format!("Migration Ticket '{}': {e}", ticket.id))?;

        if let Some(comments) = &ticket.comments {
            for c in comments {
                tx.execute(
                    "INSERT INTO ticket_comments (ticket_id, timestamp, text) VALUES (?1,?2,?3)",
                    params![ticket.id, c.timestamp, c.text],
                )
                .map_err(|e| format!("Migration Kommentar für '{}': {e}", ticket.id))?;
            }
        }
    }

    // Activity log
    for entry in &activity_entries {
        tx.execute(
            "INSERT INTO activity_log (timestamp, action, ticket_id, ticket_title, details)
             VALUES (?1,?2,?3,?4,?5)",
            params![
                entry.timestamp,
                entry.action,
                entry.ticket_id,
                entry.ticket_title,
                entry.details,
            ],
        )
        .map_err(|e| format!("Migration Aktivitätslog: {e}"))?;
    }

    // Deploy config
    if let Some(cfg) = &deploy_cfg {
        tx.execute(
            "INSERT INTO deploy_config (id, deploy_type, compose_files, env_file, local_url,
                                        live_enabled, ssh_host, ssh_key, ssh_port, server_path,
                                        server_branch, pre_commands, deploy_commands, post_commands, live_url)
             VALUES (1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                cfg.deploy_type,
                serde_json::to_string(&cfg.compose_files).unwrap_or_default(),
                cfg.env_file,
                cfg.local_url,
                cfg.live_enabled as i64,
                cfg.ssh_host,
                cfg.ssh_key,
                cfg.ssh_port as i64,
                cfg.server_path,
                cfg.server_branch,
                serde_json::to_string(&cfg.pre_commands).unwrap_or_default(),
                serde_json::to_string(&cfg.deploy_commands).unwrap_or_default(),
                serde_json::to_string(&cfg.post_commands).unwrap_or_default(),
                cfg.live_url,
            ],
        )
        .map_err(|e| format!("Migration Deploy-Konfiguration: {e}"))?;
    }

    // Templates
    for (i, t) in templates.iter().enumerate() {
        tx.execute(
            "INSERT INTO ticket_templates (sort_order, name, ticket_type, default_prio, title_prefix, description_template)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![i as i64, t.name, t.ticket_type, t.default_prio, t.title_prefix, t.description_template],
        )
        .map_err(|e| format!("Migration Template '{}': {e}", t.name))?;
    }

    tx.commit()
        .map_err(|e| format!("Migration-Transaktion committen: {e}"))?;

    // Rename source JSON files so they are not re-imported on next start
    // (safe: if rename fails after commit the next start will skip migration
    //  because board_meta already has a row)
    for (src, suffix) in [
        (&kanban_path, "kanban.json.migrated"),
        (&activity_path, "activity-log.json.migrated"),
        (&deploy_path, "deploy-config.json.migrated"),
        (&templates_path, "ticket-templates.json.migrated"),
    ] {
        if src.exists() {
            let dst = data_dir.join(suffix);
            let _ = std::fs::rename(src, dst);
        }
    }

    info!("Migration von JSON nach SQLite abgeschlossen");
    Ok(true)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn ticket_type_str(t: &TicketType) -> &'static str {
    match t {
        TicketType::Feature => "feature",
        TicketType::Bugfix => "bugfix",
        TicketType::Security => "security",
        TicketType::Docs => "docs",
    }
}

fn column_str(c: &Column) -> &'static str {
    match c {
        Column::Backlog => "backlog",
        Column::Progress => "progress",
        Column::Review => "review",
        Column::Done => "done",
    }
}

fn parse_ticket_type(s: &str) -> TicketType {
    match s {
        "bugfix" => TicketType::Bugfix,
        "security" => TicketType::Security,
        "docs" => TicketType::Docs,
        _ => TicketType::Feature,
    }
}

fn parse_column(s: &str) -> Column {
    match s {
        "progress" => Column::Progress,
        "review" => Column::Review,
        "done" => Column::Done,
        _ => Column::Backlog,
    }
}

// ── DB Persistence Integration Tests ──
//
// These tests exercise the full SQLite round-trip: open, save, load, update.
// Each test creates its own temp directory with a fresh database.

#[cfg(test)]
mod integration_tests {
    use super::*;

    /// Build a test board with two tickets covering various field combinations.
    fn create_test_board() -> KanbanBoard {
        KanbanBoard {
            project_name: "Test Project".to_string(),
            tickets: vec![
                Ticket {
                    id: "GG-001".to_string(),
                    title: "First Ticket".to_string(),
                    slug: "first-ticket".to_string(),
                    ticket_type: TicketType::Feature,
                    column: Column::Backlog,
                    description: "Test description".to_string(),
                    prio: Some("high".to_string()),
                    created_at: Some("2026-03-20T12:00:00Z".to_string()),
                    started_at: None,
                    review_at: None,
                    done_at: None,
                    has_changes: None,
                    branch: None,
                    tokens_used: None,
                    cost_usd: None,
                    model_used: None,
                    comments: None,
                    portal_bug_id: None,
                    portal_bug_url: None,
                },
                Ticket {
                    id: "GG-002".to_string(),
                    title: "Second Ticket".to_string(),
                    slug: "second-ticket".to_string(),
                    ticket_type: TicketType::Bugfix,
                    column: Column::Done,
                    description: String::new(),
                    prio: None,
                    created_at: None,
                    started_at: Some("2026-03-19T10:00:00Z".to_string()),
                    review_at: None,
                    done_at: Some("2026-03-20T10:00:00Z".to_string()),
                    has_changes: None,
                    branch: Some("gg/GG-002-second-ticket".to_string()),
                    tokens_used: Some(5000),
                    cost_usd: Some(0.15),
                    model_used: Some("claude-sonnet-4-6".to_string()),
                    comments: None,
                    portal_bug_id: None,
                    portal_bug_url: None,
                },
            ],
            next_ticket_id: 3,
        }
    }

    /// Create a temporary directory for a test database.
    fn temp_db_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gg-db-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_and_load_board() {
        let dir = temp_db_dir();

        let conn = open(&dir).unwrap();
        let board = create_test_board();

        save_board(&conn, &board).unwrap();

        let loaded = load_board(&conn).unwrap();
        assert_eq!(loaded.project_name, "Test Project");
        assert_eq!(loaded.tickets.len(), 2);
        assert_eq!(loaded.next_ticket_id, 3);

        let t1 = &loaded.tickets[0];
        assert_eq!(t1.id, "GG-001");
        assert_eq!(t1.title, "First Ticket");
        assert_eq!(t1.description, "Test description");
        assert_eq!(t1.prio, Some("high".to_string()));

        let t2 = &loaded.tickets[1];
        assert_eq!(t2.id, "GG-002");
        assert_eq!(t2.branch, Some("gg/GG-002-second-ticket".to_string()));
        assert_eq!(t2.cost_usd, Some(0.15));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_ticket_in_db() {
        let dir = temp_db_dir();

        let conn = open(&dir).unwrap();
        let mut board = create_test_board();
        save_board(&conn, &board).unwrap();

        // Modify a ticket
        board.tickets[0].column = Column::Progress;
        board.tickets[0].started_at = Some("2026-03-20T14:00:00Z".to_string());
        save_board(&conn, &board).unwrap();

        let loaded = load_board(&conn).unwrap();
        assert_eq!(loaded.tickets[0].column, Column::Progress);
        assert_eq!(
            loaded.tickets[0].started_at,
            Some("2026-03-20T14:00:00Z".to_string())
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_board_roundtrip() {
        let dir = temp_db_dir();

        let conn = open(&dir).unwrap();
        let board = KanbanBoard {
            project_name: "Empty".to_string(),
            tickets: vec![],
            next_ticket_id: 1,
        };

        save_board(&conn, &board).unwrap();
        let loaded = load_board(&conn).unwrap();
        assert_eq!(loaded.project_name, "Empty");
        assert!(loaded.tickets.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activity_logging() {
        let dir = temp_db_dir();

        let conn = open(&dir).unwrap();

        log_activity(
            &conn,
            "ticket_created",
            Some("GG-001"),
            Some("Test"),
            None,
        );
        log_activity(
            &conn,
            "ticket_started",
            Some("GG-001"),
            Some("Test"),
            Some("model: sonnet"),
        );

        let activities = get_activity(&conn, 10);
        assert_eq!(activities.len(), 2);

        // Most recent first (DESC order)
        assert_eq!(activities[0].action, "ticket_started");
        assert_eq!(activities[1].action, "ticket_created");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_ticket_from_board() {
        let dir = temp_db_dir();

        let conn = open(&dir).unwrap();
        let mut board = create_test_board();
        save_board(&conn, &board).unwrap();

        // Remove second ticket
        board.tickets.retain(|t| t.id == "GG-001");
        save_board(&conn, &board).unwrap();

        let loaded = load_board(&conn).unwrap();
        assert_eq!(loaded.tickets.len(), 1);
        assert_eq!(loaded.tickets[0].id, "GG-001");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn comments_roundtrip() {
        let dir = temp_db_dir();

        let conn = open(&dir).unwrap();
        let mut board = create_test_board();

        // Add comments to first ticket
        board.tickets[0].comments = Some(vec![
            TicketComment {
                timestamp: "2026-03-20T12:00:00Z".to_string(),
                text: "First comment".to_string(),
            },
            TicketComment {
                timestamp: "2026-03-20T13:00:00Z".to_string(),
                text: "Second comment".to_string(),
            },
        ]);
        save_board(&conn, &board).unwrap();

        let loaded = load_board(&conn).unwrap();
        let comments = loaded.tickets[0].comments.as_ref().unwrap();
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].text, "First comment");
        assert_eq!(comments[1].text, "Second comment");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_twice_is_idempotent() {
        let dir = temp_db_dir();

        let conn1 = open(&dir).unwrap();
        let board = create_test_board();
        save_board(&conn1, &board).unwrap();
        drop(conn1);

        // Re-open same DB -- schema creation should be IF NOT EXISTS
        let conn2 = open(&dir).unwrap();
        let loaded = load_board(&conn2).unwrap();
        assert_eq!(loaded.tickets.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ticket_type_roundtrip_all_variants() {
        let dir = temp_db_dir();

        let conn = open(&dir).unwrap();
        let board = KanbanBoard {
            project_name: "Types".to_string(),
            tickets: vec![
                Ticket {
                    id: "GG-001".into(),
                    title: "Feature".into(),
                    slug: "feature".into(),
                    ticket_type: TicketType::Feature,
                    column: Column::Backlog,
                    description: String::new(),
                    prio: None,
                    created_at: None,
                    started_at: None,
                    review_at: None,
                    done_at: None,
                    has_changes: None,
                    branch: None,
                    tokens_used: None,
                    cost_usd: None,
                    model_used: None,
                    comments: None,
                    portal_bug_id: None,
                    portal_bug_url: None,
                },
                Ticket {
                    id: "GG-002".into(),
                    title: "Bugfix".into(),
                    slug: "bugfix".into(),
                    ticket_type: TicketType::Bugfix,
                    column: Column::Progress,
                    description: String::new(),
                    prio: None,
                    created_at: None,
                    started_at: None,
                    review_at: None,
                    done_at: None,
                    has_changes: None,
                    branch: None,
                    tokens_used: None,
                    cost_usd: None,
                    model_used: None,
                    comments: None,
                    portal_bug_id: None,
                    portal_bug_url: None,
                },
                Ticket {
                    id: "GG-003".into(),
                    title: "Security".into(),
                    slug: "security".into(),
                    ticket_type: TicketType::Security,
                    column: Column::Review,
                    description: String::new(),
                    prio: None,
                    created_at: None,
                    started_at: None,
                    review_at: None,
                    done_at: None,
                    has_changes: None,
                    branch: None,
                    tokens_used: None,
                    cost_usd: None,
                    model_used: None,
                    comments: None,
                    portal_bug_id: None,
                    portal_bug_url: None,
                },
                Ticket {
                    id: "GG-004".into(),
                    title: "Docs".into(),
                    slug: "docs".into(),
                    ticket_type: TicketType::Docs,
                    column: Column::Done,
                    description: String::new(),
                    prio: None,
                    created_at: None,
                    started_at: None,
                    review_at: None,
                    done_at: None,
                    has_changes: None,
                    branch: None,
                    tokens_used: None,
                    cost_usd: None,
                    model_used: None,
                    comments: None,
                    portal_bug_id: None,
                    portal_bug_url: None,
                },
            ],
            next_ticket_id: 5,
        };

        save_board(&conn, &board).unwrap();
        let loaded = load_board(&conn).unwrap();

        assert_eq!(loaded.tickets[0].ticket_type, TicketType::Feature);
        assert_eq!(loaded.tickets[0].column, Column::Backlog);
        assert_eq!(loaded.tickets[1].ticket_type, TicketType::Bugfix);
        assert_eq!(loaded.tickets[1].column, Column::Progress);
        assert_eq!(loaded.tickets[2].ticket_type, TicketType::Security);
        assert_eq!(loaded.tickets[2].column, Column::Review);
        assert_eq!(loaded.tickets[3].ticket_type, TicketType::Docs);
        assert_eq!(loaded.tickets[3].column, Column::Done);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn portal_bug_fields_roundtrip() {
        let dir = temp_db_dir();

        let conn = open(&dir).unwrap();
        let board = KanbanBoard {
            project_name: "Portal".to_string(),
            tickets: vec![Ticket {
                id: "GG-001".into(),
                title: "Bug".into(),
                slug: "bug".into(),
                ticket_type: TicketType::Bugfix,
                column: Column::Backlog,
                description: String::new(),
                prio: None,
                created_at: None,
                started_at: None,
                review_at: None,
                done_at: None,
                has_changes: None,
                branch: None,
                tokens_used: None,
                cost_usd: None,
                model_used: None,
                comments: None,
                portal_bug_id: Some(42),
                portal_bug_url: Some("https://portal.example.com/bugs/42".to_string()),
            }],
            next_ticket_id: 2,
        };

        save_board(&conn, &board).unwrap();
        let loaded = load_board(&conn).unwrap();

        assert_eq!(loaded.tickets[0].portal_bug_id, Some(42));
        assert_eq!(
            loaded.tickets[0].portal_bug_url,
            Some("https://portal.example.com/bugs/42".to_string())
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activity_prune_at_limit() {
        let dir = temp_db_dir();
        let conn = open(&dir).unwrap();

        // Insert more than MAX_ACTIVITY (500) entries
        for i in 0..510 {
            log_activity(
                &conn,
                &format!("action_{i}"),
                Some("GG-001"),
                Some("Test"),
                None,
            );
        }

        // Should be pruned to 500
        let all = get_activity(&conn, 1000);
        assert!(
            all.len() <= 500,
            "Expected at most 500 entries, got {}",
            all.len()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
