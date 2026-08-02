//! Background "Rekordbox Live Sync": keeps a fixed rekordbox.xml current.

use serde::Serialize;
use std::sync::mpsc::{channel, Receiver, Sender};

#[derive(Clone)]
pub struct RekordboxDirtySignal {
    tx: Sender<()>,
}

impl RekordboxDirtySignal {
    pub fn new() -> (Self, Receiver<()>) {
        let (tx, rx) = channel();
        (Self { tx }, rx)
    }
    /// Non-blocking ping; a dropped receiver is ignored.
    pub fn mark(&self) {
        let _ = self.tx.send(());
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RekordboxSyncStatus {
    pub state: String,
    pub last_written_at: Option<i64>,
    pub last_error: Option<String>,
    pub tracks: usize,
    pub playlists: usize,
}

impl Default for RekordboxSyncStatus {
    fn default() -> Self {
        Self {
            state: "disabled".to_string(),
            last_written_at: None,
            last_error: None,
            tracks: 0,
            playlists: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_delivers_ping() {
        let (sig, rx) = RekordboxDirtySignal::new();
        sig.mark();
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn status_defaults_to_disabled() {
        assert_eq!(RekordboxSyncStatus::default().state, "disabled");
    }
}
