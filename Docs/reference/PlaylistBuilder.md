# Playlist Builder

The **Build** tab (right panel, next to Tags and Queue) is a dedicated flow for filling a
playlist while searching the whole library. It promotes one playlist to a "target" and lets
you push songs into it from the middle track list without leaving the view.

## Choosing a target

Three ways, all landing on the same `builderPlaylistId` state in `src/App.tsx`:

- **Right-click a playlist in the sidebar → "Build this Playlist"** (`onBuildPlaylist` prop on
  `Sidebar`; shown only for non-folder, non-Spotify playlists). This also switches the right
  panel to the Build tab and expands it.
- **Pick/search inside the Build tab** — when no target is set, `PlaylistBuilderPane` shows a
  playlist picker (search field over `get_playlists`, excluding folders and `origin === 'spotify'`).
- **Create a new playlist** — the picker's name field calls `create_playlist` and targets the
  result immediately.

"Change" in the pane header clears the target back to the picker. The target is independent of
the viewed playlist (`selectedPlaylistId`) and is remembered across restarts
(`localStorage: app_builder_playlist_id`).

## Adding / removing songs

All edits **commit immediately** (same path as dragging a track onto the sidebar) and go through
the undo stack, so **⌘Z** reverses them. Three add gestures, all from the middle `TrackList`:

- **+ button** in a dedicated leftmost column that appears only while a target is set
  (`BuilderAddButton`; the column is pinned via `effectiveColumnOrder` and kept out of the column
  settings menu and saved order). Because it's gated on a target being *set* — not on the Build tab
  being active — you can add to the target while viewing a track's Tags. Adding a row that's part of
  a multi-selection adds the whole selection. Rows already in the target show a **check** instead;
  clicking it removes the track.
- **Drag onto the panel** — the pane is a dnd-kit droppable with id `playlist-${builderPlaylistId}`,
  so App's existing `handleDragEnd` track→playlist routing handles it with no extra wiring. The add
  now requires a brief **hold** over the pane (the dashed "hold to add…" outline turns solid when
  it's ready) — same hover-hold that gates adds onto sidebar playlists. See
  [DragAndDrop.md](DragAndDrop.md).
- **Right-click → "Add to '<target>'"** in the track context menu (multi-selection aware). Hidden
  when the target is also the currently-viewed playlist.

## The panel

`src/components/PlaylistBuilderPane.tsx` shows the target's name, **track count + total time**, and
the ordered tracks. Within it you can **drag to reorder** (`reorder_playlist_tracks`), **remove**
(hover-X, `remove_from_playlist`), and **double-click to play**. It resolves the target's ordered
ids (`get_playlist_track_ids`, held in App as `builderTrackIds`) against the library (`get_tracks`).

## Commands used

No new backend commands — reuses `add_to_playlist`, `remove_from_playlist`,
`reorder_playlist_tracks`, `get_playlist_track_ids`, `get_playlists`, `create_playlist`,
`get_tracks`. Spotify playlists are rejected by `add_to_playlist` and excluded from the picker;
iTunes-sync-enabled targets push to Music.app automatically like any other edit.
