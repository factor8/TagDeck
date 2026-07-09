# Playlist System — Full Implementation Plan

## Overview

TagDeck currently ingests playlists from Apple Music (via iTunes XML and JXA sidecar) and keeps them synchronized via a real-time diff engine (Phase 3 of `sync_recent_changes`). However, playlists are **read-only mirrors** — the user cannot create, rename, reorganize, or push new playlists back to Apple Music.

This plan turns the playlist system into a **first-class, bidirectional, self-sufficient** feature:

1. **iTunes-origin playlists** stay synced with Apple Music automatically.
2. **TagDeck-native playlists** can be created, edited, and organized freely.
3. **Folders** can be created in TagDeck to organize any playlists (native or iTunes).
4. **Selective push-back** lets users sync TagDeck playlists/changes to Apple Music on demand.
5. **Smart playlists** (stretch) can auto-populate from tag/filter rules.

---

## Current State (Baseline)

### What exists today

| Layer | What | Where |
|-------|-------|-------|
| **DB Schema** | `playlists` table with `persistent_id`, `parent_persistent_id`, `name`, `is_folder` | [db.rs](../src-tauri/src/db.rs) |
| **DB Schema** | `playlist_tracks` junction with `position` column | [db.rs](../src-tauri/src/db.rs) |
| **Model** | `Playlist` struct with `id`, `persistent_id`, `parent_persistent_id`, `name`, `is_folder`, `track_ids` | [models.rs](../src-tauri/src/models.rs) |
| **Import** | Full library import from Music.app via sidecar binary | [commands.rs](../src-tauri/src/commands.rs) `import_from_music_app` |
| **Sync** | Real-time playlist snapshot diff (add/remove/rename/reorder detection) | [commands.rs](../src-tauri/src/commands.rs) `sync_recent_changes` Phase 3 |
| **AppleScript** | `add_track_to_playlist`, `remove_track_from_playlist`, `reorder_playlist`, `get_playlist_snapshot` | [apple_music.rs](../src-tauri/src/apple_music.rs) |
| **Commands** | `get_playlists`, `get_playlist_track_ids`, `add_to_playlist`, `remove_from_playlist`, `reorder_playlist_tracks` | [commands.rs](../src-tauri/src/commands.rs) |
| **Frontend** | `Sidebar.tsx` — tree view with folders, drag-to-add, expand/collapse, selection | [Sidebar.tsx](../src/components/Sidebar.tsx) |
| **Frontend** | `CopyPlaylistsModal.tsx` — copy playlist memberships between tracks | [CopyPlaylistsModal.tsx](../src/components/CopyPlaylistsModal.tsx) |
| **Types** | `Playlist` interface in TypeScript | [types.ts](../src/types.ts) |

### What's missing

- Cannot **create** a playlist in TagDeck
- Cannot **rename** a playlist
- Cannot **delete** a playlist
- Cannot **create folders** in TagDeck
- Cannot **move** a playlist into/out of a folder
- No concept of **origin** (iTunes vs. TagDeck-native)
- No **push-to-iTunes** capability for TagDeck-native playlists
- No **smart/dynamic playlists** based on tags or filters
- No **duplicate playlist** or **export** functionality
- No context menu on playlists in the sidebar
- No playlist **description** or **color** metadata
- Sidebar has no "New Playlist" or "New Folder" button

---

## Data Model Changes

### Schema Migration (additive — no breaking changes)

```sql
-- New columns on `playlists` table
ALTER TABLE playlists ADD COLUMN origin TEXT DEFAULT 'itunes';
  -- 'itunes'  = imported from Apple Music, synced automatically
  -- 'tagdeck' = created in TagDeck, managed locally

ALTER TABLE playlists ADD COLUMN itunes_sync_enabled BOOLEAN DEFAULT 0;
  -- When true AND origin='tagdeck', TagDeck will push this playlist to Apple Music.
  -- When true AND origin='itunes', TagDeck will push local edits back (rename, reorder, add/remove).

ALTER TABLE playlists ADD COLUMN description TEXT;
  -- Optional user notes for the playlist

ALTER TABLE playlists ADD COLUMN color TEXT;
  -- Optional hex color for sidebar accent (e.g. '#3B82F6')

ALTER TABLE playlists ADD COLUMN sort_position INTEGER DEFAULT 0;
  -- Manual sort order within the parent folder (for TagDeck-native ordering)

ALTER TABLE playlists ADD COLUMN created_at INTEGER DEFAULT 0;
  -- Unix timestamp of creation (useful for "Recently Created" sort)

ALTER TABLE playlists ADD COLUMN updated_at INTEGER DEFAULT 0;
  -- Unix timestamp of last modification
```

### Updated Rust Model

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Playlist {
    pub id: i64,
    pub persistent_id: String,
    pub parent_persistent_id: Option<String>,
    pub name: String,
    pub is_folder: bool,
    pub track_ids: Option<Vec<String>>,
    // New fields
    pub origin: String,                    // "itunes" | "tagdeck"
    pub itunes_sync_enabled: bool,         // push changes to Music.app?
    pub description: Option<String>,
    pub color: Option<String>,
    pub sort_position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}
```

### Updated TypeScript Type

```typescript
export interface Playlist {
    id: number;
    persistent_id: string;
    parent_persistent_id?: string;
    name: string;
    is_folder: boolean;
    // New fields
    origin: 'itunes' | 'tagdeck';
    itunes_sync_enabled: boolean;
    description?: string;
    color?: string;
    sort_position: number;
    created_at: number;
    updated_at: number;
}
```

---

## Implementation Phases

### Phase 1: Foundation — Create & Delete Playlists/Folders

**Goal:** Users can create, rename, and delete playlists and folders natively in TagDeck.

#### Backend (Rust)

1. **DB migrations** — Add all new columns to `playlists` with safe `ALTER TABLE` pattern (already established in `Database::new`).

2. **New Tauri commands:**

   | Command | Parameters | Behavior |
   |---------|-----------|----------|
   | `create_playlist` | `name: String, parent_id: Option<i64>, is_folder: bool` | Generates a `TD-xxx` persistent_id, sets `origin='tagdeck'`, inserts into DB. Returns the new `Playlist`. |
   | `rename_playlist` | `id: i64, name: String` | Updates name in DB. If `itunes_sync_enabled`, also renames in Music.app via AppleScript. |
   | `delete_playlist` | `id: i64` | Deletes from DB (and `playlist_tracks`). If `origin='itunes'` or `itunes_sync_enabled`, does **NOT** delete from Music.app (safety). Shows confirmation dialog first (frontend). |
   | `move_playlist` | `id: i64, new_parent_id: Option<i64>` | Updates `parent_persistent_id`. If moving into a folder, set `parent_persistent_id` to the folder's `persistent_id`. If moving to root, set to `None`. |
   | `update_playlist_metadata` | `id: i64, description: Option<String>, color: Option<String>` | Updates optional metadata fields. |
   | `reorder_playlists` | `parent_id: Option<i64>, ordered_ids: Vec<i64>` | Updates `sort_position` for all siblings within a parent. |
   | `duplicate_playlist` | `id: i64, new_name: String` | Copies playlist and its track memberships. New playlist gets `origin='tagdeck'`. |

3. **DB methods** — Corresponding methods on `Database` struct for each command.

4. **Persistent ID generation** — Reuse the existing `uuid_v4_simple()` pattern with `TD-` prefix to distinguish TagDeck-native playlists from iTunes-origin ones.

5. **Sync guard** — During `sync_recent_changes` Phase 3, skip upserting playlists where `origin='tagdeck'` (don't overwrite local playlists with Music.app data). Only sync playlists where `origin='itunes'`.

#### Frontend (React)

1. **Sidebar context menu** (right-click on playlist or empty area):
   - "New Playlist" → opens inline rename field or small modal
   - "New Folder" → same pattern
   - "Rename" (on existing playlist/folder)
   - "Delete" (with confirmation)
   - "Duplicate" (playlists only, not folders)
   - "Move to…" → submenu listing available folders + "Root"
   - Separator
   - "Sync to Apple Music" toggle (if applicable)
   - "Playlist Info…" → shows description editor, color picker

2. **"+" button** at the bottom of the sidebar Playlists section header — quick-create a new empty playlist.

3. **Inline rename** — Double-click a playlist name to edit it in place (like Finder).

4. **Drag-and-drop reorganization** — Drag a playlist onto a folder to nest it. Drag to the root area to un-nest. Visual drop indicators.

5. **Origin badges** — Small  icon or  icon next to the playlist name to indicate source. iTunes-origin playlists show a subtle Apple Music icon; TagDeck-native ones show no badge (or a small TagDeck icon).

6. **Delete confirmation dialog** — "Are you sure you want to delete '{name}'? This will not remove the playlist from Apple Music." or "This playlist only exists in TagDeck and will be permanently deleted."

---

### Phase 2: Push-to-iTunes (Bidirectional Sync)

**Goal:** TagDeck-native playlists (and local edits to iTunes playlists) can be pushed to Apple Music.

#### New AppleScript Functions

```
create_playlist_in_music(name, parent_folder_name?) → persistent_id
  — Creates a new playlist (or folder) in Music.app. Returns the persistent_id.

rename_playlist_in_music(persistent_id, new_name)
  — Renames an existing playlist in Music.app.

delete_playlist_in_music(persistent_id)
  — Deletes a playlist from Music.app (optional, guarded by user preference).

create_folder_in_music(name) → persistent_id
  — Creates a folder playlist in Music.app.

move_playlist_in_music(playlist_pid, folder_pid?)
  — Moves a playlist into a folder (or to root if folder_pid is None).

set_playlist_tracks_in_music(playlist_pid, track_pids: Vec<String>)
  — Replaces the full track list of a Music.app playlist (clear + re-add in order).
```

#### Tauri Commands

| Command | Parameters | Behavior |
|---------|-----------|----------|
| `push_playlist_to_itunes` | `id: i64` | Creates the playlist in Music.app if it doesn't exist, or updates it (rename + set tracks). Sets `itunes_sync_enabled = true`. Stores the returned `persistent_id` from Music.app. |
| `push_all_synced_playlists` | — | Batch operation: for every playlist where `itunes_sync_enabled = true`, push current state to Music.app. |
| `unlink_from_itunes` | `id: i64` | Sets `origin = 'tagdeck'`, clears the iTunes `persistent_id` association. The playlist becomes fully local. |

#### Sync Engine Updates

In `sync_recent_changes` Phase 3:

- **iTunes-origin playlists** (`origin='itunes'`): Continue current behavior — Music.app is the source of truth. Diffs are applied to the local DB.
- **TagDeck-native + sync-enabled** (`origin='tagdeck' AND itunes_sync_enabled=true`): **TagDeck is the source of truth.** After detecting a diff, push TagDeck's version to Music.app (not the other way around). This prevents Music.app from overwriting local edits.
- **TagDeck-native + sync-disabled** (`origin='tagdeck' AND itunes_sync_enabled=false`): Completely ignored by sync engine.

#### Conflict Resolution

- If both sides changed since last sync, TagDeck wins (user's active workspace takes priority).
- A `last_synced_at` timestamp on each playlist tracks when it was last pushed/pulled.
- Conflict detection is **track-list level** (not individual track adds/removes), using sorted PID comparison.

---

### Phase 3: Enhanced Sidebar UX

**Goal:** Make the sidebar a pleasure to use with drag-and-drop, keyboard shortcuts, and visual polish.

#### Drag-and-Drop Behaviors

| Drag Source | Drop Target | Action |
|-------------|------------|--------|
| Track(s) from TrackList | Playlist in sidebar | Add tracks to playlist |
| Track(s) from TrackList | Folder in sidebar | No-op (folders don't hold tracks) |
| Playlist in sidebar | Folder in sidebar | Move playlist into folder |
| Playlist in sidebar | Root area | Move playlist to root |
| Playlist in sidebar | Another playlist | Reorder (swap/insert) |
| Folder in sidebar | Another folder | Nest folder (if supported) or reorder |

#### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘N` | New playlist |
| `⇧⌘N` | New folder |
| `Enter` (with playlist selected) | Rename |
| `Delete` / `Backspace` (with playlist selected) | Delete (with confirmation) |
| `⌘D` | Duplicate selected playlist |
| `↑` / `↓` | Navigate playlists |
| `→` | Expand folder |
| `←` | Collapse folder |

#### Visual Enhancements

- **Playlist count badge** — Show track count next to each playlist name (e.g., "House Bangers (47)")
- **Color dots** — If a playlist has a `color` set, show a small colored circle before the name
- **iTunes badge** — Small  or 🔗 icon for playlists synced from/to iTunes
- **Empty state** — When no playlists exist, show a friendly "Create your first playlist" prompt
- **Drag preview** — Show a ghost of the playlist being dragged
- **Drop zone highlighting** — Folders glow when a valid drag hovers over them

---

### Phase 4: Smart Playlists (Stretch Goal)

**Goal:** Auto-populating playlists based on tag/metadata filter rules.

#### Data Model Addition

```sql
CREATE TABLE IF NOT EXISTS smart_playlist_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    field TEXT NOT NULL,        -- 'tag', 'artist', 'album', 'bpm', 'rating', 'format', 'date_added'
    operator TEXT NOT NULL,     -- 'contains', 'not_contains', 'equals', 'gt', 'lt', 'between'
    value TEXT NOT NULL,        -- the comparison value (or JSON for 'between': "[120, 140]")
    position INTEGER DEFAULT 0  -- rule order
);

ALTER TABLE playlists ADD COLUMN is_smart BOOLEAN DEFAULT 0;
ALTER TABLE playlists ADD COLUMN smart_match_mode TEXT DEFAULT 'all';
  -- 'all' = AND logic (every rule must match)
  -- 'any' = OR logic (at least one rule matches)
ALTER TABLE playlists ADD COLUMN smart_limit INTEGER;
  -- Optional max track count
ALTER TABLE playlists ADD COLUMN smart_sort TEXT;
  -- Optional sort field for limiting (e.g., 'date_added DESC')
```

#### Behavior

- Smart playlists have `is_smart = true` and `origin = 'tagdeck'`.
- Their track list is **computed on demand** by evaluating rules against the track database.
- Results are cached in `playlist_tracks` for performance but regenerated when:
  - The user opens the playlist
  - A track's metadata changes (tags, rating, BPM)
  - The user manually refreshes
- Smart playlists show a distinct icon (⚡ or 🔮) in the sidebar.
- Users can convert a smart playlist to a static playlist (freezes the current results).

#### Example Rules

| Rule | Meaning |
|------|---------|
| `tag contains "Uplifting"` | Any track with the "Uplifting" tag |
| `bpm between [120, 130]` | BPM in range |
| `rating gt 60` | 4+ stars |
| `artist equals "Bicep"` | Exact artist match |
| `date_added gt 1700000000` | Added after a certain date |

---

## Migration Strategy

All schema changes use the existing safe migration pattern in `Database::new`:

```rust
// Phase 1 migrations
let _ = conn.execute("ALTER TABLE playlists ADD COLUMN origin TEXT DEFAULT 'itunes'", []);
let _ = conn.execute("ALTER TABLE playlists ADD COLUMN itunes_sync_enabled BOOLEAN DEFAULT 0", []);
let _ = conn.execute("ALTER TABLE playlists ADD COLUMN description TEXT", []);
let _ = conn.execute("ALTER TABLE playlists ADD COLUMN color TEXT", []);
let _ = conn.execute("ALTER TABLE playlists ADD COLUMN sort_position INTEGER DEFAULT 0", []);
let _ = conn.execute("ALTER TABLE playlists ADD COLUMN created_at INTEGER DEFAULT 0", []);
let _ = conn.execute("ALTER TABLE playlists ADD COLUMN updated_at INTEGER DEFAULT 0", []);
```

All existing playlists get `origin='itunes'` by default, which is correct since they were all imported from Music.app.

---

## Sync Engine Rules (Updated)

### Current Flow (unchanged for iTunes-origin)

```
Music.app ──snapshot──▶ Diff Engine ──upsert──▶ TagDeck DB ──▶ Sidebar UI
```

### New Flow for TagDeck-native with sync enabled

```
TagDeck DB ──push──▶ Music.app
                        │
                     (ignored by inbound sync — TagDeck is source of truth)
```

### Sync Decision Matrix

| Origin | `itunes_sync_enabled` | Inbound Sync (Music→TD) | Outbound Sync (TD→Music) |
|--------|----------------------|------------------------|--------------------------|
| `itunes` | `false` (default) | ✅ Mirror from Music.app | ✅ Live (add/remove/reorder track commands) |
| `itunes` | `true` | ✅ Mirror from Music.app | ✅ Live + push renames |
| `tagdeck` | `false` | ❌ Ignored | ❌ Ignored |
| `tagdeck` | `true` | ❌ Ignored (TD is source) | ✅ Push on demand or on change |

### Guard in Phase 3 Diff

```rust
// In sync_recent_changes, when processing Music.app playlist snapshot:
for mp in &music_playlists {
    // Check if this persistent_id belongs to a TagDeck-native playlist
    if let Some(existing) = db_snapshot.get(&mp.persistent_id) {
        if existing.origin == "tagdeck" {
            continue; // Don't overwrite TagDeck-native playlists with Music.app data
        }
    }
    // ... existing diff logic for iTunes-origin playlists
}
```

---

## File Structure (New / Modified)

### New Files
- None required — all logic fits within existing module structure.

### Modified Files

| File | Changes |
|------|---------|
| [models.rs](../src-tauri/src/models.rs) | Add new fields to `Playlist` struct |
| [db.rs](../src-tauri/src/db.rs) | Add migrations, new CRUD methods, update existing queries to include new columns |
| [commands.rs](../src-tauri/src/commands.rs) | Add ~7 new Tauri commands, update sync guard logic |
| [apple_music.rs](../src-tauri/src/apple_music.rs) | Add `create_playlist_in_music`, `rename_playlist_in_music`, `delete_playlist_in_music` (Phase 2) |
| [lib.rs](../src-tauri/src/lib.rs) | Register new commands in `.invoke_handler()` |
| [types.ts](../src/types.ts) | Update `Playlist` interface |
| [Sidebar.tsx](../src/components/Sidebar.tsx) | Context menu, create/rename/delete UI, drag-reorder, badges |
| [App.tsx](../src/App.tsx) | Wire up new sidebar callbacks, keyboard shortcuts |
| [App.css](../src/App.css) | Context menu styles, badge styles, color dot styles |

---

## Acceptance Criteria

### Phase 1 ✅ Checklist
- [ ] User can right-click sidebar → "New Playlist" → type name → playlist appears
- [ ] User can right-click sidebar → "New Folder" → type name → folder appears
- [ ] User can double-click a playlist name to rename it inline
- [ ] User can right-click → "Delete" with confirmation dialog
- [ ] User can drag a playlist onto a folder to nest it
- [ ] User can drag a playlist out of a folder to root
- [ ] New playlists have `origin='tagdeck'` and are NOT synced to Music.app by default
- [ ] Existing iTunes playlists continue to sync normally
- [ ] Sync engine does not overwrite TagDeck-native playlists

### Phase 2 ✅ Checklist
- [ ] User can right-click → "Sync to Apple Music" on a TagDeck-native playlist
- [ ] First push creates the playlist in Music.app and stores the persistent_id
- [ ] Subsequent pushes update name and track list in Music.app
- [ ] User can unlink a playlist from iTunes (becomes fully local)
- [ ] "Push All" batch operation works from Settings or menu
- [ ] Conflict resolution: TagDeck wins when both sides changed

### Phase 3 ✅ Checklist
- [ ] All keyboard shortcuts functional
- [ ] Track count badges visible
- [ ] Drag-and-drop reorder of playlists within same level
- [ ] Visual drop indicators during drag
- [ ] iTunes vs. TagDeck origin badges visible
- [ ] Empty state shown when no playlists exist

### Phase 4 ✅ Checklist (Stretch)
- [ ] User can create a smart playlist with 1+ rules
- [ ] Smart playlist auto-refreshes when tracks change
- [ ] User can convert smart → static playlist
- [ ] Smart playlist rules editor is intuitive and fast

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| AppleScript playlist creation is unreliable | Test extensively on macOS 13/14/15. Implement retry logic. Degrade gracefully — local playlist still works even if Music.app push fails. |
| Sync loops (TagDeck pushes → Music.app changes → sync detects diff → pushes again) | `last_synced_at` timestamp + origin-based sync guard prevents re-ingestion of own changes. |
| Large playlist operations slow | Batch AppleScript operations (already proven with `batch_update_track_comments`). Use transactions for DB operations. |
| Folder nesting depth | Limit to 2 levels (matches Apple Music behavior). UI prevents deeper nesting. |
| Smart playlist performance on 100k track libraries | Cache results in `playlist_tracks`. Only re-evaluate on demand or when affected metadata changes. Use indexed columns for common filter fields. |

---

## Implementation Order

```
Phase 1 (Foundation)
  ├── 1a. Schema migration + Rust model update
  ├── 1b. DB CRUD methods for create/rename/delete/move
  ├── 1c. Tauri commands
  ├── 1d. TypeScript type update
  ├── 1e. Sidebar context menu (right-click)
  ├── 1f. Inline rename UI
  ├── 1g. Delete confirmation dialog
  ├── 1h. Drag-to-reorganize (playlist ↔ folder)
  └── 1i. Sync engine guard for TagDeck-native playlists

Phase 2 (Push-to-iTunes)
  ├── 2a. AppleScript create/rename/delete playlist functions
  ├── 2b. Push command implementation
  ├── 2c. Sync engine update for bidirectional logic
  ├── 2d. UI toggle for "Sync to Apple Music"
  └── 2e. "Push All" batch operation

Phase 3 (Sidebar UX Polish)
  ├── 3a. Keyboard shortcuts
  ├── 3b. Track count badges
  ├── 3c. Origin badges and color dots
  ├── 3d. Empty state
  └── 3e. Drag preview + drop zone highlighting

Phase 4 (Smart Playlists — Stretch)
  ├── 4a. Schema for rules
  ├── 4b. Rule evaluation engine
  ├── 4c. Rules editor UI
  └── 4d. Auto-refresh logic
```
