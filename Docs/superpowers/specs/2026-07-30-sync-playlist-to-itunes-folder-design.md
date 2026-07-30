# Sync a TagDeck Playlist to a Chosen iTunes Subfolder — Design

**Date:** 2026-07-30
**Status:** Approved, ready for implementation
**Origin:** User request — right-click a TagDeck playlist and add it to iTunes, choosing where in the iTunes playlist-folder tree it lands.

## Problem

TagDeck already has a per-playlist **"Sync to iTunes"** context action
([Sidebar.tsx:1288](../../../src/components/Sidebar.tsx) →
`set_playlist_sync`, [commands.rs:1483](../../../src-tauri/src/commands.rs)).
When enabled on a playlist with no Music.app counterpart, it creates the
playlist in Music.app, adds its linked tracks, adopts Music's persistent ID,
and flags the playlist for ongoing sync.

Two limitations block the user's goal:

1. **Root-only placement.** `create_playlist_in_music`
   ([apple_music.rs:1037](../../../src-tauri/src/apple_music.rs)) always creates
   the new playlist at the **root** of the Music.app playlist tree. There is no
   way to place it inside a chosen folder.
2. **Only already-linked tracks are added.** The create path adds tracks via
   `get_playlist_linked_track_pids` — tracks that already carry a Music.app
   persistent ID. TagDeck-native tracks that were never imported into Music.app
   are silently omitted, so the iTunes playlist can be missing tracks.

## Goal

Extend the enable-sync flow so the user picks a target folder in the iTunes
tree (or the root) via a dialog, and so the created iTunes playlist contains
**all** of the TagDeck playlist's tracks — auto-importing any that aren't in the
Music.app library yet. Ongoing linked-sync behavior is unchanged.

## Non-goals

- Creating new folders in the iTunes tree from the picker (pick existing folders
  only, plus root). Deferred.
- Relocating a playlist that was already synced at the root before this feature.
  The user stops syncing and re-syncs to move it. Deferred.
- Syncing a **folder** of playlists in one action (folders remain individually
  synced, matching the existing guard at
  [commands.rs:1502](../../../src-tauri/src/commands.rs)).

## User flow

1. Right-click a TagDeck playlist (non-folder) that is **not** currently synced.
2. The context item reads **"Sync to iTunes…"** (ellipsis signals a dialog).
3. A modal opens showing the iTunes folder tree with a **"(Top level / root)"**
   option selected by default. The user picks a folder (or root) and clicks
   **Sync**.
4. The playlist is created in Music.app inside that folder, its tracks are added
   (auto-importing any not yet in the library), the playlist adopts Music's
   persistent ID, and `itunes_sync_enabled` is set true.
5. A success toast reports the result, e.g. *"Synced 'Summer Set' to iTunes ›
   DJ Sets — 22 tracks (4 imported, 1 skipped)."*

For a playlist that is **already** synced, the context item stays **"Stop
Syncing"** and remains an instant toggle calling `set_playlist_sync(id, false)`
— unchanged, no dialog.

## Architecture

### 1. Frontend

**Context menu** — [Sidebar.tsx:1288](../../../src/components/Sidebar.tsx):
- When the playlist is not synced, the item label becomes **"Sync to iTunes…"**
  and its handler opens the new dialog instead of calling `set_playlist_sync`
  directly.
- When already synced, the item stays **"Stop Syncing"** → `set_playlist_sync(
  id, false)` (existing `handleToggleSync`).

**New component `SyncToItunesDialog.tsx`** (modal, reusing existing dialog
styles from `App.css`):
- Props: the target playlist (`id`, `name`), an `onClose`, and an `onSynced`
  callback to refresh the sidebar.
- Builds a folder tree from the already-loaded playlists where
  `origin === 'itunes' && is_folder`, nested by `parent_persistent_id`. Reuses
  the tree-building logic already used for the sidebar (`PlaylistNode`); factor
  the shared nesting helper out of `Sidebar.tsx` if practical, otherwise a small
  local builder.
- Renders a single-select tree: **"(Top level / root)"** first (default
  selected, value = `null`), then nested folders by name. Expand/collapse for
  nested folders.
- **Sync** / **Cancel** buttons. While the backend runs, Sync is disabled and
  shows a spinner + status text. On success, calls `showSuccess` with the report
  summary, calls `onSynced`, and closes. On error, `showError` with the message;
  the dialog stays open so the user can retry or cancel.

The folder tree shown is TagDeck's last-imported snapshot of the iTunes tree; it
is not re-fetched live. A folder that was deleted in Music.app since import fails
at sync time with a clear error (see §3), which is acceptable for v1.

### 2. Backend command

New Tauri command in `commands.rs`, modeled on `set_playlist_sync`
([commands.rs:1483](../../../src-tauri/src/commands.rs)) and the find-or-add
logic in `export_tracks_to_music`
([commands.rs:2939](../../../src-tauri/src/commands.rs)). Registered in
`lib.rs`'s `generate_handler!`.

```rust
#[tauri::command]
pub async fn sync_playlist_to_itunes(
    app: tauri::AppHandle,
    playlist_id: i64,
    target_folder_persistent_id: Option<String>, // None = root
    state: State<'_, AppState>,
) -> Result<SyncToItunesReport, String>
```

```rust
pub struct SyncToItunesReport {
    pub added: usize,          // tracks placed in the iTunes playlist
    pub auto_imported: usize,  // tracks added to the Music library first
    pub skipped_missing: usize,// tracks whose file is missing on disk
    pub folder_name: Option<String>, // for the toast; None = root
}
```

Flow:

1. Load `(pid, name, is_folder)` via `get_playlist_basic`. Reject folders with
   the existing message. Reject if the playlist is already synced (dialog
   shouldn't offer it, but guard anyway).
2. **Availability + mode gate.** Require Music.app available
   (`is_apple_music_available`). Creating a playlist in Music.app is a push, so
   — consistent with the existing create path
   ([commands.rs:1521](../../../src-tauri/src/commands.rs)) — require the global
   sync mode to be push-enabled (Two-way); otherwise return the existing
   "Turn on Two-way sync…" error. (Confirm this guard during implementation and
   keep it identical to `set_playlist_sync` for consistency.)
3. **Resolve folder.** If `target_folder_persistent_id` is `Some`, look up the
   folder's name from the DB for the report; the AppleScript resolves it live by
   persistent ID.
4. **Create the playlist in the folder** (see §3). Returns the new Music.app
   persistent ID.
5. **Populate tracks.** For each track from
   `get_playlist_tracks_for_export(playlist_id)` (ordered; yields
   `(path, duration, artist, title, missing)`), in playlist order:
   - If the track already has a Music.app `itunes_pid` that still exists → add it
     to the new playlist via `add_track_to_playlist`, count `added`.
   - Else if the file exists on disk → `find_track_in_music_by_path`; if not
     found, `add_file_to_music_library(path)` (count `auto_imported`); then add
     to the playlist, count `added`.
   - Else (file missing on disk) → skip, count `skipped_missing`.
   - Individual add failures are logged (WARN) and do not abort the whole sync.
6. **Adopt + flag.** `relink_playlist_persistent_id(playlist_id, new_pid)` then
   `set_playlist_sync_enabled(playlist_id, true)`.
7. Log an INFO summary and return the report.

DB lock discipline follows the existing code: never hold the DB lock across an
`osascript` call — capture what's needed, drop the lock, run AppleScript,
re-lock to write (as `set_playlist_sync` already does).

### 3. Folder-placement AppleScript (main technical risk)

New helper in `apple_music.rs` alongside `create_playlist_in_music`:

```rust
// folder_pid: None -> root (delegates to create_playlist_in_music)
pub fn create_playlist_in_folder(name: &str, folder_pid: Option<&str>)
    -> Result<String, String>
```

Music.app's folder-targeting AppleScript is historically version-sensitive, so
two candidate forms — implement **A**, keep **B** as a documented fallback if A
proves unreliable on the target macOS:

- **A (preferred):**
  `make new user playlist at folderRef with properties {name:"…"}`, where
  `folderRef` = `first user playlist whose persistent ID is "<folder_pid>"`.
- **B (fallback):** create at root via the existing statement, then
  `move newPlaylist to folderRef` (or `set parent of newPlaylist to folderRef`).

Both resolve the folder by persistent ID — the same lookup pattern used
throughout `apple_music.rs`. Escape `name` with the existing
`.replace('\\', "\\\\").replace('"', "\\\"")` idiom, and build the script with
placeholder replacement (as `reorder_playlist` does) to avoid brace-escaping
pain. Return the new playlist's persistent ID.

**Error path:** if no folder matches `folder_pid` (deleted since import), the
AppleScript errors; surface a clear message
("That iTunes folder no longer exists — refresh your library and try again.")
and create nothing.

## Error handling

- Music.app unavailable → friendly error, no changes.
- Non-push sync mode → existing "Turn on Two-way sync" error, no changes.
- Target folder missing in Music.app → clear error, nothing created.
- Per-track add failure → logged WARN, counted out of `added`, sync continues.
- All user-facing messages via toasts (`showSuccess` / `showError`), mirroring
  the existing sidebar handlers.

## Testing

**Rust unit tests:**
- Report accounting: given a mix of already-linked, importable, and
  missing-on-disk tracks, the counts (`added` / `auto_imported` /
  `skipped_missing`) are correct.
- Folder-resolution error path returns an error without creating a playlist
  (mock/guard the AppleScript boundary).

**Frontend:**
- Dialog builds the iTunes folder tree correctly, including nesting and the
  default-selected root option.
- Sync button disabled while the command runs; error keeps the dialog open.

**Manual (USER_TASKS.md item — needs a live Music.app):**
- Sync into a nested folder → playlist appears in the right place with all
  tracks.
- Sync into root → appears at top level.
- Sync a playlist containing TagDeck-native tracks → they're imported and
  included; missing-on-disk tracks are skipped and reported.
- Pick a folder, delete it in Music.app before confirming → clear error.

## Documentation

- Update `Docs/reference/LibraryStrategy.md` (per-playlist sync section) to
  describe folder-targeted sync and auto-import of unlinked tracks.
- Add a `Docs/CHANGELOG.md` `[Unreleased]` → Added entry.
- Add the manual-test checklist above to `USER_TASKS.md`.
