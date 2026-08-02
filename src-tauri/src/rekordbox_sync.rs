//! Background "Rekordbox Live Sync": keeps a fixed rekordbox.xml current.

use crate::models::{Playlist, Track};
use serde::Serialize;
use std::path::Path;
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

pub enum FlushOutcome {
    Written { tracks: usize, playlists: usize },
    Unchanged,
    Error(String),
}

fn hash_str(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// Build the XML and write it atomically to `dest` only if it changed since
/// the last write. Callers pass an already-collected snapshot — this never
/// touches the DB lock.
pub fn flush_once(
    app_version: &str,
    tracks: &[Track],
    playlists: &[(Playlist, Vec<i64>)],
    dest: &Path,
    last_hash: &mut Option<u64>,
) -> FlushOutcome {
    let (xml, stats) = crate::rekordbox::build_rekordbox_xml(tracks, playlists, app_version);
    let h = hash_str(&xml);
    if *last_hash == Some(h) {
        return FlushOutcome::Unchanged;
    }
    match crate::fs_atomic::atomic_write(dest, xml.as_bytes()) {
        Ok(()) => {
            *last_hash = Some(h);
            FlushOutcome::Written {
                tracks: stats.tracks,
                playlists: stats.playlists,
            }
        }
        Err(e) => FlushOutcome::Error(format!("Failed to write {}: {}", dest.display(), e)),
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

    fn mk_track(id: i64, path: &str) -> Track {
        Track {
            id,
            persistent_id: format!("TD-{}", id),
            file_path: path.to_string(),
            artist: Some("Artist & Co".to_string()),
            title: Some(format!("Track {}", id)),
            album: None,
            comment_raw: Some("#house #\"peak\"".to_string()),
            grouping_raw: None,
            duration_secs: 245.6,
            format: "mp3".to_string(),
            size_bytes: 1000,
            bit_rate: 320,
            modified_date: 0,
            rating: 80,
            date_added: 1_700_000_000,
            bpm: 128,
            missing: false,
            itunes_pid: None,
            unlinked_at: None,
            source: "local".to_string(),
            spotify_id: None,
        }
    }

    fn mk_playlist(id: i64, name: &str) -> Playlist {
        Playlist {
            id,
            persistent_id: format!("TD-{}", id),
            parent_persistent_id: None,
            name: name.to_string(),
            is_folder: false,
            track_ids: None,
            origin: "tagdeck".to_string(),
            itunes_sync_enabled: false,
            description: None,
            color: None,
            sort_position: 0,
            created_at: 0,
            updated_at: 0,
            spotify_playlist_id: None,
            spotify_snapshot_id: None,
        }
    }

    #[test]
    fn flush_writes_then_skips_when_unchanged() {
        let dir = std::env::temp_dir().join(format!("tagdeck-flush-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let dest = dir.join("rekordbox.xml");

        let tracks = vec![mk_track(1, "/x/one.mp3")];
        let playlists = vec![(mk_playlist(11, "Set"), vec![1])];
        let mut last: Option<u64> = None;

        match flush_once("0.0.0", &tracks, &playlists, &dest, &mut last) {
            FlushOutcome::Written { tracks, playlists } => {
                assert_eq!(tracks, 1);
                assert_eq!(playlists, 1);
            }
            _ => panic!("expected Written"),
        }
        assert!(dest.exists());
        assert!(last.is_some());

        // Same inputs → no rewrite.
        assert!(matches!(
            flush_once("0.0.0", &tracks, &playlists, &dest, &mut last),
            FlushOutcome::Unchanged
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
