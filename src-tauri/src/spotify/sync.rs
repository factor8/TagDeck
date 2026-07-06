use serde::Serialize;

use super::client;
use super::SpotifyState;
use crate::db::Database;

#[derive(Debug, Default, Serialize)]
pub struct ImportReport {
    pub playlists: usize,
    pub tracks_added: usize,
    pub tracks_linked: usize,
}

/// Import (or re-import) the given Spotify playlists: fetch items, upsert
/// ghosts (deduped on spotify_id), and replace playlist membership.
pub async fn import_playlists(
    spotify: &SpotifyState,
    client_id: &str,
    db: &std::sync::Mutex<Database>,
    playlists: Vec<client::SpotifyPlaylistSummary>,
) -> Result<ImportReport, String> {
    let mut report = ImportReport::default();
    for pl in playlists {
        let items = client::get_playlist_items(spotify, client_id, &pl.id).await?;
        let mut track_ids = Vec::with_capacity(items.len());
        {
            let db = db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            for meta in &items {
                let pre_existing = db.find_track_by_spotify_id(&meta.id).map_err(|e| e.to_string())?;
                let id = db
                    .upsert_ghost_track(&meta.id, &meta.uri, &meta.artist, &meta.title, &meta.album, meta.duration_secs)
                    .map_err(|e| e.to_string())?;
                if pre_existing.is_none() {
                    report.tracks_added += 1;
                } else {
                    report.tracks_linked += 1;
                }
                track_ids.push(id);
            }
            db.upsert_spotify_playlist(&pl.id, &pl.name, &pl.snapshot_id, &track_ids)
                .map_err(|e| e.to_string())?;
        }
        report.playlists += 1;
    }
    Ok(report)
}
