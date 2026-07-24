# Undo playlist-track removal (with position restore)

**Date:** 2026-07-12
**Status:** Shipped
**Type:** Bug fix (data-recovery / UX)

## Problem

Removing a track from a playlist — via Delete/Backspace in the tracklist, the
Build tab's remove control, or the right-click menu — records **no undo action**.
The `undo::Action` enum had only `UpdateTrackComments`, `AddToPlaylist`, and
`UpdateTrackInfo`. So `remove_from_playlist` deleted from Music.app + the DB and
pushed nothing onto the undo stack. Pressing ⌘Z popped whatever unrelated action
was on top (or nothing), and the removed track never came back — for both
TagDeck-native and iTunes-synced playlists. The frontend compounded the
confusion by always flashing a success toast even when the backend undid nothing.

## Fix

Add a `RemoveFromPlaylist` action — the mirror of the existing `AddToPlaylist`:

- **`undo::RemovedTrackRef { id, persistent_id, position }`** — captures each
  removed track's id, its Music.app persistent ID (empty = unlinked → Music.app
  write-back skipped), and its **original position** in the playlist.
- **`remove_from_playlist`** (commands.rs) captures each track's position
  (`get_track_position_in_playlist`) before removal and pushes the action after a
  successful DB delete.
- **Undo** re-adds: for the DB, re-insert each track at its captured position
  (`insert_track_in_playlist_at`, processing removed tracks in ascending
  position order — this reproduces the original order exactly); for synced
  playlists with push enabled, re-add to Music.app (appends — Music.app has no
  insert-at-position, so the DB stays the source of truth for order).
- **Redo** re-removes: mirror of the current remove path (Music.app then DB).
- **Frontend** (App.tsx): ⌘Z/⌘⇧Z only show a toast when the backend returned a
  message (it already returns `Option<String>`), and show the descriptive message
  ("Undo Remove from Playlist", …) rather than a generic always-on "Undone".

### Position restore — DB algorithm

`insert_track_in_playlist_at` shifts existing rows at `position >= p` down by one,
then inserts at `p`. Inserting removed tracks in ascending captured-position order
restores the exact original ordering (verified by
`remove_then_reinsert_at_positions_restores_order`).

## Scope / tradeoffs

- **Native playlists**: position fully restored.
- **Synced playlists**: DB position restored; the Music.app mirror re-appends
  (no practical insert-at-position API). TagDeck's own reorder push reconciles
  Music.app order later. Membership — the actual concern — is always restored.

## Tests

- `db::tests::remove_then_reinsert_at_positions_restores_order` — remove two
  middle tracks, re-insert at captured positions, assert original order.
- Live Music.app write-back is covered by a manual test in `USER_TASKS.md`.
