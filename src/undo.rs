use crate::kanban::Ticket;

const MAX_UNDO_STACK: usize = 50;

/// Beschreibt eine rückgängig machbare Aktion auf dem Kanban-Board.
#[derive(Debug, Clone)]
pub enum UndoAction {
    /// Ticket wurde erstellt — Undo entfernt es.
    CreateTicket { ticket_id: String },
    /// Ticket wurde gelöscht — Undo stellt es wieder her.
    DeleteTicket { ticket: Ticket, index: usize },
    /// Ticket wurde verschoben — Undo stellt den alten Zustand wieder her.
    MoveTicket { old_ticket: Ticket },
    /// Ticket wurde bearbeitet — Undo stellt den alten Zustand wieder her.
    UpdateTicket { old_ticket: Ticket },
    /// Ticket wurde archiviert — Undo stellt den alten Zustand wieder her.
    ArchiveTicket { old_ticket: Ticket },
}

impl UndoAction {
    /// Kurzbeschreibung der Aktion (für Toast-Nachrichten).
    pub fn description(&self) -> String {
        match self {
            UndoAction::CreateTicket { ticket_id } => {
                format!("Ticket {} erstellt", ticket_id)
            }
            UndoAction::DeleteTicket { ticket, .. } => {
                format!("Ticket {} gelöscht", ticket.id)
            }
            UndoAction::MoveTicket { old_ticket } => {
                format!("Ticket {} verschoben", old_ticket.id)
            }
            UndoAction::UpdateTicket { old_ticket } => {
                format!("Ticket {} bearbeitet", old_ticket.id)
            }
            UndoAction::ArchiveTicket { old_ticket } => {
                format!("Ticket {} archiviert", old_ticket.id)
            }
        }
    }
}

/// Eintrag im Undo/Redo-Stack. Speichert die technische Aktion und eine
/// menschenlesbare Beschreibung der *ursprünglichen* Aktion, damit der
/// Redo-Tooltip nicht invertiert angezeigt wird.
#[derive(Debug, Clone)]
pub struct UndoEntry {
    pub action: UndoAction,
    pub label: String,
}

/// Verwaltet Undo- und Redo-Stacks für Ticket-Aktionen.
#[derive(Debug, Default)]
pub struct UndoManager {
    undo_stack: Vec<UndoEntry>,
    redo_stack: Vec<UndoEntry>,
}

impl UndoManager {
    pub fn new() -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    /// Fügt eine Aktion zum Undo-Stack hinzu und leert den Redo-Stack.
    pub fn push(&mut self, action: UndoAction) {
        let label = action.description();
        self.undo_stack.push(UndoEntry { action, label });
        if self.undo_stack.len() > MAX_UNDO_STACK {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
    }

    /// Nimmt den letzten Eintrag vom Undo-Stack.
    pub fn pop_undo(&mut self) -> Option<UndoEntry> {
        self.undo_stack.pop()
    }

    /// Nimmt den letzten Eintrag vom Redo-Stack.
    pub fn pop_redo(&mut self) -> Option<UndoEntry> {
        self.redo_stack.pop()
    }

    /// Schiebt einen Eintrag auf den Redo-Stack (nach einem Undo).
    /// Das Label bleibt erhalten, damit der Tooltip korrekt ist.
    pub fn record_for_redo(&mut self, reverse_action: UndoAction, original_label: String) {
        self.redo_stack.push(UndoEntry {
            action: reverse_action,
            label: original_label,
        });
        if self.redo_stack.len() > MAX_UNDO_STACK {
            self.redo_stack.remove(0);
        }
    }

    /// Schiebt einen Eintrag auf den Undo-Stack ohne Redo zu leeren (nach einem Redo).
    pub fn record_for_undo_only(&mut self, reverse_action: UndoAction, original_label: String) {
        self.undo_stack.push(UndoEntry {
            action: reverse_action,
            label: original_label,
        });
        if self.undo_stack.len() > MAX_UNDO_STACK {
            self.undo_stack.remove(0);
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    /// Beschreibung der nächsten rückgängig machbaren Aktion.
    pub fn undo_description(&self) -> Option<String> {
        self.undo_stack.last().map(|e| e.label.clone())
    }

    /// Beschreibung der nächsten wiederherstellbaren Aktion.
    pub fn redo_description(&self) -> Option<String> {
        self.redo_stack.last().map(|e| e.label.clone())
    }

    /// Leert beide Stacks (z.B. bei Projektwechsel).
    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kanban::{Column, TicketType};

    fn test_ticket(id: &str) -> Ticket {
        Ticket {
            id: id.to_string(),
            title: format!("Test {}", id),
            slug: format!("test-{}", id),
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
            archived_at: None,
        }
    }

    #[test]
    fn push_and_pop_undo() {
        let mut mgr = UndoManager::new();
        assert!(!mgr.can_undo());

        mgr.push(UndoAction::CreateTicket {
            ticket_id: "GG-001".into(),
        });
        assert!(mgr.can_undo());
        assert!(!mgr.can_redo());

        let entry = mgr.pop_undo().unwrap();
        assert!(matches!(entry.action, UndoAction::CreateTicket { .. }));
        assert_eq!(entry.label, "Ticket GG-001 erstellt");
        assert!(!mgr.can_undo());
    }

    #[test]
    fn push_clears_redo() {
        let mut mgr = UndoManager::new();
        mgr.push(UndoAction::CreateTicket {
            ticket_id: "GG-001".into(),
        });
        let entry = mgr.pop_undo().unwrap();
        mgr.record_for_redo(entry.action, entry.label);
        assert!(mgr.can_redo());

        // New action should clear redo
        mgr.push(UndoAction::CreateTicket {
            ticket_id: "GG-002".into(),
        });
        assert!(!mgr.can_redo());
    }

    #[test]
    fn undo_description() {
        let mut mgr = UndoManager::new();
        mgr.push(UndoAction::MoveTicket {
            old_ticket: test_ticket("GG-005"),
        });
        assert_eq!(
            mgr.undo_description(),
            Some("Ticket GG-005 verschoben".to_string())
        );
    }

    #[test]
    fn redo_keeps_original_label() {
        let mut mgr = UndoManager::new();
        mgr.push(UndoAction::CreateTicket {
            ticket_id: "GG-001".into(),
        });
        let entry = mgr.pop_undo().unwrap();
        // Redo action is DeleteTicket (the reverse), but label stays "erstellt"
        mgr.record_for_redo(
            UndoAction::DeleteTicket {
                ticket: test_ticket("GG-001"),
                index: 0,
            },
            entry.label,
        );
        assert_eq!(
            mgr.redo_description(),
            Some("Ticket GG-001 erstellt".to_string())
        );
    }

    #[test]
    fn max_stack_size() {
        let mut mgr = UndoManager::new();
        for i in 0..60 {
            mgr.push(UndoAction::CreateTicket {
                ticket_id: format!("GG-{:03}", i),
            });
        }
        // Should be capped at MAX_UNDO_STACK
        let mut count = 0;
        while mgr.pop_undo().is_some() {
            count += 1;
        }
        assert_eq!(count, 50);
    }

    #[test]
    fn clear_stacks() {
        let mut mgr = UndoManager::new();
        mgr.push(UndoAction::CreateTicket {
            ticket_id: "GG-001".into(),
        });
        let entry = mgr.pop_undo().unwrap();
        mgr.record_for_redo(entry.action, entry.label);
        mgr.push(UndoAction::CreateTicket {
            ticket_id: "GG-002".into(),
        });

        mgr.clear();
        assert!(!mgr.can_undo());
        assert!(!mgr.can_redo());
    }

    #[test]
    fn delete_ticket_undo_description() {
        let action = UndoAction::DeleteTicket {
            ticket: test_ticket("GG-010"),
            index: 3,
        };
        assert_eq!(action.description(), "Ticket GG-010 gelöscht");
    }

    #[test]
    fn record_for_undo_only_does_not_clear_redo() {
        let mut mgr = UndoManager::new();
        mgr.push(UndoAction::CreateTicket {
            ticket_id: "GG-001".into(),
        });
        let entry = mgr.pop_undo().unwrap();
        mgr.record_for_redo(entry.action, entry.label);
        assert!(mgr.can_redo());

        // record_for_undo_only should NOT clear redo
        mgr.record_for_undo_only(
            UndoAction::CreateTicket {
                ticket_id: "GG-002".into(),
            },
            "Ticket GG-002 erstellt".into(),
        );
        assert!(mgr.can_redo());
        assert!(mgr.can_undo());
    }
}
