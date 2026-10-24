use anyhow::{Context, Result};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;

use crate::models::{Track, Playlist};

#[derive(Debug, Deserialize)]
struct ExternalPlaylist {
    pub persistent_id: String,
    #[serde(default)]
    pub parent_persistent_id: Option<String>,
    pub name: String,
    pub is_folder: bool,
    pub track_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct LibraryExport {
    tracks: Vec<ExternalTrack>,
    playlists: Vec<ExternalPlaylist>,
}

#[derive(Debug, Deserialize)]
struct ExternalTrack {
    pub persistent_id: String,
    pub file_path: String,
    pub artist: Option<String>,
    pub title: Option<String>,
    pub album: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    pub comment_raw: Option<String>,
    pub grouping_raw: Option<String>,
    pub duration_secs: f64,
    pub format: String,
    pub size_bytes: i64,
    pub bit_rate: i64,
    pub modified_date: i64,
    pub rating: i64,
    pub date_added: i64,
    pub bpm: i64,
}

impl ExternalTrack {
    fn into_track(self) -> Track {
        Track {
            id: 0, // Auto-increment ID, set to 0 for new non-DB instances
            itunes_pid: Some(self.persistent_id.clone()),
            persistent_id: self.persistent_id,
            file_path: self.file_path,
            artist: self.artist,
            title: self.title,
            album: self.album,
            genre: self.genre,
            comment_raw: self.comment_raw,
            grouping_raw: self.grouping_raw,
            duration_secs: self.duration_secs,
            format: self.format,
            size_bytes: self.size_bytes,
            bit_rate: self.bit_rate,
            modified_date: self.modified_date,
            rating: self.rating,
            date_added: self.date_added,
            bpm: self.bpm,
            missing: false,
            unlinked_at: None,
            source: "local".to_string(),
            spotify_id: None,
        }
    }
}

pub async fn fetch_system_library(app: &AppHandle) -> Result<(Vec<Track>, Vec<Playlist>)> {
    let output = app.shell()
        .sidecar("fetch-library")
        .context("Failed to create sidecar command")?
        .output()
        .await
        .context("Failed to execute fetch-library sidecar")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!("fetch-library binary failed: {}", stderr));
    }

    let json_str = String::from_utf8(output.stdout)
        .context("Failed to parse binary output as UTF-8")?;

    let library_export: LibraryExport = serde_json::from_str(&json_str)
        .context("Failed to parse JSON output from fetch-library")?;

    let tracks = library_export.tracks
        .into_iter()
        .map(|t| t.into_track())
        .collect();

    let playlists = library_export.playlists
        .into_iter()
        .map(|p| Playlist {
            id: 0,
            persistent_id: p.persistent_id,
            parent_persistent_id: p.parent_persistent_id,
            name: p.name,
            is_folder: p.is_folder,
            track_ids: Some(p.track_ids),
            origin: "itunes".to_string(),
            itunes_sync_enabled: false,
            description: None,
            color: None,
            sort_position: 0,
            created_at: 0,
            updated_at: 0,
            spotify_playlist_id: None,
            spotify_snapshot_id: None,
            is_smart: false,
        })
        .collect();

    Ok((tracks, playlists))
}

const GENRE_BACKFILL_KEY: &str = "genre_backfill_done";

/// One-time fill of the `genre` column for libraries imported before TagDeck
/// stored genres. Reads the whole Music.app library once via the sidecar and
/// sets genre on linked tracks that still have none (see
/// `Database::backfill_genres_by_itunes_pid`), then flags the library so this
/// never runs again. Emits "genre-backfill-completed" so the UI refreshes.
pub fn backfill_genres_from_music(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<crate::commands::AppState>();
        let log = |level: &str, msg: &str| {
            app.state::<crate::logging::LogState>().add_log(level, msg, &app);
        };
        {
            let Ok(db) = state.db.lock() else { return };
            if db.get_config(GENRE_BACKFILL_KEY).ok().flatten().is_some() {
                return;
            }
            let linked: i64 = db.conn
                .query_row("SELECT COUNT(*) FROM tracks WHERE itunes_pid IS NOT NULL", [], |r| r.get(0))
                .unwrap_or(0);
            if linked == 0 {
                let _ = db.set_config(GENRE_BACKFILL_KEY, "1");
                return;
            }
        }
        if !crate::apple_music::is_apple_music_available() {
            // Try again next launch; nothing to read from yet.
            return;
        }
        let tracks = match fetch_system_library(&app).await {
            Ok((tracks, _)) => tracks,
            Err(e) => {
                log("WARN", &format!("Genre backfill: could not read the Music app library: {}", e));
                return;
            }
        };
        let genres: Vec<(String, String)> = tracks
            .into_iter()
            .filter_map(|t| Some((t.itunes_pid?, t.genre?)))
            .filter(|(_, g)| !g.is_empty())
            .collect();
        let changed = {
            let Ok(db) = state.db.lock() else { return };
            match db.backfill_genres_by_itunes_pid(&genres) {
                Ok(n) => {
                    let _ = db.set_config(GENRE_BACKFILL_KEY, "1");
                    n
                }
                Err(e) => {
                    log("ERROR", &format!("Genre backfill failed: {}", e));
                    return;
                }
            }
        };
        log("INFO", &format!("Genre backfill: filled genre on {} of {} linked tracks from Music.app", changed, genres.len()));
        if changed > 0 {
            state.rekordbox_dirty.mark();
            let _ = app.emit("genre-backfill-completed", serde_json::json!({ "updated": changed }));
        }
    });
}
