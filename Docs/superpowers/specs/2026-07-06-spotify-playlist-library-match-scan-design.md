# Spotify Playlist → Library Match Scan

**Date:** 2026-07-06
**Status:** Approved

## Purpose

Let the user run an on-demand scan on an imported Spotify playlist to find likely
matches between its ghost tracks (Spotify tracks with no local file) and tracks
already in the local library. Today this matching only runs automatically when
*new local files* are added; ghosts imported after the file already existed, or
missed matches, are never re-checked.

## Decisions (from brainstorming)

- **Scope:** already-imported playlists only (ghosts). No arbitrary/unimported
  playlist preview.
- **On match:** always queue for review in the existing pending-matches flow —
  never auto-merge, even at ≥0.90 confidence.
- **Trigger:** "Find library matches" item in the Spotify playlist right-click
  menu in the sidebar. No global scan-all action for now.
- **Matching signal:** existing title/artist/duration matcher only. No ISRC
  (deferred — would require API/schema changes).

## Backend

New Tauri command in `src-tauri/src/spotify/commands.rs`, registered in
`src-tauri/src/lib.rs`:

```
spotify_scan_playlist_matches(playlist_id: i64) -> ScanResult
```

Scan logic lives in `src-tauri/src/spotify/merge.rs` alongside
`process_new_local_tracks`:

1. Load the playlist's tracks; keep only ghosts (`source == "spotify"`).
2. Load all local tracks eligible for linking via the existing
   `is_match_candidate` predicate (real file, not missing, not already
   Spotify-linked).
3. For each ghost, score against every candidate with `matcher::match_score`;
   keep the best candidate if score ≥ `REVIEW_THRESHOLD` (0.60).
4. Insert each (ghost, local, score) into `spotify_pending_matches`. All
   candidates go to review — the auto-merge branch is intentionally not used.
5. Skip pairs already pending (dedupe) so re-scans don't create duplicates.

Return value:

```
ScanResult { ghosts_scanned: usize, candidates_queued: usize, already_pending: usize }
```

No Spotify API calls: ghosts already store title/artist/duration locally.
Works offline; no rate-limit concerns.

**Performance:** in-memory N×M scan. ~100 ghosts × ~10k local tracks is ~1M
cheap string-similarity comparisons — sub-second in Rust. No indexing needed.

## Frontend

- `src/components/Sidebar.tsx`: add "Find library matches" to the Spotify
  playlist context menu (shown only for `origin === 'spotify'` playlists,
  next to sync/remove).
- On completion, show a toast:
  - candidates found: "Scanned N tracks — M match candidates ready for review"
  - none found: "Scanned N tracks — no new matches found"
  - no ghosts in playlist: "All tracks in this playlist are already matched"
- Refresh the existing pending-match review badge count after the scan.
- Review itself happens in the existing `SpotifyMatchReview` modal, unchanged.

## Error handling

- DB errors surface via the standard error toast path.
- Playlist not found / not a Spotify playlist → command returns an error
  string; toast it.

## Testing

- Rust unit tests for the scan function:
  - ghost with a clear match → queued
  - ghost with no match above threshold → not queued
  - pair already pending → counted as `already_pending`, not duplicated
  - already-linked local tracks excluded from candidates
- Manual verification on a real imported playlist.
