//! Sync Review: a dry-run diff of Music.app vs TagDeck, presented to the user
//! for approval instead of auto-applied. Reuses the same detection logic as
//! `sync_recent_changes` (Phase 0 adds/removes, Phase 1 metadata, Phase 2
//! rating/BPM snapshot, Phase 3 playlists) but `preview_sync` only reads;
//! `apply_sync_changes` applies exactly what the user accepted.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, State};

use crate::apple_music::{
    get_all_music_app_pids, get_changes_since, get_playlist_snapshot, get_snapshot_fields,
    get_tracks_by_persistent_ids, is_apple_music_available, update_track_comment,
    update_track_info as apple_update_track_info, update_track_rating,
};
use crate::commands::AppState;
use crate::file_manager::LibraryConfig;
use crate::models::Playlist;

/// AppleScript fetches full track details one PID at a time; cap how many
/// added tracks we hydrate for display so a first-run preview of a large
/// library stays responsive. `added_total` always reports the true count.
const ADDED_DETAIL_CAP: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct AddedTrack {
    pub itunes_pid: String,
    pub title: Option<String>,
    pub artist: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemovedTrack {
    pub track_id: i64,
    pub itunes_pid: String,
    pub title: Option<String>,
    pub artist: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldChange {
    pub field: String,
    pub old_value: String,
    pub new_value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetadataChange {
    pub itunes_pid: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub changes: Vec<FieldChange>,
    /// The track was also edited in TagDeck while pushes were off — the user
    /// must pick a side instead of auto-applying.
    pub conflict: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RatingBpmChange {
    pub itunes_pid: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub old_rating: i64,
    pub new_rating: i64,
    pub old_bpm: i64,
    pub new_bpm: i64,
    pub conflict: bool,
}

#[derive(Debug, Clone, Serialize)]
pub enum PlaylistChangeType {
    Added,
    Modified,
    Removed,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlaylistChange {
    pub persistent_id: String,
    pub name: String,
    pub change_type: PlaylistChangeType,
}

#[derive(Debug, Default, Serialize)]
pub struct SyncPreview {
    pub added: Vec<AddedTrack>,
    pub added_total: usize,
    pub removed: Vec<RemovedTrack>,
    pub metadata: Vec<MetadataChange>,
    pub rating_bpm: Vec<RatingBpmChange>,
    pub playlists: Vec<PlaylistChange>,
}

#[derive(Debug, Deserialize)]
pub struct SyncDecisions {
    pub import_pids: Vec<String>,
    pub remove_keep_pids: Vec<String>,
    pub remove_delete_pids: Vec<String>,
    /// Metadata items (title/artist/album/comment/grouping) where the iTunes
    /// version should be applied. Kept separate from rating/BPM so a track
    /// with changes in both categories can be resolved differently per
    /// category — applying metadata must not smuggle in a rejected rating.
    pub apply_itunes_metadata_pids: Vec<String>,
    /// Rating/BPM items where the iTunes version should be applied.
    pub apply_itunes_rating_pids: Vec<String>,
    /// Metadata conflicts resolved to the TagDeck side.
    pub keep_tagdeck_metadata_pids: Vec<String>,
    /// Rating/BPM conflicts resolved to the TagDeck side.
    pub keep_tagdeck_rating_pids: Vec<String>,
    pub playlist_pids: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct AppliedSummary {
    pub imported: usize,
    pub unlinked: usize,
    pub deleted: usize,
    pub tracks_applied: usize,
    pub tracks_kept: usize,
    pub playlists_applied: usize,
}

struct SyncGuard<'a>(&'a AtomicBool);
impl<'a> Drop for SyncGuard<'a> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn log(app: &tauri::AppHandle, level: &str, msg: &str) {
    println!("{}", msg);
    app.state::<crate::logging::LogState>().add_log(level, msg, app);
}

#[tauri::command]
pub async fn preview_sync(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    since_timestamp: i64,
) -> Result<SyncPreview, String> {
    if !is_apple_music_available() {
        return Err("Music.app is not available".to_string());
    }
    if state.is_syncing.swap(true, Ordering::SeqCst) {
        return Err("A sync is already in progress — try again in a moment".to_string());
    }
    let _guard = SyncGuard(&state.is_syncing);

    log(&app, "INFO", "Sync Review: computing preview (no changes will be applied)...");

    let mode = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        LibraryConfig::sync_mode(&db)
    };

    let mut preview = SyncPreview::default();

    // --- Adds / removes (mirrors sync Phase 0) ---
    let music_pids = get_all_music_app_pids().map_err(|e| format!("Failed to list Music.app tracks: {}", e))?;
    let (db_pids, dirty_pids, removed_rows, new_pids) = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let db_pids = db.get_all_itunes_pids().map_err(|e| e.to_string())?;
        let dirty_pids = db.get_dirty_itunes_pids().unwrap_or_default();
        let deleted_pids: Vec<String> = db_pids
            .iter()
            .filter(|pid| !music_pids.contains(*pid))
            .cloned()
            .collect();
        let removed_rows = db.get_tracks_by_itunes_pids(&deleted_pids).map_err(|e| e.to_string())?;
        let new_pids: Vec<String> = music_pids
            .iter()
            .filter(|pid| !db_pids.contains(*pid))
            .cloned()
            .collect();
        (db_pids, dirty_pids, removed_rows, new_pids)
    };

    preview.removed = removed_rows
        .iter()
        .map(|t| RemovedTrack {
            track_id: t.id,
            itunes_pid: t.itunes_pid.clone().unwrap_or_default(),
            title: t.title.clone(),
            artist: t.artist.clone(),
        })
        .collect();

    preview.added_total = new_pids.len();
    if !new_pids.is_empty() {
        let detail_pids: Vec<String> = new_pids.iter().take(ADDED_DETAIL_CAP).cloned().collect();
        match get_tracks_by_persistent_ids(&detail_pids) {
            Ok(tracks) => {
                preview.added = tracks
                    .into_iter()
                    .map(|t| AddedTrack {
                        itunes_pid: t.persistent_id,
                        title: t.title,
                        artist: t.artist,
                    })
                    .collect();
            }
            Err(e) => log(&app, "WARN", &format!("Sync Review: could not hydrate added tracks: {}", e)),
        }
    }

    // --- Metadata changes (mirrors sync Phase 1) ---
    // In modes that never push, Music.app's comment/grouping are stale by
    // design (the file is the golden source), so a difference there is noise,
    // not a change — exclude those fields from the diff.
    let include_comment = mode.push_enabled();
    match get_changes_since(since_timestamp) {
        Ok(changed) => {
            let changed_pids: Vec<String> = changed
                .iter()
                .filter(|t| db_pids.contains(&t.persistent_id))
                .map(|t| t.persistent_id.clone())
                .collect();
            let db_rows = {
                let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
                db.get_tracks_by_itunes_pids(&changed_pids).map_err(|e| e.to_string())?
            };
            let by_pid: std::collections::HashMap<String, &crate::models::Track> = db_rows
                .iter()
                .filter_map(|t| t.itunes_pid.as_ref().map(|pid| (pid.clone(), t)))
                .collect();

            for incoming in &changed {
                let Some(existing) = by_pid.get(&incoming.persistent_id) else {
                    continue; // not in TagDeck — covered by the "added" section
                };
                let mut changes = Vec::new();
                let mut field = |name: &str, old: &Option<String>, new: &Option<String>| {
                    if old.as_deref().unwrap_or("") != new.as_deref().unwrap_or("") {
                        changes.push(FieldChange {
                            field: name.to_string(),
                            old_value: old.clone().unwrap_or_default(),
                            new_value: new.clone().unwrap_or_default(),
                        });
                    }
                };
                field("title", &existing.title, &incoming.title);
                field("artist", &existing.artist, &incoming.artist);
                field("album", &existing.album, &incoming.album);
                if include_comment {
                    field("comment", &existing.comment_raw, &incoming.comment_raw);
                    field("grouping", &existing.grouping_raw, &incoming.grouping_raw);
                }
                if !changes.is_empty() {
                    preview.metadata.push(MetadataChange {
                        itunes_pid: incoming.persistent_id.clone(),
                        title: existing.title.clone(),
                        artist: existing.artist.clone(),
                        changes,
                        conflict: dirty_pids.contains(&incoming.persistent_id),
                    });
                }
            }
        }
        Err(e) => log(&app, "WARN", &format!("Sync Review: metadata diff failed (non-fatal): {}", e)),
    }

    // --- Rating / BPM changes (mirrors sync Phase 2) ---
    match get_snapshot_fields() {
        Ok(snapshot) => {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            let db_snapshot = db.get_rating_bpm_snapshot().map_err(|e| e.to_string())?;
            let mut changed: Vec<(String, i64, i64, i64, i64)> = Vec::new();
            for entry in &snapshot {
                if let Some(&(db_rating, db_bpm)) = db_snapshot.get(&entry.persistent_id) {
                    if db_rating != entry.rating || db_bpm != entry.bpm {
                        changed.push((entry.persistent_id.clone(), db_rating, entry.rating, db_bpm, entry.bpm));
                    }
                }
            }
            let pids: Vec<String> = changed.iter().map(|c| c.0.clone()).collect();
            let rows = db.get_tracks_by_itunes_pids(&pids).map_err(|e| e.to_string())?;
            let names: std::collections::HashMap<String, (Option<String>, Option<String>)> = rows
                .iter()
                .filter_map(|t| t.itunes_pid.as_ref().map(|pid| (pid.clone(), (t.title.clone(), t.artist.clone()))))
                .collect();
            for (pid, old_rating, new_rating, old_bpm, new_bpm) in changed {
                let (title, artist) = names.get(&pid).cloned().unwrap_or((None, None));
                preview.rating_bpm.push(RatingBpmChange {
                    conflict: dirty_pids.contains(&pid),
                    itunes_pid: pid,
                    title,
                    artist,
                    old_rating,
                    new_rating,
                    old_bpm,
                    new_bpm,
                });
            }
        }
        Err(e) => log(&app, "WARN", &format!("Sync Review: rating/BPM diff failed (non-fatal): {}", e)),
    }

    // --- Playlist changes (mirrors sync Phase 3) ---
    match get_playlist_snapshot() {
        Ok(music_playlists) => {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            let db_snapshot = db.get_playlist_snapshot().map_err(|e| e.to_string())?;
            let all_track_pids = db.get_all_itunes_pids().map_err(|e| e.to_string())?;

            let music_playlist_pids: std::collections::HashSet<String> =
                music_playlists.iter().map(|p| p.persistent_id.clone()).collect();

            for (pid, (name, _is_folder, _parent, _tracks, sync_enabled)) in &db_snapshot {
                if *sync_enabled && !music_playlist_pids.contains(pid) {
                    preview.playlists.push(PlaylistChange {
                        persistent_id: pid.clone(),
                        name: name.clone(),
                        change_type: PlaylistChangeType::Removed,
                    });
                }
            }

            for mp in &music_playlists {
                let filtered = filter_playlist_tracks(&mp.track_ids, &all_track_pids);
                match db_snapshot.get(&mp.persistent_id) {
                    None => preview.playlists.push(PlaylistChange {
                        persistent_id: mp.persistent_id.clone(),
                        name: mp.name.clone(),
                        change_type: PlaylistChangeType::Added,
                    }),
                    Some((db_name, db_is_folder, db_parent_pid, db_track_ids, sync_enabled)) => {
                        if !sync_enabled {
                            continue;
                        }
                        let mut sorted_filtered = filtered.clone();
                        sorted_filtered.sort();
                        let mut sorted_db = db_track_ids.clone();
                        sorted_db.sort();
                        if db_name != &mp.name
                            || db_is_folder != &mp.is_folder
                            || db_parent_pid != &mp.parent_persistent_id
                            || sorted_db != sorted_filtered
                        {
                            preview.playlists.push(PlaylistChange {
                                persistent_id: mp.persistent_id.clone(),
                                name: mp.name.clone(),
                                change_type: PlaylistChangeType::Modified,
                            });
                        }
                    }
                }
            }
        }
        Err(e) => log(&app, "WARN", &format!("Sync Review: playlist diff failed (non-fatal): {}", e)),
    }

    log(
        &app,
        "INFO",
        &format!(
            "Sync Review preview: {} added, {} removed, {} metadata, {} rating/BPM, {} playlist change(s)",
            preview.added_total,
            preview.removed.len(),
            preview.metadata.len(),
            preview.rating_bpm.len(),
            preview.playlists.len()
        ),
    );

    Ok(preview)
}

#[tauri::command]
pub async fn apply_sync_changes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    decisions: SyncDecisions,
) -> Result<AppliedSummary, String> {
    if state.is_syncing.swap(true, Ordering::SeqCst) {
        return Err("A sync is already in progress — try again in a moment".to_string());
    }
    let _guard = SyncGuard(&state.is_syncing);

    let mode = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        LibraryConfig::sync_mode(&db)
    };

    let mut summary = AppliedSummary::default();

    // Import newly added tracks the user accepted.
    if !decisions.import_pids.is_empty() {
        let tracks = get_tracks_by_persistent_ids(&decisions.import_pids)
            .map_err(|e| format!("Failed to fetch tracks from Music.app: {}", e))?;
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        for track in &tracks {
            let result = if mode.push_enabled() {
                db.insert_track(track).map(|_| ())
            } else {
                db.insert_track_preserving_comment(track).map(|_| ())
            };
            match result {
                Ok(()) => summary.imported += 1,
                Err(e) => log(&app, "ERROR", &format!("Sync Review: import of {} failed: {}", track.persistent_id, e)),
            }
        }
    }

    // Resolve removals per the user's per-track choices.
    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        if !decisions.remove_keep_pids.is_empty() {
            summary.unlinked = db
                .unlink_tracks_by_itunes_pids(&decisions.remove_keep_pids)
                .map_err(|e| e.to_string())?;
        }
        if !decisions.remove_delete_pids.is_empty() {
            summary.deleted = db
                .delete_tracks_by_itunes_pids(&decisions.remove_delete_pids)
                .map_err(|e| e.to_string())?;
        }
    }

    // Accepted iTunes-side changes: fetch the current Music.app truth and
    // apply only the accepted categories. Conflicts resolved this way are no
    // longer dirty.
    let accepted_union: Vec<String> = {
        let mut set = std::collections::HashSet::new();
        decisions
            .apply_itunes_metadata_pids
            .iter()
            .chain(decisions.apply_itunes_rating_pids.iter())
            .filter(|pid| set.insert((*pid).clone()))
            .cloned()
            .collect()
    };
    if !accepted_union.is_empty() {
        let metadata_set: std::collections::HashSet<&String> =
            decisions.apply_itunes_metadata_pids.iter().collect();
        let rating_set: std::collections::HashSet<&String> =
            decisions.apply_itunes_rating_pids.iter().collect();
        let tracks = get_tracks_by_persistent_ids(&accepted_union)
            .map_err(|e| format!("Failed to fetch tracks from Music.app: {}", e))?;
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        for track in &tracks {
            let accept_metadata = metadata_set.contains(&track.persistent_id);
            let accept_rating = rating_set.contains(&track.persistent_id);
            let result = if accept_metadata {
                // The user explicitly chose the iTunes version, so overwriting
                // the comment is correct even in modes that normally preserve
                // it. If the rating change was NOT accepted, keep the DB's
                // current rating/BPM instead of smuggling iTunes' in via the
                // full-row upsert.
                if accept_rating {
                    db.insert_track(track).map(|_| ())
                } else {
                    let mut t = track.clone();
                    if let Some(existing) = db
                        .get_tracks_by_itunes_pids(std::slice::from_ref(&track.persistent_id))
                        .map_err(|e| e.to_string())?
                        .into_iter()
                        .next()
                    {
                        t.rating = existing.rating;
                        t.bpm = existing.bpm;
                    }
                    db.insert_track(&t).map(|_| ())
                }
            } else {
                // Rating/BPM only — targeted update, leave metadata untouched.
                db.update_rating_bpm(&track.persistent_id, track.rating, track.bpm)
            };
            match result {
                Ok(()) => summary.tracks_applied += 1,
                Err(e) => log(&app, "ERROR", &format!("Sync Review: apply of {} failed: {}", track.persistent_id, e)),
            }
        }
        if let Err(e) = db.clear_dirty_by_itunes_pids(&accepted_union) {
            log(&app, "ERROR", &format!("Sync Review: failed to clear dirty flags: {}", e));
        }
    }

    // Conflicts resolved to the TagDeck side: keep our values; when pushes are
    // allowed, also write the kept categories back to Music.app so the two
    // converge.
    let kept_union: Vec<String> = {
        let mut set = std::collections::HashSet::new();
        decisions
            .keep_tagdeck_metadata_pids
            .iter()
            .chain(decisions.keep_tagdeck_rating_pids.iter())
            .filter(|pid| set.insert((*pid).clone()))
            .cloned()
            .collect()
    };
    if !kept_union.is_empty() {
        let metadata_set: std::collections::HashSet<&String> =
            decisions.keep_tagdeck_metadata_pids.iter().collect();
        let rating_set: std::collections::HashSet<&String> =
            decisions.keep_tagdeck_rating_pids.iter().collect();
        let rows = {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            db.get_tracks_by_itunes_pids(&kept_union).map_err(|e| e.to_string())?
        };
        for track in &rows {
            let Some(pid) = track.itunes_pid.as_deref() else { continue };
            if mode.push_enabled() {
                if metadata_set.contains(&pid.to_string()) {
                    if let Err(e) = apple_update_track_info(
                        pid,
                        track.title.as_deref(),
                        track.artist.as_deref(),
                        track.album.as_deref(),
                        None,
                    ) {
                        log(&app, "ERROR", &format!("Sync Review: push of track info for {} failed: {}", pid, e));
                    }
                    if let Err(e) = update_track_comment(pid, track.comment_raw.as_deref().unwrap_or("")) {
                        log(&app, "ERROR", &format!("Sync Review: push of comment for {} failed: {}", pid, e));
                    }
                }
                if rating_set.contains(&pid.to_string()) {
                    if let Err(e) = update_track_rating(pid, track.rating.max(0) as u32) {
                        log(&app, "ERROR", &format!("Sync Review: push of rating for {} failed: {}", pid, e));
                    }
                    if let Err(e) = apple_update_track_info(pid, None, None, None, Some(track.bpm)) {
                        log(&app, "ERROR", &format!("Sync Review: push of BPM for {} failed: {}", pid, e));
                    }
                }
            }
            summary.tracks_kept += 1;
        }
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        if let Err(e) = db.clear_dirty_by_itunes_pids(&kept_union) {
            log(&app, "ERROR", &format!("Sync Review: failed to clear dirty flags: {}", e));
        }
    }

    // Accepted playlist changes: recompute from the live Music.app snapshot
    // (upsert what still exists there, remove what doesn't).
    if !decisions.playlist_pids.is_empty() {
        let music_playlists = get_playlist_snapshot()
            .map_err(|e| format!("Failed to fetch playlists from Music.app: {}", e))?;
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let all_track_pids = db.get_all_itunes_pids().map_err(|e| e.to_string())?;
        for pid in &decisions.playlist_pids {
            if let Some(mp) = music_playlists.iter().find(|p| &p.persistent_id == pid) {
                let playlist = Playlist {
                    id: 0,
                    persistent_id: mp.persistent_id.clone(),
                    parent_persistent_id: mp.parent_persistent_id.clone(),
                    name: mp.name.clone(),
                    is_folder: mp.is_folder,
                    track_ids: Some(filter_playlist_tracks(&mp.track_ids, &all_track_pids)),
                    origin: "itunes".to_string(),
                    itunes_sync_enabled: true,
                    description: None,
                    color: None,
                    sort_position: 0,
                    created_at: 0,
                    updated_at: 0,
                };
                match db.insert_playlist(&playlist) {
                    Ok(()) => summary.playlists_applied += 1,
                    Err(e) => log(&app, "ERROR", &format!("Sync Review: playlist upsert '{}' failed: {}", mp.name, e)),
                }
            } else {
                match db.remove_playlists_by_persistent_ids(std::slice::from_ref(pid)) {
                    Ok(names) => summary.playlists_applied += names.len(),
                    Err(e) => log(&app, "ERROR", &format!("Sync Review: playlist removal failed: {}", e)),
                }
            }
        }
    }

    log(
        &app,
        "INFO",
        &format!(
            "Sync Review applied: {} imported, {} kept as unlinked, {} deleted, {} iTunes changes applied, {} TagDeck versions kept, {} playlist change(s)",
            summary.imported, summary.unlinked, summary.deleted, summary.tracks_applied, summary.tracks_kept, summary.playlists_applied
        ),
    );

    Ok(summary)
}

/// Restricts a Music.app playlist's track list to tracks TagDeck knows about
/// and removes duplicates — the same filtering sync Phase 3 uses, so preview
/// diffs and applied rows agree.
fn filter_playlist_tracks(
    track_ids: &[String],
    known_pids: &std::collections::HashSet<String>,
) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    track_ids
        .iter()
        .filter(|tid| known_pids.contains(*tid))
        .filter(|tid| seen.insert((*tid).clone()))
        .cloned()
        .collect()
}
