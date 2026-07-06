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
            let name = if pl.name.is_empty() {
                db.get_spotify_playlist_name(&pl.id).map_err(|e| e.to_string())?.unwrap_or_default()
            } else {
                pl.name.clone()
            };
            db.upsert_spotify_playlist(&pl.id, &name, &pl.snapshot_id, &track_ids)
                .map_err(|e| e.to_string())?;
        }
        report.playlists += 1;
    }
    Ok(report)
}

#[derive(Debug, Default, Serialize)]
pub struct SyncReport {
    pub checked: usize,
    pub updated: usize,
    pub ghosts_removed: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

/// Re-sync every imported Spotify playlist whose snapshot_id changed,
/// then GC untagged orphan ghosts.
pub async fn sync_all(
    spotify: &SpotifyState,
    client_id: &str,
    db: &std::sync::Mutex<Database>,
) -> Result<SyncReport, String> {
    let imported = {
        let db = db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.get_spotify_playlists().map_err(|e| e.to_string())?
    };
    let mut report = SyncReport { checked: imported.len(), ..Default::default() };
    if imported.is_empty() {
        return Ok(report);
    }
    // One playlist-list call covers snapshot comparison for all imported lists
    // (and playlist renames); fall back to per-playlist snapshot fetch for any
    // imported playlist not in the listing (e.g. followed playlist unfollowed).
    let live = client::list_my_playlists(spotify, client_id).await?;
    let mut to_update = Vec::new();
    for (_db_id, sp_id, snapshot) in &imported {
        match live.iter().find(|p| &p.id == sp_id) {
            Some(p) if Some(p.snapshot_id.as_str()) != snapshot.as_deref() => to_update.push(p.clone()),
            Some(_) => {}
            None => {
                if let Ok(snap) = client::get_playlist_snapshot(spotify, client_id, sp_id).await {
                    if Some(snap.as_str()) != snapshot.as_deref() {
                        // Minimal summary; name/count refreshed on import.
                        to_update.push(client::SpotifyPlaylistSummary {
                            id: sp_id.clone(),
                            name: String::new(),
                            snapshot_id: snap,
                            track_count: 0,
                            owner_name: String::new(),
                        });
                    }
                }
            }
        }
    }
    // Import each changed playlist independently so one failure (rate limit,
    // transient network) doesn't abort the rest of the batch or skip GC below.
    for pl in &to_update {
        match import_playlists(spotify, client_id, db, vec![pl.clone()]).await {
            Ok(r) => report.updated += r.playlists,
            Err(e) => {
                report.failed += 1;
                report.errors.push(format!("{}: {}", pl.name, e));
            }
        }
    }
    {
        let db = db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        report.ghosts_removed = db.gc_orphan_ghosts().map_err(|e| e.to_string())?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_report_serializes_failed_and_errors() {
        let report = SyncReport {
            checked: 3,
            updated: 2,
            ghosts_removed: 1,
            failed: 1,
            errors: vec!["Bad Playlist: rate limited".to_string()],
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"failed\":1"));
        assert!(json.contains("\"errors\":[\"Bad Playlist: rate limited\"]"));
    }
}
