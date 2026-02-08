# Real-Time Synchronization Strategy (Implemented)

> **✅ STATUS: WORKING**
> Fixed February 2026. The original date-based query missed rating/BPM changes because
> Apple Music does NOT update `modification date` for those fields. The system now uses
> a two-phase approach: date-based query for metadata + snapshot diff for rating/BPM.

System for keeping TagDeck in sync with Apple Music (Music.app) changes in real-time.

## Architecture

The system relies on three components:
1.  **File System Watcher (`library_watcher.rs`)**: Monitors the Music.app database files.
2.  **Debounce Logic**: Coalesces rapid writes into a single event.
3.  **Two-Phase Delta Sync (`apple_music.rs` + `commands.rs`)**: Fetches changes using two complementary strategies.

### 1. Library Watcher
We use the `notify` crate to watch for recursive changes in the file system.
*   **Watched Paths**:
    *   Legacy: `~/Music/iTunes/iTunes Library.xml` and `iTunes Music Library.xml`.
    *   Modern: `~/Music/Music/Music Library.musiclibrary` (Recursive watch to catch internal `.itdb` updates).
*   **Filtering**: Ignores irrelevant file types (`.tmp`, `.lock`, `.log`) to prevent false positives.

### 2. Debounce System (Trailing Edge)
Music.app often writes to the database multiple times for a single user action. We use a **trailing-edge** debounce to wait for the activity to settle.
*   **Implementation**: When an event is detected, we start a timer. Every subsequent event resets the timer. We only emit a `music-library-changed` event if **2 seconds** of silence have passed since the last file system event.
*   **Why**: This ensures we don't trigger a sync in the middle of a large write operation (e.g., editing multiple tags).

### 3. Two-Phase Delta Sync

> **Key Discovery**: Apple Music's `modification date` property is only updated for metadata
> changes (title, artist, album, comment, grouping). It is **NOT** updated for rating, BPM,
> play count, or other "library" fields. This means a single query strategy can never
> catch all change types.

**Phase 1 — Date-Based Query (Metadata)**
Uses AppleScript `whose modification date >= sinceDate` to find tracks with changed metadata.
Good for: title, artist, album, comment, grouping, file path changes.
Returns full track objects for upsert into the DB.

**Phase 2 — Snapshot Diff (Rating & BPM)**
Fetches `(persistent_id, rating, bpm)` for ALL tracks from Music.app using efficient
batch property access (parallel list fetching). Takes ~2 seconds for 20k tracks.
Compares against our DB and upserts only the differences.
Good for: rating, BPM — any field that `modification date` ignores.

**The Workflow:**
1.  Frontend receives `music-library-changed`.
2.  Frontend retrieves `last_sync_time` from `localStorage`.
3.  Frontend calculates `since_timestamp` with a **1-hour safety buffer** (querying `Now - 1h`).
4.  Backend runs **Phase 1**: AppleScript date-based query → upserts changed tracks.
5.  Backend runs **Phase 2**: Batch-fetches all `(id, rating, bpm)` → diffs against DB → upserts changes.
6.  Frontend receives the total count of updated tracks.

### Why AppleScript?
Initial attempts used JXA (JavaScript for Automation). However, JXA has a known bug/limitation where comparing `modificationDate` objects with external dates is flaky and often returns 0 results. Pure AppleScript handles the date coercion correctly `(date "...")`.

### Why Batch Property Access for Phase 2?
AppleScript's `persistent ID of every track` fetches ALL values in a single Apple Event,
returning them as a list. This is orders of magnitude faster than iterating with `repeat`.
Fetching 3 fields × 20k tracks takes ~2 seconds. JSON serialization of parallel arrays
(using NSJSONSerialization) is also near-instant since no per-record loop is needed.

## Frontend Interaction
*   **Settings Panel Toggle**: A switch is available in Settings to Enable/Disable Real-Time Sync entirely.
*   The `App.tsx` component sets up the listener on mount (if enabled).
*   Shows a "Syncing..." success toast when change is detected.
*   Shows a "Synced X altered tracks" toast upon completion.
*   Updates `last_sync_time` in local storage only on success.
