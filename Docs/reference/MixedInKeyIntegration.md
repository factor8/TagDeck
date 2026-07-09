# Mixed In Key 8 Integration

## Overview
TagDeck can hand selected tracks to **Mixed In Key 8** (MiK8), an external macOS app, for harmonic/tempo analysis. MiK8 writes BPM, musical key, and energy directly into each file's metadata (BPM field + comment/grouping). TagDeck never computes BPM or key itself — it launches MiK8, waits for the files to change on disk, then re-reads the updated metadata into its database.

macOS only. On any other platform the command returns an error.

## User Flow
1. Right-click one or more tracks in the track list.
2. Click **"Analyze with Mixed In Key"** (labeled **"Analyze with Mixed In Key (N tracks)"** when a multi-selection is active).
3. MiK8 opens, analyzes the files, and quits. TagDeck refreshes the affected rows so new BPM/key values appear.

Spotify/ghost tracks (no local file) are excluded from the selection automatically.

## Components

### Context menu — `src/components/TrackList.tsx` (~line 2145)
The menu item (Lucide `Activity` icon) collects the target tracks (the current multi-selection, or just the right-clicked row), filters out `source === 'spotify'`, and invokes the backend:

```ts
await invoke('analyze_with_mixed_in_key', { trackIds, filePaths });
onRefresh?.();
```

Feedback is intentionally minimal: on success it `console.log`s and calls `onRefresh()`; on failure it `console.error`s and shows an `alert(...)`. There are **no** per-row progress indicators, toasts, or a `processingTracks` map — the whole operation blocks in Rust and returns once done.

### Backend command — `src-tauri/src/commands.rs` (`analyze_with_mixed_in_key`, ~line 164)
```rust
pub async fn analyze_with_mixed_in_key(
    app: tauri::AppHandle,
    track_ids: Vec<i64>,
    file_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String>
```
Registered in `src-tauri/src/lib.rs` (~line 159). It returns `()` on success (not a list of sent IDs). Steps:

1. **Validate MiK8 is installed** — checks `/Applications/Mixed In Key 8.app` exists; otherwise returns `"Mixed In Key 8 not found. Please install from https://mixedinkey.com/"`.
2. **Capture baseline mod-times** — verifies each `file_path` exists and records its current `std::fs::metadata(...).modified()`.
3. **Launch via AppleScript** — builds an `osascript` script that activates MiK8, `open`s each file (passed as a `POSIX file "…"` list), and delays to let processing start. It is `spawn`ed (fire-and-forget):
   ```applescript
   tell application "Mixed In Key 8"
       activate
       delay 1
       set fileList to {POSIX file "…", …}
       repeat with aFile in fileList
           try
               open aFile
           end try
       end repeat
       delay 3
   end tell
   ```
   (This replaces the naive `open -a "Mixed In Key 8"` approach — MiK8 needs to be scripted, not just opened with paths.)
4. **Poll for completion (all-Rust blocking loop)** — every 2 s, compare each file's current mod-time against its baseline; when every file's mod-time has advanced, stop. A timeout of `10 + 15 * n` seconds (base + per-file) bounds the wait; on timeout it logs how many of `n` files were processed and breaks.
5. **Quit MiK8** — after a 1 s settle delay, sends a `quit` AppleScript via `osascript`.
6. **Refresh metadata** — for each `track_id`, calls the internal helper `refresh_track_metadata_from_file(&db, id)` and logs a `"… X of N tracks updated"` summary.

Progress and errors are recorded through `LogState::add_log` (visible in the app's log view), not surfaced as UI toasts.

### Metadata refresh — `refresh_track_metadata_from_file` (same file, ~line 303)
Re-reads the file MiK8 just modified and writes the values back into the DB:
- Comment + grouping via `metadata::read_metadata(path)` (returns `(comment, grouping)`).
- BPM via lofty's `ItemKey::Bpm` (`tag.get_string(&ItemKey::Bpm)`, parsed to `i64`, default `0`) — see `src-tauri/src/metadata.rs`.
- Updates `comment_raw`, `grouping_raw`, and `bpm` on the track and persists with `db.update_track`.

No conflict resolution or diffing — TagDeck simply accepts whatever MiK8 wrote.

## Where the BPM ends up
The BPM read back from MiK8 flows through normal TagDeck storage and is exported to rekordbox: `src-tauri/src/rekordbox.rs` writes it as the `AverageBpm` attribute (e.g. `AverageBpm="128.00"`) when `bpm > 0`.

## Notes / Limitations
- **macOS only** — the non-macOS branch returns an error immediately.
- **Synchronous & blocking** — the command does not return until MiK8 finishes (or the timeout elapses), so the UI awaits it directly.
- The MiK8 app path is hard-coded to `/Applications/Mixed In Key 8.app`; non-standard install locations are not supported.
- There are no `get_file_mod_time` / `get_file_mod_times` helper commands — mod-time tracking lives entirely inside `analyze_with_mixed_in_key`.
