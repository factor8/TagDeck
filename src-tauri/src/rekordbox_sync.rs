//! Background "Rekordbox Live Sync": keeps a fixed rekordbox.xml current.

use crate::commands::AppState;
use crate::db::Database;
use crate::models::{Playlist, Track};
use serde::Serialize;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

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

#[derive(Debug, Clone, Serialize)]
pub struct RekordboxLiveConfig {
    pub enabled: bool,
    pub path: Option<String>,
    pub debounce_secs: u64,
}

pub fn clamp_debounce(secs: u64) -> u64 {
    secs.clamp(1, 15)
}

pub fn read_live_config(db: &Database) -> RekordboxLiveConfig {
    let enabled = db.get_config("rekordbox_live_enabled").ok().flatten().as_deref() == Some("true");
    let path = db.get_config("rekordbox_xml_path").ok().flatten();
    let debounce_secs = db
        .get_config("rekordbox_debounce_secs")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u64>().ok())
        .map(clamp_debounce)
        .unwrap_or(3);
    RekordboxLiveConfig { enabled, path, debounce_secs }
}

#[tauri::command]
pub fn get_rekordbox_live_config(state: State<AppState>) -> Result<RekordboxLiveConfig, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    Ok(read_live_config(&db))
}

#[tauri::command]
pub fn set_rekordbox_live_enabled(state: State<AppState>, enabled: bool) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.set_config("rekordbox_live_enabled", if enabled { "true" } else { "false" })
            .map_err(|e| e.to_string())?;
    }
    if enabled {
        state.rekordbox_dirty.mark();
    }
    Ok(())
}

#[tauri::command]
pub fn set_rekordbox_live_path(state: State<AppState>, path: String) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.set_config("rekordbox_xml_path", &path).map_err(|e| e.to_string())?;
    }
    state.rekordbox_dirty.mark();
    Ok(())
}

#[tauri::command]
pub fn set_rekordbox_debounce_secs(state: State<AppState>, secs: u64) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.set_config("rekordbox_debounce_secs", &clamp_debounce(secs).to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_rekordbox_sync_status(state: State<AppState>) -> RekordboxSyncStatus {
    state
        .rekordbox_status
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
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

/// Idle ceiling for the flush thread: even with no dirty pings, re-settle
/// periodically as a backstop against a missed/coalesced signal.
const BACKSTOP: Duration = Duration::from_secs(300);

fn set_status(app: &AppHandle, status: RekordboxSyncStatus) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut s) = state.rekordbox_status.lock() {
            *s = status.clone();
        }
    }
    let _ = app.emit("rekordbox-sync-status", status);
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// One settle: read config; if enabled+path, snapshot the DB (lock → copy →
/// drop), build+write via flush_once, and publish status. Never holds the DB
/// lock across the file write.
pub(crate) fn settle(app: &AppHandle, last_hash: &mut Option<u64>) {
    let state = match app.try_state::<AppState>() {
        Some(s) => s,
        None => return,
    };

    let (path, tracks, playlists) = {
        let db = match state.db.lock() {
            Ok(db) => db,
            Err(_) => return,
        };
        let cfg = read_live_config(&db);
        if !cfg.enabled || cfg.path.is_none() {
            drop(db);
            set_status(app, RekordboxSyncStatus::default()); // "disabled"
            return;
        }
        let tracks: Vec<Track> = db
            .get_all_tracks()
            .unwrap_or_default()
            .into_iter()
            .filter(|t| !t.is_ghost())
            .collect();
        let playlists: Vec<(Playlist, Vec<i64>)> = db
            .get_playlists()
            .unwrap_or_default()
            .into_iter()
            .map(|p| {
                let ids = db.get_playlist_track_ids(p.id).unwrap_or_default();
                (p, ids)
            })
            .collect();
        (cfg.path.unwrap(), tracks, playlists)
    }; // DB lock dropped here

    let n_tracks = tracks.len();
    let n_playlists = playlists.len();

    set_status(app, RekordboxSyncStatus {
        state: "writing".to_string(), last_written_at: None, last_error: None,
        tracks: n_tracks, playlists: 0,
    });

    let status = match flush_once(
        env!("CARGO_PKG_VERSION"), &tracks, &playlists, std::path::Path::new(&path), last_hash,
    ) {
        FlushOutcome::Written { tracks, playlists } => RekordboxSyncStatus {
            state: "up_to_date".to_string(), last_written_at: Some(now_secs()),
            last_error: None, tracks, playlists,
        },
        FlushOutcome::Unchanged => RekordboxSyncStatus {
            state: "up_to_date".to_string(), last_written_at: Some(now_secs()),
            last_error: None, tracks: n_tracks, playlists: n_playlists,
        },
        FlushOutcome::Error(e) => RekordboxSyncStatus {
            state: "error".to_string(), last_written_at: None, last_error: Some(e),
            tracks: 0, playlists: 0,
        },
    };
    set_status(app, status);
}

/// Public entry: run the debounced flush loop on a background thread. Idles
/// on `recv_timeout(BACKSTOP)`; a ping debounce-drains (coalescing a burst
/// into one settle) using the live `debounce_secs` config before settling.
pub fn start_rekordbox_sync(app: AppHandle, rx: Receiver<()>) {
    std::thread::spawn(move || {
        let mut last_hash: Option<u64> = None;
        loop {
            match rx.recv_timeout(BACKSTOP) {
                Ok(()) => {
                    let debounce = match app.try_state::<AppState>() {
                        Some(state) => state
                            .db
                            .lock()
                            .map(|db| Duration::from_secs(read_live_config(&db).debounce_secs))
                            .unwrap_or(Duration::from_secs(3)),
                        None => Duration::from_secs(3),
                    };
                    loop {
                        match rx.recv_timeout(debounce) {
                            Ok(()) => continue,
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    settle(&app, &mut last_hash);
                }
                Err(RecvTimeoutError::Timeout) => settle(&app, &mut last_hash), // backstop
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    });
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

    #[test]
    fn debounce_clamps_to_range() {
        assert_eq!(clamp_debounce(0), 1);
        assert_eq!(clamp_debounce(3), 3);
        assert_eq!(clamp_debounce(999), 15);
    }

    fn mk_track(id: i64, path: &str) -> Track {
        Track {
            id,
            persistent_id: format!("TD-{}", id),
            file_path: path.to_string(),
            artist: Some("Artist & Co".to_string()),
            title: Some(format!("Track {}", id)),
            album: None,
            genre: None,
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
            is_smart: false,
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
