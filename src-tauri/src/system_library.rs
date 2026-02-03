use anyhow::{Context, Result};
use serde::Deserialize;
use tauri::AppHandle;
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
            persistent_id: self.persistent_id,
            file_path: self.file_path,
            artist: self.artist,
            title: self.title,
            album: self.album,
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
        })
        .collect();

    Ok((tracks, playlists))
}
