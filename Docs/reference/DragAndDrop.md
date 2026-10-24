# Drag and Drop

How dragging tracks behaves and where the logic lives. This is a live reference —
keep it in sync with the code.

## What a track drag can do

| Gesture | Result |
|---|---|
| Drag a track up/down while the pointer stays over the track list | **Reorder** within the current playlist |
| Drag a track onto a **sidebar playlist**, hold briefly | **Add** the track (or the whole selection) to that playlist |
| Drag a track into the **Build** panel, hold briefly | **Add** to the Build target |
| Drag into empty space below the last row | Reorder to the end |
| Drag in a non-reorderable view (library, or non-position sort) not over a target | No-op |
| **⌥ (Option) + drag** a track row | Drag the actual audio file(s) out to Finder / Mail / Rekordbox (see `src/utils/dragOut.ts`) |
| Drag OS files onto a row or sidebar playlist | Import those files (native HTML5 file-drop, separate path — see [File import feedback](#file-import-feedback)) |

### Reordering requires manual order

Reordering is only available when the view is in **manual order** — a playlist
with an empty sort or an ascending-`position` sort (`TrackList.tsx` `isReorderable`).
Sorting a playlist by any content column (or `position` **descending**) disables
reordering, exactly like Music.app: a drag in a sorted view has no meaningful
manual position to drop into.

- The **#** (position) column sorts **ascending-first** (`sortDescFirst: false` —
  TanStack defaults numeric columns to desc-first). Ascending `position` *is*
  manual order, so clicking **#** is the "back to manual order" action and keeps
  the list reorderable, rather than a desc sort that would disable it.
- If you try to drag-reorder while sorted, the drag resolves to no row (`over` is
  `null`) and App shows a **subtle info toast** — `TrackListHandle.reorderBlockedNotice()`
  returns the message when the current view is a sorted playlist, and
  `handleDragEnd` surfaces it. This replaces the old silent no-op.

## Reorder vs. add: pointer decides

All in-app track/playlist/Build drags share **one** `DndContext` in
[`src/App.tsx`](../../src/App.tsx). It uses a custom `collisionDetectionStrategy`
(not bare `closestCenter`):

- For a **track** drag, `pointerWithin` decides the *region*: if the pointer is
  genuinely over a sidebar playlist / Build pane (`playlist-…` / `builder-…`) and
  **not** over a list row, it's an **add**. Otherwise it's a **reorder**, and the
  exact row is resolved with `closestCenter` over the sortable rows.
- For any other drag (column reordering) it keeps `closestCenter` unchanged.

Two important details:

- Dragging straight up/down no longer resolves to a far-away playlist: bare
  `closestCenter` picked the nearest droppable *center* regardless of the pointer,
  so a sidebar/Build target could win; now an add requires the pointer to be over
  that target.
- The reorder target is resolved with `closestCenter` (over the rows), **not**
  `pointerWithin`. `pointerWithin` tests the pointer against each row's measured
  rect, which is unreliable while `verticalListSortingStrategy` shifts rows under
  the pointer; `closestCenter` uses the dragging rect's center and is the dnd-kit
  recommendation for sortable lists.

The pure decision helpers live in [`src/utils/dragCollision.ts`](../../src/utils/dragCollision.ts)
(`isTrackId`, `isAddTargetId`, `pickTrackCollision`, `shouldCommitAdd`,
`nextDwellAction`) and are unit-tested in `dragCollision.test.ts` (`npm test`).

## Hover-hold ("arming") for adds

An add does not commit the instant the pointer is over a target. The target must
be **held for `ADD_DWELL_MS` (250 ms)** first. App's `onDragOver` runs a dwell
timer (`nextDwellAction` → start / keep / clear); when it elapses the target
becomes *armed* (`armedDroppableId`, mirrored in `armedRef` so the drop check
never races React re-render). On drop, `shouldCommitAdd` only allows the add if
the released target is the armed one — releasing early is a no-op.

**Visual states** (driven by `DragArmContext`, consumed by the sidebar row and the
Build pane):

- **Hovering, not yet armed** — faint fill + dashed accent outline ("hold to add…").
- **Armed** — solid fill + solid accent outline ("release to add").

Droppable ids: sidebar playlists and the Build target both use `playlist-<id>`
(the Build pane uses `builder-no-target` when no target is set). Because they share
the scheme, App's single Track→Playlist add branch handles both.

## No sideways scroll during a track drag

The track table is horizontally scrollable, and dnd-kit's auto-scroll defaults to
scrolling the nearest scrollable ancestor on **both** axes — so dragging a track
toward the right edge scrolled the table sideways. dnd-kit has **no per-axis
auto-scroll toggle** (`threshold.x: 0` doesn't disable the x-axis; it divides by
zero in `getScrollDirectionAndSpeed` and scrolls right at infinite speed). So the
App `DndContext` passes `autoScroll={false}` **while a track is being dragged**,
disabling auto-scroll entirely for track drags. Column-reorder drags keep the
default (`autoScroll={true}`) so a wide table can still scroll sideways while
moving a column.

Trade-off: there is no vertical auto-scroll while dragging a track (the list is
virtualized, so cross-screen reorder is already limited). If that becomes a
problem, add a custom vertical-only scroller rather than re-enabling dnd-kit's.

## Key files

| File | Role |
|---|---|
| `src/App.tsx` | The one `DndContext`; collision strategy, dwell arming, auto-scroll, `handleDragEnd` routing (add / reorder / column) |
| `src/utils/dragCollision.ts` (+ `.test.ts`) | Pure disambiguation + dwell helpers |
| `src/components/DragArmContext.tsx` | Shares the armed droppable id with add targets |
| `src/components/TrackList.tsx` | Sortable rows (`track-<id>`), `handleReorderDragEnd`, `isReorderable` |
| `src/components/Sidebar.tsx` | `PlaylistRow` add-target droppable + armed visual |
| `src/components/PlaylistBuilderPane.tsx` | Build-pane add-target droppable + armed visual; its own nested `DndContext` for internal row reorder |
| `src/utils/dragOut.ts` | ⌥-drag OS drag-out (`@crabnebula/tauri-plugin-drag`) |

Independent, out-of-scope drag systems with their own `DndContext`: play-queue
reorder (`QueuePane.tsx`), tag/group editor (`TagDeck.tsx`), and the Build pane's
internal reorder.

## File import feedback

Dropping files from the OS calls the `import_files` command, which processes
files one at a time (hash → DB dedupe → add to Music.app or the standalone
file pipeline → add to the target playlist). While it runs the backend emits an
`import-progress` event (`ImportProgress` in `src-tauri/src/commands.rs`, serde
tag `phase`):

| Phase | Payload | UI effect |
|---|---|---|
| `start` | `batch_id`, `playlist_id`, `total`, `items[{index, path, name}]` | Progress card appears; placeholder rows appear in the target playlist (gray, "Waiting…") |
| `item_start` | `index` | That row shows a spinner + "Importing…"; card shows the file name |
| `item` | `index`, `status` (`imported` / `skipped` / `failed`), `track_id`, `error` | Row flips to "Added" (or disappears if failed); a debounced refresh loads the real row, which replaces the placeholder |
| `done` | `imported`, `skipped`, `failed` | Card shows the tally and lingers ~1.5 s, then the usual summary toast |

Frontend pieces: `src/hooks/useImportProgress.ts` (event → batch state,
debounced refresh, `pendingImportsFor` / `importingByPlaylist` selectors),
`src/components/ImportProgressCard.tsx` (floating card, top-right),
`Sidebar.tsx` `PlaylistRow` (spinner + `done/total` beside the playlist name),
and `TrackList.tsx` `renderPendingRows` (placeholder rows after the real rows;
a placeholder is kept until its `track_id` is present in the loaded tracks so
nothing blinks out before its replacement appears). Placeholders are shown in
the target playlist view and in the Library view; `skipped` files that weren't
added to a playlist have nothing to wait for and are dropped immediately.

With Two-way sync on, each file is one AppleScript round-trip
(`add_file_to_music_library_full` in `apple_music.rs`: add + duplicate into the
synced playlist + read fields back). Duplicate detection is TagDeck's DB
path/original-path/content-hash check; there is no per-file Music.app library
scan.
