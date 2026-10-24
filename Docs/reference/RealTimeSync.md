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

**Comment push is read-merge (iTunes owns the note, TagDeck owns the tag block).**
TagDeck stores tags inside the Comments field as `"<user note> && tag1; tag2"`. When a
**tag** edit pushes to Music.app (`batch_update_track_comments`, and the single-track
`write_tags` path), the JXA reads each track's *live* comment, keeps the user note before
the first `" && "`, and replaces only the tag block (`tag_block_of` derives it) — so a
stale DB copy of the note can never overwrite the user's live iTunes note. The one path
where the user *authors* the note in TagDeck (inline comment-column edit → `update_track_info`,
plus its undo and Sync Review "keep TagDeck side") still uses `update_track_comment`, a
direct `set comment` — there the user's edit is authoritative.

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

**Self-echo suppression.** Every TagDeck write to Music.app (`apple_music.rs` mutating
helpers and the direct osascript in `undo.rs` call `note_music_write()`) stamps a
process-wide "last write" time. When a Music.app burst settles, the watcher asks
`is_self_echo(secs_since_last_music_write, burst_age)`: if the burst *began* within
`SELF_ECHO_WINDOW_SECS` (45 s) after our own write, it is Music.app saving our change and
is logged but **not** synced. Observed save lag after a push is 2–20 s. Trade-off: a
genuine Music.app edit made inside that window waits for Music's next save; the snapshot
phases pick it up then.

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
- **Mass-removal safety guard** (`removal_is_suspicious` in `commands.rs`): before honoring
  the deletion behavior, the removal batch is sanity-checked against the empty/partial-snapshot
  failure mode (Music.app still loading, an empty/switched library, iCloud sync). A batch is
  *suspicious* when Music.app returned zero tracks while the DB has linked tracks, **or** when
  it exceeds `max(25, 20% × linked)`. A suspicious batch is **never** auto-unlinked/removed —
  it's routed to `pending_removals` (Sync Review) with a `WARN` log, regardless of the
  configured behavior. This prevents a transient empty snapshot from wiping all TagDeck data.

**Phase 1 — Date-Based Query (Metadata)**
Uses AppleScript `whose modification date >= sinceDate` to find tracks with changed metadata.
Good for: title, artist, album, comment, grouping, file path changes.
Returns full track objects for upsert into the DB.

**Phase 2 — Snapshot Diff (Rating & BPM)**
Fetches `(persistent_id, rating, bpm)` for ALL tracks from Music.app using efficient
batch property access (parallel list fetching). Takes ~2 seconds for 20k tracks.
Compares against our DB and upserts only the differences.
Good for: rating, BPM — any field that `modification date` ignores.

**Phase 3 — Playlist Diff (header fingerprints, membership on demand)**

Reading `persistent ID of every track of p` for every playlist took 1–39 minutes on a
~650-playlist / 20k-track library (it included the "Music" system list = the whole
library). Phase 3 now runs in two steps:

1. **Headers** (`get_playlist_headers`, ~1 s + ~15 ms per playlist for the parent lookup):
   one batch Apple event per property over `every user playlist` plus `every folder
   playlist` — persistent ID, name, parent, class, `smart`, `special kind`, total
   `duration`, total `size`. Only *mirrored* playlists are kept
   (`PlaylistHeader::is_mirrored`: ordinary and smart user playlists and folders);
   system lists ("Music", Genius, Movies, …) are excluded, so the "Music" row that used
   to hold 20k `playlist_tracks` is removed on the first sync after upgrade.
2. **Members** (`get_playlist_members`) only for playlists that are **new to the DB** or
   whose `PlaylistHeader::fingerprint()` (name, parent, folder, smart, duration, size)
   differs from the one cached at the last successful reconcile. The cache lives in
   `AppState.playlist_fingerprints` and is persisted in `library_config` under
   `playlist_fingerprints_v1`, so a relaunch doesn't pay the cold cost. A playlist that
   Music.app fails to answer for is left un-reconciled (never treated as empty).

The diff itself is unchanged — added / removed / renamed / re-parented / membership
(sorted compare of linked track ids) — and the removal path keeps the mass-removal guard.
The log line reports `N of M playlists re-read`.

**Convergence rule (`db.insert_playlist`).** For a synced playlist, Music.app's
membership is authoritative for *linked* tracks: members Music.app no longer lists are
dropped. Only TagDeck-only members (no `itunes_pid` — native or unlinked) are preserved
and re-appended. The old behavior preserved every DB member, so a smart playlist that aged
tracks out (or any playlist a track was removed from in iTunes) differed from the DB on
every run and was "synced" forever — 474 of the 932 syncs in one log were exactly that.

**Smart playlists** are mirrored read-only: `is_smart` is stored on `playlists`, shown as
a wand badge in the sidebar, and `add_to_playlist` / `import_files` refuse them. In
Import-only mode, adds/removals of linked tracks on any synced playlist are refused too
(they could not reach Music.app and the next sync would undo them); the message points
to Two-way sync or "Stop Syncing with iTunes".

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
9.  Frontend receives the counts (updated / added / unlinked / playlists / pending removals / conflicts skipped) and refreshes — only when something changed.

**Bursts during a sync are queued, not dropped.** `sync_recent_changes` holds the
`is_syncing` lock. A call that finds it taken sets `AppState.sync_rerun_requested`, logs,
and returns `SyncResult { skipped: true }`; the frontend ignores a skipped result (no
toast, no `last_sync_time` update). When the running sync finishes it clears the flag and
re-emits `music-library-changed`, so the queued changes are picked up once.

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
*   Quiet by default: no toast when a change is detected, and none when a sync finds nothing (logged only). A "Synced: …" toast and a list refresh happen only when something changed; conflicts still surface as an info toast.
*   Updates `last_sync_time` in local storage only on success.

## See Also
*   [`LibraryStrategy.md`](./LibraryStrategy.md) — sync modes, identity/linking, deletion
    behavior, the full conflict model, per-playlist sync, and Sync Review.
