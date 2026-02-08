# Real-Time Synchronization Strategy (Implemented)

System for keeping TagDeck in sync with Apple Music (Music.app) changes in real-time.

## Architecture

The system relies on three components:
1.  **File System Watcher (`library_watcher.rs`)**: Monitors the Music.app database files.
2.  **Debounce Logic**: Coalesces rapid writes into a single event.
3.  **Delta Query (`apple_music.rs`)**: Fetches only changed records using AppleScript.

### 1. Library Watcher
We use the `notify` crate to watch for recursive changes in the file system.
*   **Watched Paths**:
    *   Legacy: `~/Music/iTunes/iTunes Library.xml` and `iTunes Music Library.xml`.
    *   Modern: `~/Music/Music/Music Library.musiclibrary` (Recursive watch to catch internal `.itdb` updates).
*   **Filtering**: Ignores irrelevant file types (`.tmp`, `.lock`, `.log`) to prevent false positives.

### 2. Debounce System
Music.app often writes to the database multiple times for a single user action (updating `Extras.itdb`, then `Library.musicdb`, then a `.tmp` file).
*   **Implementation**: When an event is detected, we record the time. We only emit a `music-library-changed` event to the frontend if **5 seconds** have passed since the last emission.
*   **Verbose Logging**: The console logs every file event (filtered) and whether it was debounced.

### 3. Delta Query (AppleScript)
Instead of reparsing the entire 20k+ song XML (which takes ~60s), we use AppleScript to ask Music.app for specific updates.

**The Workflow:**
1.  Frontend receives `music-library-changed`.
2.  Frontend retrieves `last_sync_time` from `localStorage` (or defaults to 24h ago).
3.  Frontend calculates `since_timestamp` with a **10-minute safety buffer** (querying `Now - 10m` to ensure no overlap overlap/race condition misses).
4.  Backend executes AppleScript:
    ```applescript
    tell application "Music"
        get every track whose modification date > (sinceTimestamp equivalent)
    end tell
    ```
5.  Backend parses the returned JSON tracks and upserts them into the SQLite database.
6.  Frontend receives the count of updated tracks.

### Why AppleScript?
Initial attempts used JXA (JavaScript for Automation). However, JXA has a known bug/limitation where comparing `modificationDate` objects with external dates is flaky and often returns 0 results. Pure AppleScript handles the date coercion correctly.

## Frontend Interaction
*   The `App.tsx` component sets up the listener on mount.
*   Shows a "Syncing..." success toast when change is detected.
*   Shows a "Synced X altered tracks" toast upon completion.
*   Updates `last_sync_time` in local storage only on success.
