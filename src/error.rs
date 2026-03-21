use std::fmt;

/// Structured error type for Kanban Runner.
///
/// Commands still return `Result<T, String>` (no breaking change) — `AppError`
/// converts to `String` via the `From` impl so `?` works directly in those
/// functions.
#[derive(Debug)]
pub enum AppError {
    ConfigLoad(String),
    ConfigSave(String),
    BoardLoad(String),
    BoardSave(String),
    TicketNotFound(String),
    GitCommand(String),
    GitMerge(String),
    GitCheckout(String),
    GitConflict(String),
    GitOperationInProgress(String),
    NoGitRepo,
    NoBranch(String),
    TerminalSpawn(String),
    TerminalNotFound(String),
    ProjectNotFound(String),
    NoProjectSelected,
    FileRead { path: String, cause: String },
    FileWrite { path: String, cause: String },
    Serialize(String),
    Deserialize(String),
    NetworkRequest(String),
    InvalidInput(String),
    PathTraversal(String),
    Other(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::ConfigLoad(e) => write!(f, "Konfiguration konnte nicht geladen werden: {e}"),
            AppError::ConfigSave(e) => {
                write!(f, "Konfiguration konnte nicht gespeichert werden: {e}")
            }
            AppError::BoardLoad(e) => write!(f, "Board konnte nicht geladen werden: {e}"),
            AppError::BoardSave(e) => {
                write!(f, "Board konnte nicht gespeichert werden: {e}")
            }
            AppError::TicketNotFound(id) => write!(f, "Ticket '{id}' nicht gefunden"),
            AppError::GitCommand(e) => write!(f, "Git-Fehler: {e}"),
            AppError::GitMerge(e) => write!(f, "Git merge fehlgeschlagen: {e}"),
            AppError::GitCheckout(e) => write!(f, "Git checkout fehlgeschlagen: {e}"),
            AppError::GitConflict(e) => write!(f, "Merge-Konflikt: {e}"),
            AppError::GitOperationInProgress(op) => {
                write!(f, "Git-Operation '{op}' ist noch in Arbeit")
            }
            AppError::NoGitRepo => write!(f, "Kein Git-Repository gefunden"),
            AppError::NoBranch(e) => write!(f, "Kein Branch vorhanden: {e}"),
            AppError::TerminalSpawn(e) => {
                write!(f, "Terminal konnte nicht gestartet werden: {e}")
            }
            AppError::TerminalNotFound(id) => write!(f, "Terminal '{id}' nicht gefunden"),
            AppError::ProjectNotFound(n) => write!(f, "Projekt '{n}' nicht gefunden"),
            AppError::NoProjectSelected => write!(f, "Kein Projekt ausgew\u{00e4}hlt"),
            AppError::FileRead { path, cause } => {
                write!(f, "Datei '{path}' konnte nicht gelesen werden: {cause}")
            }
            AppError::FileWrite { path, cause } => {
                write!(f, "Datei '{path}' konnte nicht geschrieben werden: {cause}")
            }
            AppError::Serialize(e) => write!(f, "Serialisierungsfehler: {e}"),
            AppError::Deserialize(e) => write!(f, "Deserialisierungsfehler: {e}"),
            AppError::NetworkRequest(e) => write!(f, "Netzwerkfehler: {e}"),
            AppError::InvalidInput(e) => write!(f, "Ung\u{00fc}ltige Eingabe: {e}"),
            AppError::PathTraversal(e) => write!(f, "Ung\u{00fc}ltiger Pfad: {e}"),
            AppError::Other(e) => write!(f, "{e}"),
        }
    }
}

impl From<AppError> for String {
    fn from(e: AppError) -> String {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display_ticket_not_found() {
        let e = AppError::TicketNotFound("GG-001".into());
        assert!(e.to_string().contains("GG-001"));
        assert!(e.to_string().contains("nicht gefunden"));
    }

    #[test]
    fn error_display_git_conflict() {
        let e = AppError::GitConflict("branch-x".into());
        assert!(e.to_string().contains("Konflikt"));
        assert!(e.to_string().contains("branch-x"));
    }

    #[test]
    fn error_display_no_git_repo() {
        let e = AppError::NoGitRepo;
        assert!(e.to_string().contains("Git-Repository"));
    }

    #[test]
    fn error_display_git_operation_in_progress() {
        let e = AppError::GitOperationInProgress("rebase".into());
        assert!(e.to_string().contains("rebase"));
        assert!(e.to_string().contains("in Arbeit"));
    }

    #[test]
    fn error_to_string_conversion() {
        let e = AppError::NoProjectSelected;
        let s: String = e.into();
        assert!(s.contains("Kein Projekt"));
    }

    #[test]
    fn error_display_config_load() {
        let e = AppError::ConfigLoad("file missing".into());
        let s = e.to_string();
        assert!(s.contains("Konfiguration"));
        assert!(s.contains("geladen"));
        assert!(s.contains("file missing"));
    }

    #[test]
    fn error_display_config_save() {
        let e = AppError::ConfigSave("disk full".into());
        let s = e.to_string();
        assert!(s.contains("gespeichert"));
        assert!(s.contains("disk full"));
    }

    #[test]
    fn error_display_board_load() {
        let e = AppError::BoardLoad("parse error".into());
        assert!(e.to_string().contains("Board"));
        assert!(e.to_string().contains("parse error"));
    }

    #[test]
    fn error_display_file_read() {
        let e = AppError::FileRead {
            path: "/tmp/test.json".into(),
            cause: "not found".into(),
        };
        let s = e.to_string();
        assert!(s.contains("/tmp/test.json"));
        assert!(s.contains("gelesen"));
        assert!(s.contains("not found"));
    }

    #[test]
    fn error_display_file_write() {
        let e = AppError::FileWrite {
            path: "/tmp/out.json".into(),
            cause: "permission denied".into(),
        };
        let s = e.to_string();
        assert!(s.contains("/tmp/out.json"));
        assert!(s.contains("geschrieben"));
    }

    #[test]
    fn error_display_serialize_deserialize() {
        let e = AppError::Serialize("bad data".into());
        assert!(e.to_string().contains("Serialisierungsfehler"));

        let e = AppError::Deserialize("invalid json".into());
        assert!(e.to_string().contains("Deserialisierungsfehler"));
    }

    #[test]
    fn error_display_network() {
        let e = AppError::NetworkRequest("timeout".into());
        assert!(e.to_string().contains("Netzwerkfehler"));
        assert!(e.to_string().contains("timeout"));
    }

    #[test]
    fn error_display_invalid_input() {
        let e = AppError::InvalidInput("empty name".into());
        assert!(e.to_string().contains("Eingabe"));
        assert!(e.to_string().contains("empty name"));
    }

    #[test]
    fn error_display_path_traversal() {
        let e = AppError::PathTraversal("../../../etc/passwd".into());
        assert!(e.to_string().contains("Pfad"));
    }

    #[test]
    fn error_display_terminal_spawn() {
        let e = AppError::TerminalSpawn("PTY failed".into());
        assert!(e.to_string().contains("Terminal"));
        assert!(e.to_string().contains("gestartet"));
    }

    #[test]
    fn error_display_terminal_not_found() {
        let e = AppError::TerminalNotFound("sess-123".into());
        assert!(e.to_string().contains("sess-123"));
    }

    #[test]
    fn error_display_project_not_found() {
        let e = AppError::ProjectNotFound("my-project".into());
        assert!(e.to_string().contains("my-project"));
        assert!(e.to_string().contains("nicht gefunden"));
    }

    #[test]
    fn error_display_git_command() {
        let e = AppError::GitCommand("status failed".into());
        assert!(e.to_string().contains("Git-Fehler"));
    }

    #[test]
    fn error_display_git_merge() {
        let e = AppError::GitMerge("conflict".into());
        assert!(e.to_string().contains("merge fehlgeschlagen"));
    }

    #[test]
    fn error_display_git_checkout() {
        let e = AppError::GitCheckout("dirty tree".into());
        assert!(e.to_string().contains("checkout fehlgeschlagen"));
    }

    #[test]
    fn error_display_no_branch() {
        let e = AppError::NoBranch("main".into());
        assert!(e.to_string().contains("Kein Branch"));
    }

    #[test]
    fn error_display_other() {
        let e = AppError::Other("something went wrong".into());
        assert_eq!(e.to_string(), "something went wrong");
    }

    #[test]
    fn error_debug_format() {
        let e = AppError::NoGitRepo;
        let debug = format!("{:?}", e);
        assert!(debug.contains("NoGitRepo"));
    }
}
