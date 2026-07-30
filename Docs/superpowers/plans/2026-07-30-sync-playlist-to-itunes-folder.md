# Sync a TagDeck Playlist to a Chosen iTunes Subfolder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user right-click a TagDeck playlist, pick a folder in the iTunes playlist tree (or root) via a dialog, and create the playlist there in Music.app — auto-importing any tracks not yet in the Music library — while keeping the existing ongoing linked-sync behavior.

**Architecture:** Extend the enable path of the existing per-playlist "Sync to iTunes" feature. A new Rust command `sync_playlist_to_itunes(playlist_id, target_folder_persistent_id)` creates the playlist inside the chosen folder (new folder-aware AppleScript helper), populates it from a new DB helper that includes unlinked tracks (find-or-import each), then adopts Music's persistent ID and flags `itunes_sync_enabled`. The frontend adds a `SyncToItunesDialog` that builds its folder tree from a pure, unit-tested helper. Disabling sync ("Stop Syncing") is unchanged.

**Tech Stack:** Rust (Tauri commands, `osascript` AppleScript, rusqlite), React + TypeScript, vitest (pure-logic tests only), lucide-react icons.

## Global Constraints

- macOS-only feature; all Music.app interaction shells out to `osascript` in `src-tauri/src/apple_music.rs`.
- Never hold the DB lock (`state.db.lock()`) across an `osascript` call — capture data, drop the lock, run AppleScript, re-lock to write. Follow `set_playlist_sync` ([commands.rs:1483](../../../src-tauri/src/commands.rs)).
- AppleScript string values must be escaped with `.replace('\\', "\\\\").replace('"', "\\\"")` (existing idiom).
- Creating a playlist in Music.app is a push; gate it on Two-way sync mode (`LibraryConfig::sync_mode(&db).push_enabled()`), matching the existing create path.
- Frontend tests are **pure logic only** — vitest config is `environment: "node"`, `include: ["src/**/*.test.ts"]` (no `.tsx`, no DOM). React components are verified manually, not with component tests.
- Rust DB tests use `Database::new(":memory:")` inside `#[cfg(test)] mod tests`.
- Commit after each task.

---

## File Structure

- **`src-tauri/src/db.rs`** — add `get_playlist_tracks_for_itunes_sync` (per-track id/path/pid/missing, includes unlinked tracks) + its test.
- **`src-tauri/src/apple_music.rs`** — add pure `build_create_in_folder_script` + `create_playlist_in_folder` + test.
- **`src-tauri/src/commands.rs`** — add `SyncToItunesReport`, pure `classify_track` + `TrackSyncAction`, the `sync_playlist_to_itunes` command, and a `classify_track` test.
- **`src-tauri/src/lib.rs`** — register the new command.
- **`src/components/itunesFolderTree.ts`** (new) — pure `buildItunesFolderTree` + `ItunesFolderNode`.
- **`src/components/itunesFolderTree.test.ts`** (new) — its tests.
- **`src/components/SyncToItunesDialog.tsx`** (new) — the modal folder picker.
- **`src/components/Sidebar.tsx`** — open the dialog from the context menu; render it.
- **`src/App.css`** — a few classes for the dialog tree rows.
- **`Docs/reference/LibraryStrategy.md`**, **`Docs/CHANGELOG.md`**, **`USER_TASKS.md`** — docs + manual-test items.

---

### Task 1: DB helper — playlist tracks for iTunes sync (incl. unlinked)

**Files:**
- Modify: `src-tauri/src/db.rs` (add method after `get_playlist_tracks_for_export`, ends ~line 2041; add test in `mod tests`, starts line 2591)
- Test: same file, `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `Database::get_playlist_tracks_for_itunes_sync(&self, playlist_id: i64) -> anyhow::Result<Vec<(i64, String, Option<String>, bool)>>` — ordered `(track_id, file_path, itunes_pid, missing)` for every track in the playlist, including tracks with no `itunes_pid`.

- [ ] **Step 1: Write the failing test**

Add inside `mod tests` in `src-tauri/src/db.rs` (the module already has the `ghost` helper and `Database::new(":memory:")` pattern):

```rust
    #[test]
    fn playlist_tracks_for_itunes_sync_includes_unlinked_in_order() {
        let db = Database::new(":memory:").unwrap();
        let pl = db.create_playlist("Crate", None, false, "PL-1").unwrap();

        // Three local tracks, inserted in order.
        let mut ids = Vec::new();
        for i in 0..3 {
            let mut t = ghost(&format!("sync-{}", i));
            t.source = "local".into();
            t.spotify_id = None;
            t.file_path = format!("/Music/{}.mp3", i);
            ids.push(db.insert_imported_track(&t, None, None).unwrap());
        }
        for id in &ids {
            db.add_track_to_playlist_db(pl.id, *id).unwrap();
        }

        // Middle track is linked to Music.app; last track is missing on disk.
        db.link_track_itunes_pid(ids[1], "MUSICPID2").unwrap();
        db.set_track_missing(ids[2], true).unwrap();

        let rows = db.get_playlist_tracks_for_itunes_sync(pl.id).unwrap();
        assert_eq!(rows.iter().map(|r| r.0).collect::<Vec<_>>(), ids, "order preserved");
        assert_eq!(rows[0].2, None);
        assert_eq!(rows[1].2, Some("MUSICPID2".to_string()));
        assert_eq!(rows[2].2, None);
        assert!(!rows[0].3, "track 0 present");
        assert!(rows[2].3, "track 2 flagged missing");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test playlist_tracks_for_itunes_sync_includes_unlinked_in_order`
Expected: FAIL — `no method named get_playlist_tracks_for_itunes_sync`.

- [ ] **Step 3: Write minimal implementation**

Add this method to the `impl Database` block, right after `get_playlist_tracks_for_export` (near line 2041) in `src-tauri/src/db.rs`:

```rust
    /// Ordered (track_id, file_path, itunes_pid, missing) for every track in a
    /// playlist — including tracks with no Music.app link, so the caller can
    /// auto-import them. Contrast with `get_playlist_linked_track_pids`, which
    /// drops unlinked tracks.
    pub fn get_playlist_tracks_for_itunes_sync(
        &self,
        playlist_id: i64,
    ) -> Result<Vec<(i64, String, Option<String>, bool)>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.file_path, t.itunes_pid, COALESCE(t.missing, 0)
             FROM playlist_tracks pt
             JOIN tracks t ON t.id = pt.track_id
             WHERE pt.playlist_id = ?1
             ORDER BY pt.position ASC",
        )?;
        let rows = stmt
            .query_map(params![playlist_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?;
        Ok(rows)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test playlist_tracks_for_itunes_sync_includes_unlinked_in_order`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(db): playlist tracks helper for iTunes sync (includes unlinked)"
```

---

### Task 2: Folder-aware playlist-creation AppleScript

**Files:**
- Modify: `src-tauri/src/apple_music.rs` (add both fns near `create_playlist_in_music`, ends ~line 1071; add test in `mod tests`, starts line 1169)
- Test: same file, `#[cfg(test)] mod tests`

**Interfaces:**
- Produces:
  - `fn build_create_in_folder_script(name: &str, folder_pid: Option<&str>) -> String` (module-private, pure)
  - `pub fn create_playlist_in_folder(name: &str, folder_pid: Option<&str>) -> anyhow::Result<String>` — creates a user playlist in Music.app inside `folder_pid` (root when `None`), returns the new playlist's persistent ID.

**Note on the AppleScript form:** this uses `make new user playlist at theFolder …` (spec approach A). Music.app's folder-targeting is version-sensitive; if live testing (Task 6 manual item) shows it fails, the documented fallback is to create at root then `move thePlaylist to theFolder`. Only the body of `build_create_in_folder_script`'s `Some` branch changes; the signatures and tests stay.

- [ ] **Step 1: Write the failing test**

Add inside `mod tests` in `src-tauri/src/apple_music.rs`:

```rust
    #[test]
    fn create_in_folder_script_targets_folder_and_escapes() {
        // Root form: no folder lookup, name escaped.
        let root = build_create_in_folder_script(r#"My "Best" Set"#, None);
        assert!(!root.contains("whose persistent ID"));
        assert!(root.contains(r#"name:"My \"Best\" Set""#));

        // Folder form: resolves the folder by persistent ID, creates inside it.
        let nested = build_create_in_folder_script("Summer", Some("ABC123"));
        assert!(nested.contains(r#"first user playlist whose persistent ID is "ABC123""#));
        assert!(nested.contains("make new user playlist at theFolder"));
        assert!(nested.contains(r#"name:"Summer""#));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test create_in_folder_script_targets_folder_and_escapes`
Expected: FAIL — `cannot find function build_create_in_folder_script`.

- [ ] **Step 3: Write minimal implementation**

Add both functions to `src-tauri/src/apple_music.rs`, immediately after `create_playlist_in_music` (after line 1071):

```rust
/// Builds the AppleScript that creates a user playlist named `name` inside the
/// folder whose persistent ID is `folder_pid` (or at the root when `None`).
/// Pure (no osascript) so escaping and folder targeting are unit-testable.
fn build_create_in_folder_script(name: &str, folder_pid: Option<&str>) -> String {
    let escaped_name = name.replace('\\', "\\\\").replace('"', "\\\"");
    match folder_pid {
        None => format!(
            r#"
            tell application "Music"
                set thePlaylist to (make new user playlist with properties {{name:"{}"}})
                return persistent ID of thePlaylist
            end tell
            "#,
            escaped_name
        ),
        Some(pid) => {
            let escaped_pid = pid.replace('\\', "\\\\").replace('"', "\\\"");
            format!(
                r#"
                tell application "Music"
                    set theFolder to (first user playlist whose persistent ID is "{}")
                    set thePlaylist to (make new user playlist at theFolder with properties {{name:"{}"}})
                    return persistent ID of thePlaylist
                end tell
                "#,
                escaped_pid, escaped_name
            )
        }
    }
}

/// Creates a playlist in Music.app inside `folder_pid` (root when `None`) and
/// returns the new playlist's persistent ID.
pub fn create_playlist_in_folder(name: &str, folder_pid: Option<&str>) -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        let script = build_create_in_folder_script(name, folder_pid);
        let output = Command::new("osascript").arg("-e").arg(&script).output()?;
        if !output.status.success() {
            return Err(anyhow::anyhow!(
                "AppleScript error (create_playlist_in_folder): {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let pid = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if pid.is_empty() {
            return Err(anyhow::anyhow!(
                "Music.app did not return a persistent ID for the new playlist"
            ));
        }
        return Ok(pid);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (name, folder_pid);
        Err(anyhow::anyhow!("Music.app playlists are only supported on macOS"))
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test create_in_folder_script_targets_folder_and_escapes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/apple_music.rs
git commit -m "feat(apple-music): create playlist inside a chosen iTunes folder"
```

---

### Task 3: `sync_playlist_to_itunes` command + track routing

**Files:**
- Modify: `src-tauri/src/commands.rs` (add struct + `classify_track`/`TrackSyncAction` + command; test in `mod tests`, line 3237)
- Modify: `src-tauri/src/lib.rs` (register command after `set_playlist_sync`, line 172)

**Interfaces:**
- Consumes: `Database::get_playlist_tracks_for_itunes_sync` (Task 1); `apple_music::create_playlist_in_folder` (Task 2); existing `apple_music::{is_apple_music_available, playlist_exists_in_music, find_track_in_music_by_path, add_file_to_music_library, add_track_to_playlist}`; existing `Database::{get_playlist_basic, link_track_itunes_pid, relink_playlist_persistent_id, set_playlist_sync_enabled}`; `LibraryConfig::sync_mode`.
- Produces: `#[tauri::command] async fn sync_playlist_to_itunes(app, playlist_id: i64, target_folder_persistent_id: Option<String>, state) -> Result<SyncToItunesReport, String>` where `SyncToItunesReport { added: usize, auto_imported: usize, skipped_missing: usize }` (serde `Serialize`). Frontend invoke key: `syncPlaylistToItunes`? No — Tauri maps camelCase JS args to snake_case Rust; the JS call uses `invoke('sync_playlist_to_itunes', { playlistId, targetFolderPersistentId })`.

- [ ] **Step 1: Write the failing test**

Add inside `mod tests` in `src-tauri/src/commands.rs`:

```rust
    #[test]
    fn classify_track_prioritizes_existing_link() {
        use super::{classify_track, TrackSyncAction};
        assert_eq!(
            classify_track(Some("PID"), false),
            TrackSyncAction::UseExisting("PID".into())
        );
        assert_eq!(classify_track(None, true), TrackSyncAction::FindOrImport);
        // An empty pid is treated as "no link".
        assert_eq!(classify_track(Some(""), true), TrackSyncAction::FindOrImport);
        assert_eq!(classify_track(None, false), TrackSyncAction::SkipMissing);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test classify_track_prioritizes_existing_link`
Expected: FAIL — `cannot find function classify_track` / `TrackSyncAction`.

- [ ] **Step 3: Write minimal implementation**

Add the report struct, the routing enum + pure function, and the command to `src-tauri/src/commands.rs` (place near `set_playlist_sync`, after line 1561):

```rust
#[derive(serde::Serialize, Default)]
pub struct SyncToItunesReport {
    /// Tracks placed in the new iTunes playlist.
    pub added: usize,
    /// Of `added`, how many were imported into the Music library first.
    pub auto_imported: usize,
    /// Tracks skipped because they aren't in iTunes and have no file on disk.
    pub skipped_missing: usize,
}

/// What to do with one playlist track when syncing to Music.app.
#[derive(Debug, PartialEq)]
enum TrackSyncAction {
    /// Already linked to a Music.app track; add it by that persistent ID.
    UseExisting(String),
    /// Not linked but the file is on disk; find-or-import, then add.
    FindOrImport,
    /// Not linked and no usable file; skip and count as missing.
    SkipMissing,
}

fn classify_track(itunes_pid: Option<&str>, file_exists: bool) -> TrackSyncAction {
    match itunes_pid {
        Some(pid) if !pid.is_empty() => TrackSyncAction::UseExisting(pid.to_string()),
        _ if file_exists => TrackSyncAction::FindOrImport,
        _ => TrackSyncAction::SkipMissing,
    }
}

/// Creates a TagDeck playlist in Music.app inside a chosen folder (root when
/// `target_folder_persistent_id` is None), populating it with all of the
/// playlist's tracks — importing any not yet in the Music library — then links
/// the playlist for ongoing sync. Enable-only; disabling still goes through
/// `set_playlist_sync(id, false)`.
#[tauri::command]
pub async fn sync_playlist_to_itunes(
    app: tauri::AppHandle,
    playlist_id: i64,
    target_folder_persistent_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<SyncToItunesReport, String> {
    // Basic facts.
    let (pid, name, is_folder) = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.get_playlist_basic(playlist_id).map_err(|e| e.to_string())?
    };
    if is_folder {
        return Err("Folders can't be synced to iTunes yet — sync the playlists inside them individually.".to_string());
    }

    // Availability + already-synced guards.
    if !crate::apple_music::is_apple_music_available() {
        return Err("Music.app is not available on this system.".to_string());
    }
    if crate::apple_music::playlist_exists_in_music(&pid)
        .map_err(|e| format!("Couldn't check Music.app for this playlist: {}", e))?
    {
        return Err("This playlist is already in iTunes.".to_string());
    }

    // Creating a playlist in Music.app is a push — require Two-way sync,
    // matching set_playlist_sync.
    let push_ok = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        LibraryConfig::sync_mode(&db).push_enabled()
    };
    if !push_ok {
        return Err("Turn on Two-way sync to create playlists in iTunes.".to_string());
    }

    // All tracks, in order, with their link + missing state.
    let tracks = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.get_playlist_tracks_for_itunes_sync(playlist_id).map_err(|e| e.to_string())?
    };

    // Create the playlist in the chosen folder (root when None).
    let new_pid = crate::apple_music::create_playlist_in_folder(
        &name,
        target_folder_persistent_id.as_deref(),
    )
    .map_err(|e| format!("Failed to create playlist in Music.app: {}", e))?;

    // Populate — importing files not yet in the Music library.
    let mut report = SyncToItunesReport::default();
    for (track_id, file_path, itunes_pid, _missing) in &tracks {
        let file_exists = !file_path.is_empty() && std::path::Path::new(file_path).is_file();
        let track_pid = match classify_track(itunes_pid.as_deref(), file_exists) {
            TrackSyncAction::UseExisting(existing) => existing,
            TrackSyncAction::SkipMissing => {
                report.skipped_missing += 1;
                continue;
            }
            TrackSyncAction::FindOrImport => {
                match crate::apple_music::find_track_in_music_by_path(file_path) {
                    Ok(Some(existing)) => existing,
                    Ok(None) => match crate::apple_music::add_file_to_music_library(file_path) {
                        Ok(added_pid) => {
                            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
                            let _ = db.link_track_itunes_pid(*track_id, &added_pid);
                            report.auto_imported += 1;
                            added_pid
                        }
                        Err(e) => {
                            let msg = format!("Couldn't add {} to Music.app: {}", file_path, e);
                            app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
                            report.skipped_missing += 1;
                            continue;
                        }
                    },
                    Err(e) => {
                        let msg = format!("Music.app lookup failed for {}: {}", file_path, e);
                        app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
                        report.skipped_missing += 1;
                        continue;
                    }
                }
            }
        };
        if let Err(e) = add_track_to_playlist(&track_pid, &new_pid) {
            let msg = format!("Failed to add track {} to new iTunes playlist: {}", track_pid, e);
            app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
            continue;
        }
        report.added += 1;
    }

    // Adopt Music's persistent ID and flag ongoing sync.
    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.relink_playlist_persistent_id(playlist_id, &new_pid).map_err(|e| e.to_string())?;
        db.set_playlist_sync_enabled(playlist_id, true).map_err(|e| e.to_string())?;
    }

    let msg = format!(
        "Synced playlist \"{}\" to iTunes: {} added ({} imported), {} skipped",
        name, report.added, report.auto_imported, report.skipped_missing
    );
    app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);
    Ok(report)
}
```

- [ ] **Step 4: Register the command**

In `src-tauri/src/lib.rs`, add a line to the `generate_handler!` list immediately after `commands::set_playlist_sync,` (line 172):

```rust
            commands::sync_playlist_to_itunes,
```

- [ ] **Step 5: Run test + build to verify**

Run: `cd src-tauri && cargo test classify_track_prioritizes_existing_link && cargo build`
Expected: test PASS; build succeeds (command compiles and is registered).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(itunes): sync_playlist_to_itunes command with folder target + auto-import"
```

---

### Task 4: Pure iTunes folder-tree builder (frontend)

**Files:**
- Create: `src/components/itunesFolderTree.ts`
- Test: `src/components/itunesFolderTree.test.ts`

**Interfaces:**
- Produces:
  - `interface ItunesFolderNode { persistent_id: string; name: string; children: ItunesFolderNode[]; }`
  - `function buildItunesFolderTree(playlists: Playlist[]): ItunesFolderNode[]` — only `is_folder && origin === 'itunes'` playlists, nested by `parent_persistent_id`, siblings sorted by name. A folder whose parent isn't an included iTunes folder becomes a root.

- [ ] **Step 1: Write the failing test**

Create `src/components/itunesFolderTree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildItunesFolderTree } from './itunesFolderTree';
import { Playlist } from '../types';

const pl = (over: Partial<Playlist>): Playlist => ({
  id: 0, persistent_id: 'x', name: 'x', is_folder: false, origin: 'itunes',
  itunes_sync_enabled: false, sort_position: 0, created_at: 0, updated_at: 0,
  ...over,
});

describe('buildItunesFolderTree', () => {
  it('includes only iTunes folders and nests by parent', () => {
    const tree = buildItunesFolderTree([
      pl({ persistent_id: 'F1', name: 'DJ Sets', is_folder: true }),
      pl({ persistent_id: 'F2', name: '2026', is_folder: true, parent_persistent_id: 'F1' }),
      pl({ persistent_id: 'P1', name: 'A Playlist', is_folder: false, parent_persistent_id: 'F1' }),
      pl({ persistent_id: 'TD', name: 'TD Folder', is_folder: true, origin: 'tagdeck' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].persistent_id).toBe('F1');
    expect(tree[0].children.map(c => c.persistent_id)).toEqual(['F2']);
  });

  it('sorts siblings case-insensitively', () => {
    const tree = buildItunesFolderTree([
      pl({ persistent_id: 'b', name: 'beta', is_folder: true }),
      pl({ persistent_id: 'a', name: 'Alpha', is_folder: true }),
    ]);
    expect(tree.map(n => n.name)).toEqual(['Alpha', 'beta']);
  });

  it('treats a folder with a missing/foreign parent as a root', () => {
    const tree = buildItunesFolderTree([
      pl({ persistent_id: 'F2', name: 'Orphan', is_folder: true, parent_persistent_id: 'MISSING' }),
    ]);
    expect(tree.map(n => n.persistent_id)).toEqual(['F2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- itunesFolderTree`
Expected: FAIL — cannot resolve `./itunesFolderTree`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/itunesFolderTree.ts`:

```ts
import { Playlist } from '../types';

export interface ItunesFolderNode {
  persistent_id: string;
  name: string;
  children: ItunesFolderNode[];
}

/**
 * Builds the iTunes folder hierarchy for the "Sync to iTunes" picker from the
 * full playlist list. Only folders that originate from iTunes are included
 * (Music.app playlists can't contain playlists). Folders nest by
 * parent_persistent_id; a folder whose parent isn't itself an included iTunes
 * folder becomes a root. Siblings are sorted by name (case-insensitive).
 */
export function buildItunesFolderTree(playlists: Playlist[]): ItunesFolderNode[] {
  const folders = playlists.filter(p => p.is_folder && p.origin === 'itunes');
  const byPid = new Map<string, ItunesFolderNode>();
  folders.forEach(f => byPid.set(f.persistent_id, {
    persistent_id: f.persistent_id,
    name: f.name,
    children: [],
  }));

  const roots: ItunesFolderNode[] = [];
  folders.forEach(f => {
    const node = byPid.get(f.persistent_id)!;
    const parent = f.parent_persistent_id ? byPid.get(f.parent_persistent_id) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });

  const sortRec = (nodes: ItunesFolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach(n => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- itunesFolderTree`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/itunesFolderTree.ts src/components/itunesFolderTree.test.ts
git commit -m "feat(sidebar): pure iTunes folder-tree builder for sync picker"
```

---

### Task 5: `SyncToItunesDialog` component + Sidebar wiring

**Files:**
- Create: `src/components/SyncToItunesDialog.tsx`
- Modify: `src/components/Sidebar.tsx` (import + state + context-menu item at lines 1297-1307 + render near delete dialog ~line 1407)
- Modify: `src/App.css` (dialog tree row classes)

**Interfaces:**
- Consumes: `buildItunesFolderTree`, `ItunesFolderNode` (Task 4); `sync_playlist_to_itunes` command (Task 3); existing `useToast`, `Playlist` type.
- Produces: `export function SyncToItunesDialog(props: { playlist: Playlist; playlists: Playlist[]; onClose: () => void; onSynced: () => void; })`.

This task has no automated test (React component / DOM — excluded by the vitest config). Verify by building and by the manual checklist in Task 6.

- [ ] **Step 1: Create the dialog component**

Create `src/components/SyncToItunesDialog.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, ChevronDown, Folder, Music } from 'lucide-react';
import { Playlist } from '../types';
import { buildItunesFolderTree, ItunesFolderNode } from './itunesFolderTree';
import { useToast } from './Toast';

interface SyncToItunesReport {
  added: number;
  auto_imported: number;
  skipped_missing: number;
}

interface Props {
  playlist: Playlist;
  playlists: Playlist[];
  onClose: () => void;
  onSynced: () => void;
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 10000, display: 'flex',
  alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)',
};

export function SyncToItunesDialog({ playlist, playlists, onClose, onSynced }: Props) {
  const { showSuccess, showError } = useToast();
  const tree = useMemo(() => buildItunesFolderTree(playlists), [playlists]);
  const [selected, setSelected] = useState<string | null>(null); // null = root
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (pid: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });

  const selectedName = selected
    ? playlists.find(p => p.persistent_id === selected)?.name ?? 'folder'
    : null;

  const doSync = async () => {
    setBusy(true);
    try {
      const report = await invoke<SyncToItunesReport>('sync_playlist_to_itunes', {
        playlistId: playlist.id,
        targetFolderPersistentId: selected,
      });
      const where = selectedName ? ` › ${selectedName}` : '';
      let msg = `Synced "${playlist.name}" to iTunes${where} — ${report.added} track${report.added !== 1 ? 's' : ''}`;
      const extras: string[] = [];
      if (report.auto_imported > 0) extras.push(`${report.auto_imported} imported`);
      if (report.skipped_missing > 0) extras.push(`${report.skipped_missing} skipped`);
      if (extras.length) msg += ` (${extras.join(', ')})`;
      showSuccess(msg);
      onSynced();
      onClose();
    } catch (err) {
      showError(typeof err === 'string' ? err : `Sync failed: ${err}`);
      setBusy(false);
    }
  };

  const renderNode = (node: ItunesFolderNode, level: number) => {
    const isExpanded = expanded.has(node.persistent_id);
    const hasChildren = node.children.length > 0;
    return (
      <div key={node.persistent_id}>
        <div
          className={`sti-row${selected === node.persistent_id ? ' sti-row-selected' : ''}`}
          style={{ paddingLeft: 8 + level * 16 }}
          onClick={() => setSelected(node.persistent_id)}
        >
          <span
            className="sti-caret"
            onClick={(e) => { e.stopPropagation(); if (hasChildren) toggle(node.persistent_id); }}
          >
            {hasChildren
              ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)
              : <span style={{ width: 14, display: 'inline-block' }} />}
          </span>
          <Folder size={14} /> <span>{node.name}</span>
        </div>
        {isExpanded && node.children.map(c => renderNode(c, level + 1))}
      </div>
    );
  };

  return (
    <div style={overlayStyle} onClick={busy ? undefined : onClose}>
      <div
        className="sidebar-delete-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
          borderRadius: '8px', padding: '20px', maxWidth: '380px', width: '90%',
        }}
      >
        <h3 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>
          Sync &ldquo;{playlist.name}&rdquo; to iTunes
        </h3>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)' }}>
          Choose where it should appear in your iTunes playlist tree.
        </p>
        <div className="sti-tree">
          <div
            className={`sti-row${selected === null ? ' sti-row-selected' : ''}`}
            style={{ paddingLeft: 8 }}
            onClick={() => setSelected(null)}
          >
            <span style={{ width: 14, display: 'inline-block' }} />
            <Music size={14} /> <span>(Top level / root)</span>
          </div>
          {tree.map(n => renderNode(n, 0))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={doSync} disabled={busy}>
            {busy ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add dialog CSS**

Append to `src/App.css`:

```css
/* Sync-to-iTunes folder picker */
.sti-tree {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 4px;
}
.sti-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
}
.sti-row:hover { background: var(--bg-hover, rgba(127,127,127,0.12)); }
.sti-row-selected { background: var(--accent-color, #3b82f6); color: #fff; }
.sti-caret {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}
```

- [ ] **Step 3: Wire into Sidebar — import + state**

In `src/components/Sidebar.tsx`, add the import next to the other component imports (after line 10):

```tsx
import { SyncToItunesDialog } from './SyncToItunesDialog';
```

Add state next to `deleteTarget` (after line 338):

```tsx
  // Sync-to-iTunes folder picker target (null = closed)
  const [syncDialogTarget, setSyncDialogTarget] = useState<PlaylistNode | null>(null);
```

- [ ] **Step 4: Open the dialog from the context menu**

In `src/components/Sidebar.tsx`, replace the not-yet-synced "Sync to iTunes" button (currently lines 1297-1307, the `: (` branch) with a version that opens the dialog and shows an ellipsis:

```tsx
                                  ) : (
                                      <button
                                          className="ctx-item"
                                          disabled={appleMusicAvailable === false}
                                          title={appleMusicAvailable === false ? 'Music.app not detected' : undefined}
                                          onClick={() => { const n = contextMenu.node!; setContextMenu(null); setSyncDialogTarget(n); }}
                                      >
                                          <Music size={14} /> Sync to iTunes…
                                      </button>
                                  )
```

(The already-synced branch "Stop Syncing with iTunes" at lines 1289-1296 is unchanged.)

- [ ] **Step 5: Render the dialog**

In `src/components/Sidebar.tsx`, add just before the closing `</div>` that ends the component (right after the delete-confirmation dialog block, which closes near line 1407):

```tsx
      {syncDialogTarget && (
          <SyncToItunesDialog
              playlist={syncDialogTarget}
              playlists={playlists}
              onClose={() => setSyncDialogTarget(null)}
              onSynced={refreshPlaylists}
          />
      )}
```

- [ ] **Step 6: Verify build + lint**

Run: `npm run build`
Expected: TypeScript compiles with no errors; Vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/SyncToItunesDialog.tsx src/components/Sidebar.tsx src/App.css
git commit -m "feat(sidebar): Sync to iTunes dialog with folder picker"
```

---

### Task 6: Docs, changelog, and manual-test checklist

**Files:**
- Modify: `Docs/reference/LibraryStrategy.md` (per-playlist sync section)
- Modify: `Docs/CHANGELOG.md` (`[Unreleased]` → Added)
- Modify: `USER_TASKS.md` (manual tests requiring a live Music.app)

- [ ] **Step 1: Update the CHANGELOG**

In `Docs/CHANGELOG.md`, under `[Unreleased]` → `Added`, add:

```markdown
- **Sync to iTunes → choose a folder.** Right-clicking a playlist and choosing "Sync to iTunes…" now opens a picker for the target folder in your iTunes playlist tree (or the root). Tracks not yet in your Music library are imported automatically; tracks whose file is missing on disk are skipped and reported.
```

- [ ] **Step 2: Update LibraryStrategy.md**

In `Docs/reference/LibraryStrategy.md`, in the per-playlist sync section (around lines 62-69, the "Sync to iTunes" action), append a sentence:

```markdown
When enabling sync via the "Sync to iTunes…" picker, the playlist is created inside the chosen iTunes folder (or the root), and any of its tracks not yet in the Music library are imported first (via `add_file_to_music_library`); tracks whose file is missing on disk are skipped. Implemented by the `sync_playlist_to_itunes` command; disabling still uses `set_playlist_sync(id, false)`.
```

- [ ] **Step 3: Add manual-test items to USER_TASKS.md**

In `USER_TASKS.md`, add under the appropriate (non-blocking) manual-test section:

```markdown
- [ ] (2026-07-30) Verify "Sync to iTunes…" folder picker against a live Music.app:
  - [ ] Sync a playlist into a **nested** iTunes folder → it appears in the right place with all tracks in order.
  - [ ] Sync into **root** → appears at top level.
  - [ ] Sync a playlist containing TagDeck-native tracks (not in iTunes) → they're imported and included; missing-on-disk tracks are skipped and reported in the toast.
  - [ ] Pick a folder, delete it in Music.app before clicking Sync → clear error, nothing created.
  - [ ] Confirm the created playlist stays linked (edits push) — i.e. it lands in the sidebar's iTunes section.
  - [ ] If "make new user playlist at folder" fails on this macOS version, switch `build_create_in_folder_script`'s Some-branch to the create-then-`move thePlaylist to theFolder` fallback (see plan Task 2 note).
```

- [ ] **Step 4: Commit**

```bash
git add Docs/reference/LibraryStrategy.md Docs/CHANGELOG.md USER_TASKS.md
git commit -m "docs(itunes): document folder-targeted playlist sync"
```

---

## Self-Review

**Spec coverage:**
- Dialog folder picker (root default, existing folders only) → Tasks 4, 5. ✓
- Enhance existing sync (enable via dialog; disable unchanged) → Task 3 (`sync_playlist_to_itunes`), Task 5 (context item swaps to dialog; Stop Syncing untouched). ✓
- Auto-import unlinked tracks; skip missing-on-disk; report counts → Task 1 (helper incl. unlinked), Task 3 (`classify_track` + find-or-import + report). ✓
- Folder-targeted creation via AppleScript, with fallback documented → Task 2. ✓
- Two-way mode guard, availability guard, already-synced guard, folder-missing error → Task 3 (guards) + Task 2 (folder resolution errors surface). ✓
- Docs (LibraryStrategy, CHANGELOG) + manual tests → Task 6. ✓
- Non-goal (no new-folder creation) respected — picker lists existing folders only (Task 4 filters folders; no create path). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `get_playlist_tracks_for_itunes_sync` returns `(i64, String, Option<String>, bool)` — consumed in Task 3 by destructuring `(track_id, file_path, itunes_pid, _missing)` and `itunes_pid.as_deref()` into `classify_track(Option<&str>, bool)`. `SyncToItunesReport { added, auto_imported, skipped_missing }` matches the frontend `SyncToItunesReport` interface in Task 5. `buildItunesFolderTree`/`ItunesFolderNode` defined in Task 4, imported in Task 5. `create_playlist_in_folder(name, Option<&str>)` defined in Task 2, called with `target_folder_persistent_id.as_deref()` in Task 3. ✓
