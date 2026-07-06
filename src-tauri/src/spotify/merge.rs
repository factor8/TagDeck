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

/// Merge a ghost into a local track: union tags into the local file's comment
/// (file write is best-effort; DB is authoritative), repoint playlist rows,
/// transfer spotify_id, delete the ghost and its pending matches.
pub fn merge_ghost_into_local(db: &Database, ghost_id: i64, local_id: i64) -> Result<(), String> {
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
    updated.comment_raw = if new_comment.is_empty() { None } else { Some(new_comment) };
    db.update_track(&updated).map_err(|e| e.to_string())?;

    // 3. Repoint playlist membership (ignore rows where local is already a member)
    db.repoint_playlist_tracks(ghost_id, local_id).map_err(|e| e.to_string())?;

    // 4. Transfer spotify_id, drop ghost + pending matches
    db.transfer_spotify_id(ghost_id, local_id).map_err(|e| e.to_string())?;
    db.delete_pending_matches_for_ghost(ghost_id).map_err(|e| e.to_string())?;
    db.delete_track(ghost_id).map_err(|e| e.to_string())?;
    let _ = db.sync_tags();
    Ok(())
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
                if merge_ghost_into_local(&db, ghost_id, local_id).is_ok() {
                    outcome.auto_merged += 1;
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
    if outcome.auto_merged > 0 || outcome.pending_review > 0 {
        let _ = app.emit("spotify-merge-completed", serde_json::json!({
            "merged": outcome.auto_merged, "pending": outcome.pending_review
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
}
