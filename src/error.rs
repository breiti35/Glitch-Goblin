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
            AppError::NoProjectSelected => write!(f, "Kein Projekt ausgewählt"),
            AppError::FileRead { path, cause } => {
                write!(f, "Datei '{path}' konnte nicht gelesen werden: {cause}")
            }
            AppError::FileWrite { path, cause } => {
                write!(f, "Datei '{path}' konnte nicht geschrieben werden: {cause}")
            }
            AppError::Serialize(e) => write!(f, "Serialisierungsfehler: {e}"),
            AppError::Deserialize(e) => write!(f, "Deserialisierungsfehler: {e}"),
            AppError::NetworkRequest(e) => write!(f, "Netzwerkfehler: {e}"),
            AppError::InvalidInput(e) => write!(f, "Ungültige Eingabe: {e}"),
            AppError::PathTraversal(e) => write!(f, "Ungültiger Pfad: {e}"),
            AppError::Other(e) => write!(f, "{e}"),
        }
    }
}

impl From<AppError> for String {
    fn from(e: AppError) -> String {
        e.to_string()
    }
}
