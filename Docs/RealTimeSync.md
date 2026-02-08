# Real-Time Synchronization Strategy (Implemented)

> **⚠️ STATUS: UNDER INVESTIGATION**
> While the infrastructure below is implemented, the system currently fails to consistently detect or import changes.
> Symptoms:
> - Watcher detects changes successfully.
> - AppleScript query runs but often returns 0 results despite confirmed modifications.
> - Suspected issues with AppleScript date comparisons or localized date string parsing in Rust.
> - Further troubleshooting required.

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

### 2. Debounce System (Trailing Edge)
Music.app often writes to the database multiple times for a single user action. We use a **trailing-edge** debounce to wait for the activity to settle.
*   **Implementation**: When an event is detected, we start a timer. Every subsequent event resets the timer. We only emit a `music-library-changed` event if **2 seconds** of silence have passed since the last file system event.
*   **Why**: This ensures we don't trigger a sync in the middle of a large write operation (e.g., editing multiple tags).

### 3. Delta Query (AppleScript)
Instead of reparsing the entire 20k+ song XML (which takes ~60s), we use AppleScript to ask Music.app for specific updates.

**The Workflow:**
1.  Frontend receives `music-library-changed`.
2.  Frontend retrieves `last_sync_time` from `localStorage`.
3.  Frontend calculates `since_timestamp` with a **1-hour safety buffer** (querying `Now - 1h`).
    *   *Note: Buffer increased from 10m to 1h to catch missed updates.*
4.  Backend executes AppleScript:
    ```applescript
    tell application "Music"
        get every track whose modification date >= (sinceTimestamp equivalent)
    end tell
    ```
5.  Backend parses the returned JSON tracks and upserts them into the SQLite database.
6.  Frontend receives the count of updated tracks.

### Why AppleScript?
Initial attempts used JXA (JavaScript for Automation). However, JXA has a known bug/limitation where comparing `modificationDate` objects with external dates is flaky and often returns 0 results. Pure AppleScript handles the date coercion correctly `(date "...")`.

## Frontend Interaction
*   **Settings Panel Toggle**: A switch is available in Settings to Enable/Disable Real-Time Sync entirely.
*   The `App.tsx` component sets up the listener on mount (if enabled).
*   Shows a "Syncing..." success toast when change is detected.
*   Shows a "Synced X altered tracks" toast upon completion.
*   Updates `last_sync_time` in local storage only on success.
