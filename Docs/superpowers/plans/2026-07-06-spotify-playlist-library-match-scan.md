# Spotify Playlist Library Match Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On-demand "Find library matches" scan for an imported Spotify playlist: score its ghost tracks against local library tracks and queue every candidate (≥0.60) into the existing pending-match review flow — never auto-merging.

**Architecture:** One pure-ish Rust function in `src-tauri/src/spotify/merge.rs` (reuses `matcher::match_score`, `is_match_candidate`, `db.add_pending_match`), exposed as a Tauri command, triggered from a new context-menu item on Spotify playlists in `src/components/Sidebar.tsx` with a toast summary. No Spotify API calls, no schema changes.

**Tech Stack:** Rust (rusqlite, tauri v2), React/TypeScript frontend.

**Spec:** `Docs/superpowers/specs/2026-07-06-spotify-playlist-library-match-scan-design.md`

## Global Constraints

- All candidates queue for review, including score ≥ 0.90 (`AUTO_MERGE_THRESHOLD`). The auto-merge branch is intentionally unused here.
- Threshold for queueing: `matcher::REVIEW_THRESHOLD` (0.60).
- Dedupe relies on the existing `UNIQUE(ghost_track_id, local_track_id)` constraint on `spotify_pending_matches`.
- Rust tests run with: `cargo test --manifest-path src-tauri/Cargo.toml`
- Frontend typecheck: `npx tsc --noEmit` from repo root.

---

### Task 1: `add_pending_match` returns whether a row was inserted

The scan must report "already pending" counts. `add_pending_match` uses `INSERT OR IGNORE`; make it return whether the row was actually inserted.

**Files:**
- Modify: `src-tauri/src/db.rs:1829-1837` (`add_pending_match`)

**Interfaces:**
- Produces: `pub fn add_pending_match(&self, ghost_id: i64, local_id: i64, score: f64) -> Result<bool>` — `Ok(true)` if inserted, `Ok(false)` if the pair was already queued.
- Existing caller `merge.rs:278` uses `.is_ok()` — still compiles unchanged.

- [ ] **Step 1: Change the return value**

In `src-tauri/src/db.rs`, replace the body of `add_pending_match`:

```rust
    /// Queue a mid-confidence ghost/local match for user review. Returns
    /// whether a row was inserted — false means the pair was already queued
    /// (UNIQUE(ghost_track_id, local_track_id)).
    pub fn add_pending_match(&self, ghost_id: i64, local_id: i64, score: f64) -> Result<bool> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs() as i64;
        let inserted = self.conn.execute(
            "INSERT OR IGNORE INTO spotify_pending_matches (ghost_track_id, local_track_id, score, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![ghost_id, local_id, score, now],
        )?;
        Ok(inserted > 0)
    }
```

- [ ] **Step 2: Verify everything still compiles and passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all existing tests PASS (no test changes needed; the only caller uses `.is_ok()`).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "refactor(db): add_pending_match reports whether the pair was newly queued"
```

---

### Task 2: Scan function in merge.rs (TDD)

**Files:**
- Modify: `src-tauri/src/spotify/merge.rs` (new function after `process_new_local_tracks`, tests in the existing `mod tests`)

**Interfaces:**
- Consumes: `Database::get_playlist_track_ids(i64) -> Result<Vec<i64>>` (db.rs:564), `Database::get_all_tracks()` (db.rs:1037), `Database::get_track(i64)`, `Database::add_pending_match(...) -> Result<bool>` (Task 1), `matcher::match_score`, `matcher::REVIEW_THRESHOLD`, private `is_match_candidate` (merge.rs:234).
- Produces:

```rust
#[derive(Debug, Default, Serialize)]
pub struct ScanResult {
    pub ghosts_scanned: usize,
    pub candidates_queued: usize,
    pub already_pending: usize,
}

pub fn scan_playlist_for_matches(db: &Database, playlist_id: i64) -> Result<ScanResult, String>
```

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` in `src-tauri/src/spotify/merge.rs` (reuse the existing `make_local` helper; note it creates tracks with artist "Artist", title "Title", duration 200.0):

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml spotify::merge`
Expected: FAIL to compile — `scan_playlist_for_matches` and `ScanResult` not found.

- [ ] **Step 3: Implement the scan function**

Add to `src-tauri/src/spotify/merge.rs`, after `process_new_local_tracks` (before `mod tests`):

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml spotify::merge`
Expected: all PASS, including the 5 new tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/spotify/merge.rs
git commit -m "feat(spotify): on-demand playlist match scan against local library"
```

---

### Task 3: Tauri command + registration

**Files:**
- Modify: `src-tauri/src/spotify/commands.rs` (append at end)
- Modify: `src-tauri/src/lib.rs:219` (registration list)

**Interfaces:**
- Consumes: `merge::scan_playlist_for_matches` (Task 2).
- Produces: Tauri command `spotify_scan_playlist_matches(playlist_id)` returning `ScanResult` serialized as `{ ghosts_scanned, candidates_queued, already_pending }`.

- [ ] **Step 1: Add the command**

Append to `src-tauri/src/spotify/commands.rs`:

```rust
/// On-demand "Find library matches" for one imported Spotify playlist.
/// Queues every candidate ≥ REVIEW_THRESHOLD for review; never auto-merges.
#[tauri::command]
pub async fn spotify_scan_playlist_matches(
    playlist_id: i64,
    state: State<'_, AppState>,
) -> Result<super::merge::ScanResult, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    super::merge::scan_playlist_for_matches(&db, playlist_id)
}
```

- [ ] **Step 2: Register it**

In `src-tauri/src/lib.rs`, after `spotify::commands::spotify_unlink_track` (line 219), add:

```rust
            spotify::commands::spotify_scan_playlist_matches,
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: clean (warnings at most).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/spotify/commands.rs src-tauri/src/lib.rs
git commit -m "feat(spotify): expose spotify_scan_playlist_matches command"
```

---

### Task 4: Sidebar context-menu item + toast

**Files:**
- Modify: `src/components/Sidebar.tsx`
  - line 5: lucide import
  - near `handleSpotifySyncNow` (line 694): new handler
  - Spotify context-menu block (lines 1220-1230): new menu item

**Interfaces:**
- Consumes: command `spotify_scan_playlist_matches` (Task 3; invoke arg `playlistId` — Tauri converts to `playlist_id`), existing `useToast()` helpers `showSuccess`/`showError` (line 659), `onPlaylistsChanged` prop (bumps `refreshTrigger` in App.tsx, which re-fetches the pending-match badge count at line 383).

- [ ] **Step 1: Add `SearchCheck` to the lucide-react import (line 5)**

```tsx
import { ChevronRight, ChevronDown, Folder, ListMusic, Plus, Music, Copy, Trash2, Pencil, FolderPlus, ListPlus, ArrowRight, Unlink, FileDown, Search, SearchCheck, X, AudioLines, CloudOff, RefreshCw } from 'lucide-react';
```

- [ ] **Step 2: Add the handler** (after `handleSpotifySyncNow`, ~line 705)

```tsx
  // On-demand "Find library matches" for one Spotify playlist: scans its
  // ghosts against the local library; every candidate goes to the review
  // queue (never auto-merged). Backend does no Spotify API calls.
  const handleScanMatches = useCallback(async (node: PlaylistNode) => {
      try {
          const r = await invoke<{ ghosts_scanned: number; candidates_queued: number; already_pending: number }>(
              'spotify_scan_playlist_matches', { playlistId: node.id });
          const tracks = `${r.ghosts_scanned} track${r.ghosts_scanned !== 1 ? 's' : ''}`;
          if (r.ghosts_scanned === 0) {
              showSuccess('All tracks in this playlist are already matched');
          } else if (r.candidates_queued > 0) {
              showSuccess(`Scanned ${tracks} — ${r.candidates_queued} match candidate${r.candidates_queued !== 1 ? 's' : ''} ready for review`);
              onPlaylistsChanged?.();
          } else if (r.already_pending > 0) {
              showSuccess(`Scanned ${tracks} — ${r.already_pending} match${r.already_pending !== 1 ? 'es' : ''} already awaiting review`);
          } else {
              showSuccess(`Scanned ${tracks} — no new matches found`);
          }
      } catch (err) {
          showError(`Match scan failed: ${err}`);
      }
  }, [showSuccess, showError, onPlaylistsChanged]);
```

- [ ] **Step 3: Add the menu item**

In the Spotify branch of the context menu (line 1220-1230), between "Sync Now" and the separator before "Remove from TagDeck":

```tsx
                              <button className="ctx-item" onClick={() => { const n = contextMenu.node!; setContextMenu(null); handleScanMatches(n); }}>
                                  <SearchCheck size={14} /> Find Library Matches
                              </button>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(spotify): Find Library Matches context-menu action with toast summary"
```

---

### Task 5: Changelog + manual verification

**Files:**
- Modify: `CHANGELOG.md` (unreleased section, follow existing entry style)

- [ ] **Step 1: Add changelog entry**

Under the unreleased/latest section (match the file's existing format):

```markdown
- Spotify playlists: right-click → "Find Library Matches" scans the playlist's unmatched tracks against your library and queues likely matches for review.
```

- [ ] **Step 2: Full test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && npx tsc --noEmit`
Expected: all PASS / no errors.

- [ ] **Step 3: Manual verification (with the user)**

Launch dev app (`npm run tauri dev`), right-click an imported Spotify playlist → Find Library Matches → confirm toast counts and that the review badge/modal shows the queued candidates.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for Spotify playlist match scan"
```
