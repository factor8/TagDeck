// Merges Spotify ghost tracks into real local files once a match is found.
// Ghosts (source='spotify', file_path="") carry tags/playlist membership
// ahead of the actual purchase; when a matching local file shows up (import
// or Music.app sync), this module folds the ghost's data into the local
// track and retires the ghost. High-confidence matches merge automatically;
// mid-confidence matches queue in `spotify_pending_matches` for the user to
// confirm/reject/manually link (see spotify::commands).

use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

use super::matcher;
use crate::db::Database;

#[derive(Debug, Default, Serialize)]
pub struct MergeOutcome {
    pub auto_merged: usize,
    pub pending_review: usize,
}

const DELIMITER: &str = " && ";

fn split_comment(raw: &str) -> (&str, Vec<String>) {
    match raw.find(DELIMITER) {
        Some(idx) => {
            let tags = raw[idx + DELIMITER.len()..]
                .split(';')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
            (&raw[..idx], tags)
        }
        None => (raw, Vec::new()),
    }
}

/// Union of local + ghost tag blocks (local order first, case-insensitive
/// dedupe). Returns only the tag-block string; the caller combines it with
/// the local user-comment into one final string and writes that exact same
/// string to both the file (via metadata::write_metadata) and the DB, so the
/// two can never diverge.
pub fn union_tags(ghost_comment: &str, local_comment: &str) -> String {
    let (_, ghost_tags) = split_comment(ghost_comment);
    let (_, local_tags) = split_comment(local_comment);
    let mut seen: Vec<String> = Vec::new();
    for t in local_tags.into_iter().chain(ghost_tags.into_iter()) {
        if !seen.iter().any(|s| s.eq_ignore_ascii_case(&t)) {
            seen.push(t);
        }
    }
    seen.join("; ")
}

/// A comment update that must be mirrored to Music.app: (itunes_pid, comment).
/// Callers execute it via `apple_music::batch_update_track_comments` AFTER
/// releasing the DB lock — the AppleScript round-trip can take seconds.
pub type MusicPush = (String, String);

/// Merge a ghost into a local track: union tags into the local file's comment
/// (file write is best-effort; DB is authoritative), repoint playlist rows,
/// transfer spotify_id, delete the ghost and its pending matches.
///
/// The merged comment must also reach Music.app, or the next iTunes sync
/// pulls Music's stale copy back over it and the merged tags vanish (the
/// original "tags get overwritten" bug). Same protocol as write_tags/
/// batch_add_tag: push when the mode allows it (returned as a `MusicPush`
/// for the caller to run lock-free), otherwise mark the track dirty so
/// Sync Review treats the divergence as a conflict.
pub fn merge_ghost_into_local(db: &Database, ghost_id: i64, local_id: i64) -> Result<Option<MusicPush>, String> {
    let ghost = db.get_track(ghost_id).map_err(|e| e.to_string())?.ok_or("Ghost not found")?;
    let local = db.get_track(local_id).map_err(|e| e.to_string())?.ok_or("Local track not found")?;
    if !ghost.is_ghost() {
        return Err("Source track is not a Spotify ghost".into());
    }
    if local.is_ghost() {
        return Err("Target track has no local file".into());
    }
    if local.spotify_id.is_some() {
        return Err("Local track is already linked to a Spotify track".into());
    }

    // Journal what this merge destroys (ghost row + pre-merge local comment)
    // so "Unlink from Spotify" can restore it exactly.
    db.add_merge_log(local_id, &ghost, local.comment_raw.as_deref())
        .map_err(|e| e.to_string())?;

    let ghost_comment = ghost.comment_raw.clone().unwrap_or_default();
    let local_comment = local.comment_raw.clone().unwrap_or_default();
    let merged_tag_block = union_tags(&ghost_comment, &local_comment);

    // Rebuild "user && tags" from the local user part — DB-derived, never
    // re-read from the file — so the string written to disk and the string
    // stored in comment_raw are always identical (single source of truth).
    let (local_user, _) = split_comment(&local_comment);
    let new_comment = if merged_tag_block.is_empty() {
        local_user.to_string()
    } else if local_user.trim().is_empty() {
        format!("{}{}", DELIMITER, merged_tag_block)
    } else {
        format!("{}{}{}", local_user, DELIMITER, merged_tag_block)
    };

    // 1. File write (best-effort — DB is authoritative). Writes `new_comment`
    // verbatim via metadata::write_metadata — the same call pattern the rest
    // of the app's comment-writing commands use (write_tags, batch_add_tag/
    // batch_remove_tag, undo) — which never touches Grouping/ContentGroup.
    if !merged_tag_block.is_empty() {
        if let Err(e) = crate::metadata::write_metadata(&local.file_path, &new_comment) {
            eprintln!("Spotify merge: file tag write failed ({}), DB still updated", e);
        }
    }

    // 2. DB comment
    let mut updated = local.clone();
    updated.comment_raw = if new_comment.is_empty() { None } else { Some(new_comment.clone()) };
    db.update_track(&updated).map_err(|e| e.to_string())?;

    // 2b. Keep Music.app in agreement (see doc comment): push when allowed,
    // dirty-flag when not, nothing when the comment didn't actually change
    // or the track has no Music.app counterpart.
    let mut push_job = None;
    if new_comment != local_comment {
        match &local.itunes_pid {
            Some(pid) if crate::file_manager::LibraryConfig::sync_mode(db).push_enabled() => {
                push_job = Some((pid.clone(), new_comment));
            }
            Some(_) => {
                if let Err(e) = db.mark_tracks_dirty(&[local_id]) {
                    eprintln!("Spotify merge: failed to mark track dirty: {}", e);
                }
            }
            None => {}
        }
    }

    // 3. Repoint playlist membership (ignore rows where local is already a member)
    db.repoint_playlist_tracks(ghost_id, local_id).map_err(|e| e.to_string())?;

    // 4. Transfer spotify_id, drop ghost + pending matches
    db.transfer_spotify_id(ghost_id, local_id).map_err(|e| e.to_string())?;
    db.delete_pending_matches_for_ghost(ghost_id).map_err(|e| e.to_string())?;
    db.delete_track(ghost_id).map_err(|e| e.to_string())?;
    let _ = db.sync_tags();
    Ok(push_job)
}

/// Reverse a ghost→local merge: recreate the ghost, hand its spotify_id and
/// Spotify-playlist memberships back, and — when the merge was journaled —
/// restore the local track's exact pre-merge comment and the ghost's own
/// tags/rating. Unjournaled links (merges from before the journal existed)
/// still unlink cleanly, but the local comment keeps the merged tags since
/// there's no record of which ones the ghost brought in.
pub fn unlink_local_track(db: &Database, local_id: i64) -> Result<Option<MusicPush>, String> {
    let local = db.get_track(local_id).map_err(|e| e.to_string())?.ok_or("Track not found")?;
    if local.is_ghost() {
        return Err("Track is a Spotify ghost, not a linked local track".into());
    }
    let sid = local.spotify_id.clone().ok_or("Track is not linked to a Spotify track")?;

    // A journal row from an older, different link must not be replayed here.
    let journal = db.take_merge_log_for_local(local_id).map_err(|e| e.to_string())?
        .filter(|j| j.spotify_id == sid);

    // 1. Free the unique spotify_id index, then recreate the ghost — journal
    // metadata when available, the local track's own otherwise (the next
    // Spotify sync refreshes ghost metadata from the API).
    db.clear_spotify_id(local_id).map_err(|e| e.to_string())?;
    let (artist, title, album, duration) = match &journal {
        Some(j) => (
            j.ghost_artist.clone().unwrap_or_default(),
            j.ghost_title.clone().unwrap_or_default(),
            j.ghost_album.clone().unwrap_or_default(),
            j.ghost_duration_secs,
        ),
        None => (
            local.artist.clone().unwrap_or_default(),
            local.title.clone().unwrap_or_default(),
            local.album.clone().unwrap_or_default(),
            local.duration_secs,
        ),
    };
    let ghost_id = db
        .upsert_ghost_track(&sid, "", &artist, &title, &album, duration)
        .map_err(|e| e.to_string())?;
    if let Some(j) = &journal {
        if let Some(c) = &j.ghost_comment {
            db.update_track_metadata(ghost_id, c).map_err(|e| e.to_string())?;
        }
        if j.ghost_rating > 0 {
            db.update_track_rating(ghost_id, j.ghost_rating as u32).map_err(|e| e.to_string())?;
        }
    }

    // 2. Spotify-playlist memberships can only have come from the ghost —
    // point them back at it. The local track's other playlists are its own.
    db.repoint_spotify_playlist_tracks(local_id, ghost_id).map_err(|e| e.to_string())?;

    // 3. Restore the pre-merge comment (journaled merges only), following the
    // same file + DB + Music.app protocol as the merge itself.
    let mut push_job = None;
    if let Some(j) = &journal {
        if j.local_comment_before != local.comment_raw {
            let restored = j.local_comment_before.clone().unwrap_or_default();
            if let Err(e) = crate::metadata::write_metadata(&local.file_path, &restored) {
                eprintln!("Spotify unlink: file tag write failed ({}), DB still updated", e);
            }
            let mut updated = local.clone();
            updated.spotify_id = None;
            updated.comment_raw = j.local_comment_before.clone();
            db.update_track(&updated).map_err(|e| e.to_string())?;
            match &local.itunes_pid {
                Some(pid) if crate::file_manager::LibraryConfig::sync_mode(db).push_enabled() => {
                    push_job = Some((pid.clone(), restored));
                }
                Some(_) => {
                    if let Err(e) = db.mark_tracks_dirty(&[local_id]) {
                        eprintln!("Spotify unlink: failed to mark track dirty: {}", e);
                    }
                }
                None => {}
            }
        }
    }
    let _ = db.sync_tags();
    Ok(push_job)
}

/// A local track is eligible for ghost matching only if it actually has a
/// file (not itself a ghost) and isn't already linked to a Spotify track.
/// Re-scoring an already-linked track risks a near-duplicate ghost
/// outscoring its true match and clobbering the correct spotify_id/comment
/// (see `merge_ghost_into_local`'s matching guard — Fix 1 / Critical 1).
fn is_match_candidate(local: &crate::models::Track) -> bool {
    !local.is_ghost() && local.spotify_id.is_none()
}

/// Match freshly imported local tracks against all ghosts. High confidence →
/// merge now; mid → queue for review. Emits "spotify-merge-completed".
pub fn process_new_local_tracks(
    db: &Mutex<Database>,
    app: &tauri::AppHandle,
    new_track_ids: &[i64],
) -> MergeOutcome {
    let mut outcome = MergeOutcome::default();
    let mut pushes: Vec<MusicPush> = Vec::new();
    // (ghost_id, local_id) pairs for each auto-merge. The frontend uses these to
    // migrate any selection/playing snapshot still pinned to the deleted ghost id.
    let mut merges: Vec<(i64, i64)> = Vec::new();
    let Ok(db) = db.lock() else { return outcome };
    let Ok(ghosts) = db.get_ghost_tracks() else { return outcome };
    if ghosts.is_empty() {
        return outcome;
    }
    for &local_id in new_track_ids {
        let Ok(Some(local)) = db.get_track(local_id) else { continue };
        if !is_match_candidate(&local) { continue; }
        // Best ghost for this new file
        let mut best: Option<(i64, f64)> = None;
        for g in &ghosts {
            let score = matcher::match_score(
                g.artist.as_deref().unwrap_or(""),
                g.title.as_deref().unwrap_or(""),
                g.duration_secs,
                local.artist.as_deref().unwrap_or(""),
                local.title.as_deref().unwrap_or(""),
                local.duration_secs,
            );
            if best.map(|(_, s)| score > s).unwrap_or(score > 0.0) {
                best = Some((g.id, score));
            }
        }
        match best {
            Some((ghost_id, score)) if score >= matcher::AUTO_MERGE_THRESHOLD => {
                if let Ok(push) = merge_ghost_into_local(&db, ghost_id, local_id) {
                    outcome.auto_merged += 1;
                    merges.push((ghost_id, local_id));
                    pushes.extend(push);
                }
            }
            Some((ghost_id, score)) if score >= matcher::REVIEW_THRESHOLD => {
                if db.add_pending_match(ghost_id, local_id, score).is_ok() {
                    outcome.pending_review += 1;
                }
            }
            _ => {}
        }
    }
    // Music.app pushes run lock-free: batch_update_track_comments is an
    // AppleScript round-trip that can take seconds.
    drop(db);
    if !pushes.is_empty() {
        if let Err(e) = crate::apple_music::batch_update_track_comments(pushes) {
            eprintln!("Spotify merge: Music.app comment push failed: {}", e);
        }
    }
    if outcome.auto_merged > 0 || outcome.pending_review > 0 {
        let _ = app.emit("spotify-merge-completed", serde_json::json!({
            "merged": outcome.auto_merged,
            "pending": outcome.pending_review,
            // [{ghost, local}] — lets the frontend re-point stale ids onto the merged row.
            "mappings": merges.iter().map(|(g, l)| serde_json::json!({ "ghost": g, "local": l })).collect::<Vec<_>>()
        }));
        app.state::<crate::logging::LogState>().add_log(
            "INFO",
            &format!("Spotify merge: {} auto-merged, {} queued for review",
                     outcome.auto_merged, outcome.pending_review),
            app,
        );
    }
    outcome
}

#[derive(Debug, Default, Serialize)]
pub struct ScanResult {
    pub ghosts_scanned: usize,
    pub candidates_queued: usize,
    pub already_pending: usize,
}

/// On-demand sweep for one imported Spotify playlist: score each of its
/// ghosts against every eligible local track and queue the best candidate
/// (≥ REVIEW_THRESHOLD) for user review. Deliberately never auto-merges —
/// the user chose review-everything for manual scans, unlike the automatic
/// new-file flow above (process_new_local_tracks).
pub fn scan_playlist_for_matches(db: &Database, playlist_id: i64) -> Result<ScanResult, String> {
    let track_ids = db.get_playlist_track_ids(playlist_id).map_err(|e| e.to_string())?;
    let all = db.get_all_tracks().map_err(|e| e.to_string())?;
    let candidates: Vec<&crate::models::Track> =
        all.iter().filter(|t| is_match_candidate(t)).collect();

    let mut result = ScanResult::default();
    for tid in track_ids {
        let Ok(Some(ghost)) = db.get_track(tid) else { continue };
        if !ghost.is_ghost() {
            continue;
        }
        result.ghosts_scanned += 1;
        let mut best: Option<(i64, f64)> = None;
        for local in &candidates {
            let score = matcher::match_score(
                ghost.artist.as_deref().unwrap_or(""),
                ghost.title.as_deref().unwrap_or(""),
                ghost.duration_secs,
                local.artist.as_deref().unwrap_or(""),
                local.title.as_deref().unwrap_or(""),
                local.duration_secs,
            );
            if best.map(|(_, s)| score > s).unwrap_or(score > 0.0) {
                best = Some((local.id, score));
            }
        }
        if let Some((local_id, score)) = best {
            if score >= matcher::REVIEW_THRESHOLD {
                match db.add_pending_match(ghost.id, local_id, score) {
                    Ok(true) => result.candidates_queued += 1,
                    Ok(false) => result.already_pending += 1,
                    Err(e) => eprintln!("Spotify scan: failed to queue match: {}", e),
                }
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn union_tags_merges_and_dedupes_case_insensitively() {
        // ghost has tags only; local has a user comment and one overlapping tag
        assert_eq!(
            union_tags(" && energetic; House", "my note && house; classic"),
            "house; classic; energetic"
        );
        // ghost tags into empty local comment
        assert_eq!(union_tags(" && a; b", ""), "a; b");
        // no ghost tags → local tags unchanged
        assert_eq!(union_tags("just a comment", " && x"), "x");
    }

    #[test]
    fn merge_repoints_playlists_and_transfers_spotify_id() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        let ghost = dbm.upsert_ghost_track("g1", "u", "Artist", "Title", "Al", 200.0).unwrap();
        dbm.conn.execute("UPDATE tracks SET comment_raw = ' && energetic' WHERE id = ?1",
            rusqlite::params![ghost]).unwrap();
        dbm.upsert_spotify_playlist("pl", "P", "s", &[ghost]).unwrap();
        // local track (no file IO in this test: file_path is a temp file we create)
        let tmp = std::env::temp_dir().join("tagdeck_merge_test.mp3");
        // merge_ghost_into_local skips the file write gracefully if the file
        // can't be tagged — create an empty file so the path exists.
        std::fs::write(&tmp, b"").unwrap();
        let local = dbm.insert_imported_track(&crate::models::Track {
            id: 0, persistent_id: "TD-x".into(), file_path: tmp.to_string_lossy().into_owned(),
            artist: Some("Artist".into()), title: Some("Title".into()), album: None,
            comment_raw: None, grouping_raw: None, duration_secs: 200.0, format: "MP3".into(),
            size_bytes: 0, bit_rate: 0, modified_date: 0, rating: 0, date_added: 0, bpm: 0,
            missing: false, itunes_pid: None, unlinked_at: None,
            source: "local".into(), spotify_id: None,
        }, None, None).unwrap();

        merge_ghost_into_local(&dbm, ghost, local).unwrap();

        assert!(dbm.get_track(ghost).unwrap().is_none(), "ghost deleted");
        let merged = dbm.get_track(local).unwrap().unwrap();
        assert_eq!(merged.spotify_id.as_deref(), Some("g1"));
        assert!(merged.comment_raw.unwrap_or_default().contains("energetic"));
        let member: i64 = dbm.conn.query_row(
            "SELECT track_id FROM playlist_tracks LIMIT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(member, local, "playlist membership repointed");
    }

    /// Fix 1 / Critical 1: nothing previously stopped re-merging a ghost
    /// into a local track that's ALREADY linked to a different Spotify
    /// track — a re-fed already-linked track scoring high against an
    /// unrelated ghost would clobber its correct spotify_id and comment.
    #[test]
    fn merge_rejects_already_linked_local_track() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        let ghost = dbm.upsert_ghost_track("g2", "u2", "Artist", "Title", "Al", 200.0).unwrap();
        dbm.conn.execute("UPDATE tracks SET comment_raw = ' && energetic' WHERE id = ?1",
            rusqlite::params![ghost]).unwrap();

        let tmp = std::env::temp_dir().join("tagdeck_merge_test_linked.mp3");
        std::fs::write(&tmp, b"").unwrap();
        let local = dbm.insert_imported_track(&crate::models::Track {
            id: 0, persistent_id: "TD-linked".into(), file_path: tmp.to_string_lossy().into_owned(),
            artist: Some("Artist".into()), title: Some("Title".into()), album: None,
            comment_raw: Some("keep-me".into()), grouping_raw: None, duration_secs: 200.0, format: "MP3".into(),
            size_bytes: 0, bit_rate: 0, modified_date: 0, rating: 0, date_added: 0, bpm: 0,
            missing: false, itunes_pid: None, unlinked_at: None,
            source: "local".into(), spotify_id: Some("already-linked-id".into()),
        }, None, None).unwrap();

        let result = merge_ghost_into_local(&dbm, ghost, local);

        assert!(result.is_err(), "must reject merging into an already-linked local track");
        assert!(dbm.get_track(ghost).unwrap().is_some(), "ghost must survive a rejected merge");
        let local_row = dbm.get_track(local).unwrap().unwrap();
        assert_eq!(local_row.comment_raw.as_deref(), Some("keep-me"), "comment must be untouched");
        assert_eq!(local_row.spotify_id.as_deref(), Some("already-linked-id"), "spotify_id must be untouched");
    }

    fn make_local(dbm: &crate::db::Database, pid: &str, comment: Option<&str>, file: &str) -> i64 {
        let tmp = std::env::temp_dir().join(file);
        std::fs::write(&tmp, b"").unwrap();
        dbm.insert_imported_track(&crate::models::Track {
            id: 0, persistent_id: pid.into(), file_path: tmp.to_string_lossy().into_owned(),
            artist: Some("Artist".into()), title: Some("Title".into()), album: None,
            comment_raw: comment.map(|c| c.to_string()), grouping_raw: None,
            duration_secs: 200.0, format: "MP3".into(),
            size_bytes: 0, bit_rate: 0, modified_date: 0, rating: 0, date_added: 0, bpm: 0,
            missing: false, itunes_pid: None, unlinked_at: None,
            source: "local".into(), spotify_id: None,
        }, None, None).unwrap()
    }

    /// The "tags get overwritten" bug: a merged comment that never reaches
    /// Music.app is clobbered by the next iTunes pull. In push-enabled mode
    /// the merge must hand back a Music.app push job for the merged comment.
    #[test]
    fn merge_returns_music_push_for_itunes_linked_track_in_two_way_mode() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        let ghost = dbm.upsert_ghost_track("g-push", "u", "Artist", "Title", "Al", 200.0).unwrap();
        dbm.conn.execute("UPDATE tracks SET comment_raw = ' && energetic' WHERE id = ?1",
            rusqlite::params![ghost]).unwrap();
        let local = make_local(&dbm, "TD-push", Some("note && house"), "tagdeck_merge_push.mp3");
        dbm.conn.execute("UPDATE tracks SET itunes_pid = 'ITUNES-PID-1' WHERE id = ?1",
            rusqlite::params![local]).unwrap();
        // sync_mode unset → defaults to TwoWay (push enabled)

        let push = merge_ghost_into_local(&dbm, ghost, local).unwrap();

        let (pid, comment) = push.expect("two-way mode + linked track must produce a Music.app push");
        assert_eq!(pid, "ITUNES-PID-1");
        assert_eq!(comment, "note && house; energetic");
        let dirty: i64 = dbm.conn.query_row(
            "SELECT dirty_since_sync FROM tracks WHERE id = ?1",
            rusqlite::params![local], |r| r.get(0)).unwrap();
        assert_eq!(dirty, 0, "pushed tracks are in agreement with Music.app, not dirty");
    }

    /// Same bug, non-pushing mode: the merge must dirty-flag the track so the
    /// iTunes pull treats the divergence as a conflict instead of overwriting.
    #[test]
    fn merge_marks_track_dirty_when_push_disabled() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        dbm.set_config("sync_mode", "import_only").unwrap();
        let ghost = dbm.upsert_ghost_track("g-dirty", "u", "Artist", "Title", "Al", 200.0).unwrap();
        dbm.conn.execute("UPDATE tracks SET comment_raw = ' && energetic' WHERE id = ?1",
            rusqlite::params![ghost]).unwrap();
        let local = make_local(&dbm, "TD-dirty", None, "tagdeck_merge_dirty.mp3");
        dbm.conn.execute("UPDATE tracks SET itunes_pid = 'ITUNES-PID-2' WHERE id = ?1",
            rusqlite::params![local]).unwrap();

        let push = merge_ghost_into_local(&dbm, ghost, local).unwrap();

        assert!(push.is_none(), "no Music.app push in import-only mode");
        let dirty: i64 = dbm.conn.query_row(
            "SELECT dirty_since_sync FROM tracks WHERE id = ?1",
            rusqlite::params![local], |r| r.get(0)).unwrap();
        assert_eq!(dirty, 1, "divergence from Music.app must be flagged as a conflict");
    }

    #[test]
    fn unlink_restores_exact_premerge_state() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        let ghost = dbm.upsert_ghost_track("g-undo", "u", "GArtist", "GTitle", "GAlbum", 199.0).unwrap();
        dbm.conn.execute("UPDATE tracks SET comment_raw = ' && energetic; house', rating = 80 WHERE id = ?1",
            rusqlite::params![ghost]).unwrap();
        dbm.upsert_spotify_playlist("pl-undo", "P", "snap", &[ghost]).unwrap();
        let local = make_local(&dbm, "TD-undo", Some("my note && classic"), "tagdeck_unlink_test.mp3");

        merge_ghost_into_local(&dbm, ghost, local).unwrap();
        let merged = dbm.get_track(local).unwrap().unwrap();
        assert_eq!(merged.comment_raw.as_deref(), Some("my note && classic; energetic; house"));

        unlink_local_track(&dbm, local).unwrap();

        let restored = dbm.get_track(local).unwrap().unwrap();
        assert_eq!(restored.spotify_id, None, "spotify link cleared");
        assert_eq!(restored.comment_raw.as_deref(), Some("my note && classic"),
            "pre-merge comment restored exactly");
        let new_ghost_id = dbm.find_track_by_spotify_id("g-undo").unwrap()
            .expect("ghost recreated with its spotify_id");
        let new_ghost = dbm.get_track(new_ghost_id).unwrap().unwrap();
        assert!(new_ghost.is_ghost());
        assert_eq!(new_ghost.artist.as_deref(), Some("GArtist"));
        assert_eq!(new_ghost.comment_raw.as_deref(), Some(" && energetic; house"),
            "ghost tags restored");
        assert_eq!(new_ghost.rating, 80, "ghost rating restored");
        let member: i64 = dbm.conn.query_row(
            "SELECT track_id FROM playlist_tracks LIMIT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(member, new_ghost_id, "spotify playlist membership repointed back to the ghost");
        // Journal consumed — a second unlink must fail (no longer linked).
        assert!(unlink_local_track(&dbm, local).is_err());
    }

    /// Links made before the journal existed can still be unlinked: the ghost
    /// is rebuilt from the local track's metadata and the merged tags stay.
    #[test]
    fn unlink_without_journal_row_still_unlinks() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        let local = make_local(&dbm, "TD-nojournal", Some("note && a; b"), "tagdeck_unlink_nj.mp3");
        dbm.conn.execute("UPDATE tracks SET spotify_id = 'g-legacy' WHERE id = ?1",
            rusqlite::params![local]).unwrap();

        unlink_local_track(&dbm, local).unwrap();

        let restored = dbm.get_track(local).unwrap().unwrap();
        assert_eq!(restored.spotify_id, None);
        assert_eq!(restored.comment_raw.as_deref(), Some("note && a; b"),
            "without a journal the comment is left as-is");
        let ghost_id = dbm.find_track_by_spotify_id("g-legacy").unwrap().expect("ghost recreated");
        assert!(dbm.get_track(ghost_id).unwrap().unwrap().is_ghost());
    }

    /// Fix 1 / Critical 1, `process_new_local_tracks` layer: direct unit
    /// test of the skip predicate (an `AppHandle` isn't mockable here — the
    /// `tauri` dep has no `test` feature enabled — so the full function
    /// isn't exercised end-to-end; see task-13-report.md Fix 1 notes).
    #[test]
    fn is_match_candidate_excludes_ghosts_and_already_linked_tracks() {
        let dbm = crate::db::Database::new(":memory:").unwrap();

        let ghost_id = dbm.upsert_ghost_track("g3", "u3", "A", "T", "Al", 200.0).unwrap();
        let ghost = dbm.get_track(ghost_id).unwrap().unwrap();
        assert!(!is_match_candidate(&ghost), "ghost tracks are never match candidates");

        let base = crate::models::Track {
            id: 0, persistent_id: "TD-x".into(), file_path: "/tmp/x.mp3".into(),
            artist: Some("A".into()), title: Some("T".into()), album: None,
            comment_raw: None, grouping_raw: None, duration_secs: 200.0, format: "MP3".into(),
            size_bytes: 0, bit_rate: 0, modified_date: 0, rating: 0, date_added: 0, bpm: 0,
            missing: false, itunes_pid: None, unlinked_at: None,
            source: "local".into(), spotify_id: None,
        };

        let unlinked_id = dbm.insert_imported_track(
            &crate::models::Track { persistent_id: "TD-unlinked".into(), ..base.clone() },
            None, None,
        ).unwrap();
        let unlinked = dbm.get_track(unlinked_id).unwrap().unwrap();
        assert!(is_match_candidate(&unlinked), "an unlinked local track is a match candidate");

        let linked_id = dbm.insert_imported_track(
            &crate::models::Track {
                persistent_id: "TD-linked2".into(),
                spotify_id: Some("already-linked".into()),
                ..base
            },
            None, None,
        ).unwrap();
        let linked = dbm.get_track(linked_id).unwrap().unwrap();
        assert!(!is_match_candidate(&linked), "an already-linked local track must not be re-scored");
    }

    fn pending_rows(dbm: &crate::db::Database) -> Vec<(i64, i64, f64)> {
        dbm.get_pending_match_rows().unwrap()
            .into_iter().map(|(_, g, l, s)| (g, l, s)).collect()
    }

    /// Core behavior: a ghost with a clear local match is queued for review —
    /// NOT auto-merged, even though the score is well above 0.90.
    #[test]
    fn scan_queues_high_confidence_match_without_merging() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        let ghost = dbm.upsert_ghost_track("g-scan1", "u", "Artist", "Title", "Al", 200.0).unwrap();
        let pl = dbm.upsert_spotify_playlist("pl-scan1", "P", "s", &[ghost]).unwrap();
        let local = make_local(&dbm, "TD-scan1", None, "tagdeck_scan1.mp3");

        let r = scan_playlist_for_matches(&dbm, pl).unwrap();

        assert_eq!(r.ghosts_scanned, 1);
        assert_eq!(r.candidates_queued, 1);
        assert_eq!(r.already_pending, 0);
        assert!(dbm.get_track(ghost).unwrap().unwrap().is_ghost(), "ghost must NOT be merged");
        let rows = pending_rows(&dbm);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].0, rows[0].1), (ghost, local));
        assert!(rows[0].2 >= matcher::AUTO_MERGE_THRESHOLD, "sanity: this was a high-confidence pair");
    }

    /// A ghost with nothing similar in the library queues nothing.
    #[test]
    fn scan_skips_ghosts_below_review_threshold() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        let ghost = dbm.upsert_ghost_track("g-scan2", "u", "Completely Different Band", "Nothing Alike", "Al", 200.0).unwrap();
        let pl = dbm.upsert_spotify_playlist("pl-scan2", "P", "s", &[ghost]).unwrap();
        make_local(&dbm, "TD-scan2", None, "tagdeck_scan2.mp3"); // "Artist" / "Title"

        let r = scan_playlist_for_matches(&dbm, pl).unwrap();

        assert_eq!(r.ghosts_scanned, 1);
        assert_eq!(r.candidates_queued, 0);
        assert!(pending_rows(&dbm).is_empty());
    }

    /// Re-running the scan must not duplicate queue rows; the second pass
    /// reports the pair as already pending.
    #[test]
    fn rescan_reports_already_pending_instead_of_duplicating() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        let ghost = dbm.upsert_ghost_track("g-scan3", "u", "Artist", "Title", "Al", 200.0).unwrap();
        let pl = dbm.upsert_spotify_playlist("pl-scan3", "P", "s", &[ghost]).unwrap();
        make_local(&dbm, "TD-scan3", None, "tagdeck_scan3.mp3");

        scan_playlist_for_matches(&dbm, pl).unwrap();
        let r = scan_playlist_for_matches(&dbm, pl).unwrap();

        assert_eq!(r.candidates_queued, 0);
        assert_eq!(r.already_pending, 1);
        assert_eq!(pending_rows(&dbm).len(), 1);
    }

    /// Locals already linked to Spotify are never candidates (same guard as
    /// the automatic flow — is_match_candidate).
    #[test]
    fn scan_excludes_already_linked_locals() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        let ghost = dbm.upsert_ghost_track("g-scan4", "u", "Artist", "Title", "Al", 200.0).unwrap();
        let pl = dbm.upsert_spotify_playlist("pl-scan4", "P", "s", &[ghost]).unwrap();
        let local = make_local(&dbm, "TD-scan4", None, "tagdeck_scan4.mp3");
        dbm.conn.execute("UPDATE tracks SET spotify_id = 'other-track' WHERE id = ?1",
            rusqlite::params![local]).unwrap();

        let r = scan_playlist_for_matches(&dbm, pl).unwrap();

        assert_eq!(r.ghosts_scanned, 1);
        assert_eq!(r.candidates_queued, 0);
        assert!(pending_rows(&dbm).is_empty());
    }

    /// Non-ghost members of the playlist (already-matched tracks) don't count
    /// as scanned ghosts.
    #[test]
    fn scan_counts_only_ghost_members() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        let ghost = dbm.upsert_ghost_track("g-scan5", "u", "Someone Else", "Other Song", "Al", 123.0).unwrap();
        let local_member = make_local(&dbm, "TD-scan5", None, "tagdeck_scan5.mp3");
        let pl = dbm.upsert_spotify_playlist("pl-scan5", "P", "s", &[ghost, local_member]).unwrap();

        let r = scan_playlist_for_matches(&dbm, pl).unwrap();

        assert_eq!(r.ghosts_scanned, 1, "the local member is not a ghost");
    }
}
