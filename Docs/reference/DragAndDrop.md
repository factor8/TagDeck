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
| Drag OS files onto a row or sidebar playlist | Import those files (native HTML5 file-drop, separate path) |

Reordering is only available when the current view is reorderable —
a playlist with an empty or ascending-`position` sort (`TrackList.tsx` `isReorderable`).

## Reorder vs. add: pointer decides

All in-app track/playlist/Build drags share **one** `DndContext` in
[`src/App.tsx`](../../src/App.tsx). It uses a custom `collisionDetectionStrategy`
(not bare `closestCenter`):

- For a **track** drag it runs dnd-kit's `pointerWithin` — only targets the pointer
  is actually inside count. A track row under the pointer wins (**reorder**); a
  `playlist-…` / `builder-…` droppable under the pointer is an **add**; over empty
  list space it falls back to the nearest track row; over nothing it is a no-op.
- For any other drag (column reordering) it keeps `closestCenter` unchanged.

This is why dragging straight up/down no longer resolves to a far-away playlist:
`closestCenter` picked the nearest droppable *center* regardless of the pointer;
`pointerWithin` requires the pointer to be over the target.

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
scrolling the nearest scrollable ancestor on **both** axes. The App `DndContext`
passes `autoScroll={{ threshold: { x: 0, y: 0.2 } }}` **while a track is being
dragged**, which disables horizontal auto-scroll (vertical still works for long
lists). Column-reorder drags keep the default (`autoScroll={true}`) so a wide
table can still scroll sideways while moving a column.

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
