# Real-Time Synchronization Strategy (Implemented)

> **✅ STATUS: WORKING**
> Fixed February 2026. The original date-based query missed rating/BPM changes because
> Apple Music does NOT update `modification date` for those fields. The system now uses
> a three-phase approach: date-based query for metadata + snapshot diff for rating/BPM
> + playlist snapshot diff for playlist changes.

System for keeping TagDeck in sync with Apple Music (Music.app) changes in real-time.

This document is the canonical reference for the **low-level delta-sync engine** (the
watcher, the debounce, and the phased AppleScript diff). The **sync modes**, the
**conflict model**, and **Sync Review** are covered in depth in
[`LibraryStrategy.md`](./LibraryStrategy.md); only the parts that gate this engine are
summarized here.

## Sync Modes Gate Real-Time Pull

Real-time pull from Music.app is **no longer unconditional**. The global iTunes sync
mode (`SyncMode` in `file_manager.rs`, stored in `library_config`) decides whether this
engine runs at all:

| Mode          | `pull_enabled()` | Real-time sync runs? |
| ------------- | ---------------- | -------------------- |
| `Off`         | no               | No — `sync_recent_changes` returns early |
| `ImportOnly`  | yes              | Yes (pull only)      |
| `TwoWay`      | yes              | Yes (pull; also pushes edits back) |

`sync_recent_changes` reads the mode up front and bails immediately when
`!mode.pull_enabled()` (i.e. `Off`), before taking the sync lock. In pull-capable modes,
`mode.push_enabled()` (true only for `TwoWay`) further controls whether incoming rows
overwrite the DB comment/grouping or preserve them (`insert_track_preserving_comment`),
since in `ImportOnly` the audio file is the golden source for those fields.

## Architecture

The system relies on four components:
1.  **File System Watcher (`library_watcher.rs`)**: Monitors the Music.app database files **and** the TagDeck library root.
2.  **Debounce Logic**: Coalesces rapid writes into a single event.
3.  **Mode Gate (`commands.rs`)**: Skips the whole engine when the sync mode is `Off`.
4.  **Four-Phase Delta Sync (`apple_music.rs` + `commands.rs`)**: Phase 0 reconciles adds/removes; Phases 1–3 diff changes using three complementary strategies.

### 1. Library Watcher
We use the `notify` crate to watch for recursive changes in the file system. It watches
**two** distinct sources and emits a different event for each:

*   **Music.app database** → emits `music-library-changed`. Watched paths:
    *   Legacy: `~/Music/iTunes/iTunes Library.xml` and `iTunes Music Library.xml`.
    *   Modern: `~/Music/Music/Music Library.musiclibrary` (recursive watch to catch internal `.itdb`/`.musicdb` updates) and `~/Music/Music/Library.xml`.
    *   User-custom locations confirmed via `lsof` (e.g. `~/Music/Music 1/Music Library.musiclibrary`).
*   **TagDeck library root** → emits `tagdeck-library-changed`. Watched recursively so
    files moved/deleted outside the app get reconciled (the frontend responds by running
    `verify_library_files`). The root is read from `LibraryConfig` at startup; a change
    to the root path requires an app restart to be re-watched.
*   **Filtering**: Ignores irrelevant paths (`.tmp`, `.lock`) to prevent false positives.

Events in a single debounce burst are classified by source (`burst_music` vs
`burst_root`), so each burst triggers only the reconciliation it needs — a Music.app
write does not fire the file-verification path and vice versa.

### 2. Debounce System (Trailing Edge)
Music.app often writes to the database multiple times for a single user action. We use a **trailing-edge** debounce to wait for the activity to settle.
*   **Implementation**: When an event is detected, we start a timer. Every subsequent event resets the timer. We only emit once **2 seconds** of silence have passed since the last file system event (`debounce_duration = Duration::from_secs(2)`, `library_watcher.rs`).
*   **Why**: This ensures we don't trigger a sync in the middle of a large write operation (e.g., editing multiple tags).
*   On settle, the coalesced burst emits `music-library-changed` and/or `tagdeck-library-changed` depending on which source(s) produced events.

### 3. Four-Phase Delta Sync

> **Key Discovery**: Apple Music's `modification date` property is only updated for metadata
> changes (title, artist, album, comment, grouping). It is **NOT** updated for rating, BPM,
> play count, or other "library" fields. This means a single query strategy can never
> catch all change types.

**Phase 0 — Adds / Removes Reconciliation**
Compares the set of persistent IDs in Music.app against TagDeck's linked tracks.
- **Added** (in Music.app, not linked in DB): fetched and inserted.
- **Removed** (linked in DB, gone from Music.app): tracks are **unlinked, not deleted** —
  TagDeck owns track existence. The exact behavior follows the `itunes_deletion_behavior`
  setting (`DeletionBehavior` in `file_manager.rs`):
  - `Keep` (unlink the track but retain it and all its tags/playlists in TagDeck),
  - `Remove` (mirror the deletion into TagDeck),
  - `Ask` (don't decide — report the removals as `pending_removals` so the frontend can
    open Sync Review; each sync re-reports them until resolved via `apply_sync_changes`).

**Phase 1 — Date-Based Query (Metadata)**
Uses AppleScript `whose modification date >= sinceDate` to find tracks with changed metadata.
Good for: title, artist, album, comment, grouping, file path changes.
Returns full track objects for upsert into the DB.

**Phase 2 — Snapshot Diff (Rating & BPM)**
Fetches `(persistent_id, rating, bpm)` for ALL tracks from Music.app using efficient
batch property access (parallel list fetching). Takes ~2 seconds for 20k tracks.
Compares against our DB and upserts only the differences.
Good for: rating, BPM — any field that `modification date` ignores.

**Phase 3 — Playlist Snapshot Diff**
Fetches all playlists from Music.app with their names, folder status, parent relationships,
and track membership lists. Compares against our DB snapshot to detect:
- **Added playlists** (in Music.app but not in DB)
- **Removed playlists** (in DB but not in Music.app — cascade-deletes playlist_tracks)
- **Renamed playlists** (name changed)
- **Reordered/changed membership** (track list differs)
- **Folder hierarchy changes** (parent_persistent_id changed)

Uses AppleScript to iterate all non-library playlists. Folder playlists are detected via
`class of p is folder playlist`. Track membership is fetched via `persistent ID of every track of p`.

### Conflict Handling (Dirty Tracks → Sync Review)

Incoming iTunes changes are **not silently applied** to tracks the user has edited in
TagDeck since the last sync. Before Phase 1 runs, `sync_recent_changes` loads the set of
dirty tracks (`db.get_dirty_itunes_pids()` → `dirty_pids`). In Phases 1 and 2, any
incoming change whose persistent ID is in `dirty_pids` is **skipped** (counted as
`conflicts_skipped`) rather than overwriting the TagDeck edit. These conflicts, along
with `Ask`-mode removals, are surfaced in **Sync Review** (`sync_review.rs` — `preview_sync`
/ `apply_sync_changes`), where the user picks a side per track/category. See
[`LibraryStrategy.md`](./LibraryStrategy.md) for the full conflict/reconciliation model.

**The Workflow:**
1.  Frontend receives `music-library-changed`.
2.  Frontend retrieves `last_sync_time` from `localStorage`.
3.  Frontend calculates `since_timestamp` with a **1-hour safety buffer** (querying `Now - 1h`).
4.  Backend checks the sync mode; if `Off`, returns immediately with no changes.
5.  Backend runs **Phase 0**: reconciles adds/removes (unlink-or-defer per deletion behavior).
6.  Backend runs **Phase 1**: AppleScript date-based query → upserts changed tracks (skipping dirty conflicts).
7.  Backend runs **Phase 2**: Batch-fetches all `(id, rating, bpm)` → diffs against DB → upserts changes (skipping dirty conflicts).
8.  Backend runs **Phase 3**: Fetches all playlists → diffs against DB → upserts/deletes playlists.
9.  Frontend receives the counts (updated / added / unlinked / playlists / pending removals / conflicts skipped) and refreshes.

### Why AppleScript?
Initial attempts used JXA (JavaScript for Automation). However, JXA has a known bug/limitation where comparing `modificationDate` objects with external dates is flaky and often returns 0 results. Pure AppleScript handles the date coercion correctly `(date "...")`.

### Why Batch Property Access for Phase 2?
AppleScript's `persistent ID of every track` fetches ALL values in a single Apple Event,
returning them as a list. This is orders of magnitude faster than iterating with `repeat`.
Fetching 3 fields × 20k tracks takes ~2 seconds. JSON serialization of parallel arrays
(using NSJSONSerialization) is also near-instant since no per-record loop is needed.

## Frontend Interaction
*   **Settings Panel Toggle**: A switch is available in Settings to Enable/Disable Real-Time Sync entirely. This is separate from the sync **mode** — even when the toggle is on, an `Off` mode short-circuits the backend.
*   The `App.tsx` component sets up the listeners on mount (if enabled) for both `music-library-changed` and `tagdeck-library-changed`.
*   Shows a "Syncing..." success toast when a change is detected.
*   Shows a "Synced X altered tracks" toast upon completion.
*   Updates `last_sync_time` in local storage only on success.

## See Also
*   [`LibraryStrategy.md`](./LibraryStrategy.md) — sync modes, identity/linking, deletion
    behavior, the full conflict model, per-playlist sync, and Sync Review.
