# Undo/redo coverage expansion — 8 missing actions

**Date:** 2026-07-12
**Status:** Proposed
**Type:** Feature (data-recovery / UX)

## Goal

Extend the existing undo/redo system so every discrete, regret-prone user edit
is reversible with ⌘Z / ⌘⇧Z. Today only four are: tag/comment edits, track-info
edits, add-to-playlist, remove-from-playlist. This adds **8 more**, following the
established `undo::Action` pattern (capture old state in the command *before*
mutating, push an `Action`, revert on undo / re-apply on redo).

## Principles (unchanged from existing actions)

- Capture the **old** state in the command, before the mutation, and push the
  action only after the mutation succeeds.
- Undo restores old state; redo re-applies new state; both return a descriptive
  message (already surfaced by the ⌘Z toast).
- Music.app is touched on undo/redo **only** when the original command did — same
  `sync_mode().push_enabled()` + per-playlist `sync_enabled` guards. Push-disabled
  edits `mark_tracks_dirty` for later reconciliation, mirroring existing behavior.
- TagDeck-only operations (playlist tree, tag vocabulary) never touch Music.app.
- Restores that re-create deleted rows **preserve the original DB ids** (SQLite
  `AUTOINCREMENT` never reuses them, so there is no collision), keeping all
  foreign references — playlist memberships, tag→group links — valid.

## The 8 new actions

### Destructive (restore full state)

1. **`DeletePlaylist { snapshot }`** — the biggest gap. `db.delete_playlist`
   cascades to child playlists (folders) and wipes all their memberships,
   TagDeck-only. Snapshot captures the full subtree: every playlist **row**
   (all columns, incl. id, persistent_id, parent, name, is_folder, origin,
   sync flag, description, color, sort_position, timestamps, spotify fields) and
   every `playlist_tracks` row (playlist_id, track_id, position). Undo re-inserts
   rows (explicit ids) then memberships; redo re-deletes. No Music.app.
   New DB: `snapshot_playlist_subtree(id)`, `restore_playlist_subtree(&snap)`.

2. **`DeleteTag { tag }`** — captures the `tags` row (id, name, usage_count,
   group_id, description). Undo re-inserts with explicit id (tracks keep the tag
   text either way — deleting a vocab tag doesn't rewrite files). Redo deletes.
   New DB: `get_tag_row(id)`, `insert_tag_row(&row)`.

3. **`DeleteTagGroup { group }`** — captures the `tag_groups` row (id, name,
   position). FKs are off, so member tags keep their `group_id`; re-inserting the
   group with its original id re-associates them automatically. Redo deletes.
   New DB: `get_tag_group_row(id)`, `insert_tag_group_row(&row)`.

### Common edits (revert to old value)

4. **`UpdateRating { track_id, persistent_id, old_rating, new_rating }`** — mirror
   of `UpdateTrackInfo`. Rating is not written to file metadata (only DB +
   Music.app), so undo = set old rating in DB + Music.app (push+linked) or
   `mark_tracks_dirty`. Command captures the current rating first.

5. **`ReorderPlaylistTracks { playlist_id, playlist_persistent_id, old_order,
   new_order }`** — captures the pre-reorder order (`get_playlist_track_ids`).
   Undo re-applies old order to the DB and, for synced playlists, pushes it to
   Music.app via the existing safe `reorder_playlist`. Redo re-applies new order.

6. **`MovePlaylist { playlist_id, old_parent_pid, new_parent_pid }`** — captures
   the current `parent_persistent_id`. Undo moves back; redo re-moves. DB-only
   (the move command doesn't push to Music.app).

7. **`RenamePlaylist { playlist_id, playlist_persistent_id, old_name, new_name }`**
   — captures the current name. Undo renames back (DB + Music.app for synced);
   redo re-renames.

8. **`ReorderSiblingPlaylists { old_order, new_order }`** — sidebar tree order.
   Captures the current order of the same id set (by `sort_position`) before
   applying. Undo/redo call `reorder_sibling_playlists`. DB-only.

## undo.rs structure

Follows the existing `apply_track_info` helper convention: each new arm delegates
to a small free function (`apply_rating`, `apply_track_order`, `apply_rename`,
`restore_deleted_playlist`, etc.) so the `undo`/`redo` match stays readable as it
grows. Music.app-order push is shared between reorder undo and redo.

## Frontend

The global ⌘Z/⌘⇧Z handler already bumps `refreshTrigger`, which refreshes the
**sidebar** (playlists) and **tracklist** — covering actions 1, 5, 6, 7, 8 and
membership. For **tag/group** undo (actions 2–3) the Settings tag-manager view
needs the same refresh: emit/handle a lightweight "tags-changed" refresh after
undo/redo so an open tag manager reflects the restored tag/group. (Verify the
existing tag-manager reload hook and reuse it.)

## Testing

Pure-logic unit tests per action where feasible (DB round-trips):
- `snapshot_playlist_subtree` → `delete` → `restore` reproduces rows + membership
  + order (incl. a folder with children).
- tag / tag_group delete→restore round-trip preserves id, group link, fields.
- reorder-tracks and reorder-siblings old/new order round-trips.
- move/rename old-value round-trips.
Live Music.app write-back (rating, rename, reorder push) → manual test in
`USER_TASKS.md`.

## Out of scope (unchanged)

Low-value creates/toggles (`create_playlist`, `duplicate_playlist`, tag-group
create/edit/reorder, `set_tag_group`, `update_playlist_metadata`,
`copy_playlist_memberships`, `set_playlist_sync`) and non-edit operations
(imports, config, exports, analysis, sync, queue, backup restore).
