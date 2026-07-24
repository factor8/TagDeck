# Drag-and-Drop Disambiguation — Design

**Date:** 2026-07-24
**Status:** Shipped, with two corrections during implementation (see note)

> **Correction (2026-07-24, post-first-pass).** Two details below were wrong and
> were fixed after testing — the live behavior is in
> [`reference/DragAndDrop.md`](../../reference/DragAndDrop.md):
> 1. **Reorder target must be resolved with `closestCenter`, not `pointerWithin`.**
>    `pointerWithin` is unreliable for a shifting sortable list, which broke
>    reordering entirely. `pointerWithin` is now used only to detect the add
>    *region*; the row is resolved with `closestCenter`.
> 2. **`autoScroll` for track drags is `false`, not `{ threshold: { x: 0, y: 0.2 } }`.**
>    `threshold.x: 0` divides by zero in dnd-kit and scrolls right at infinite
>    speed. dnd-kit has no per-axis toggle, so auto-scroll is disabled outright
>    for track drags (column drags keep it).

## Problem

Dragging a track in the app behaves unpredictably:

1. **Reorder loses to add.** Dragging a track up/down inside a playlist often
   commits an *add-to-playlist* instead of a *reorder*. Root cause: a single
   app-wide `DndContext` (`src/App.tsx`) uses `collisionDetection={closestCenter}`.
   `closestCenter` picks whichever registered droppable's **center** is nearest
   — ignoring whether the pointer is actually over that target — so a track drag
   can resolve to a far `playlist-…` droppable (add) even while the pointer stays
   inside the list.
2. **Sideways scroll on right-drag.** Dragging a track toward the right edge
   scrolls the (horizontally scrollable) track table sideways. Root cause:
   dnd-kit's built-in auto-scroll is on by default and scrolls the nearest
   scrollable ancestor on **both** axes; the App `DndContext` never constrained it.

## Goal

Make track drag behavior match intent:

| You drag a track… | Result |
|---|---|
| up/down while the pointer stays over the track list | **Reorder** (default; no hold) |
| onto a sidebar playlist | **Add** — only after a brief hold (dwell) over it |
| into the Build panel | **Add to target** — same brief hold |
| toward the right edge of a wide table | Nothing — **no horizontal auto-scroll** during a track drag |
| into empty space below the last row | Reorder to the end |
| (library view) not over any target | No-op |

The pointer's real position decides everything; centers of far-away targets no
longer win. Column-reorder drags are unaffected.

## Existing state (as-is)

- One app-wide `DndContext` in `src/App.tsx` (~L1042) wraps TrackList, Sidebar,
  and PlaylistBuilderPane. `collisionDetection={closestCenter}`, `onDragStart`
  (~L611) sets `activeDragItem`, `onDragEnd` (~L615) routes by id prefix:
  `track-`+`playlist-` → `add_to_playlist`; `track-`+`track-` →
  `trackListRef.handleReorderDragEnd`; else → column reorder.
- Reorder targets: `useSortable` rows with id `track-<id>` (only when the list is
  reorderable — playlist view, position sort). Library view rows are
  `useDraggable` only (not droppables).
- Add targets: sidebar `PlaylistRow` `useDroppable({ id: 'playlist-<id>' })`
  (`Sidebar.tsx:78`), and the Build pane `useDroppable({ id: 'playlist-<targetId>'
  | 'builder-no-target' })` (`PlaylistBuilderPane.tsx:161`). Both drive an
  `isOver` highlight.
- No custom auto-scroll code exists; the behavior is dnd-kit's default.

## Decisions

| Decision | Choice |
|----------|--------|
| Disambiguation | **Pointer location** — `pointerWithin` decides; reorder wins while over the list, add only when the pointer is genuinely over a sidebar playlist / Build pane |
| Add confirmation | **Hover-hold (dwell)** — an add-target must be hovered ~250ms before it "arms"; a drop before arming is a **no-op** |
| Dwell threshold | **250ms** (`ADD_DWELL_MS`) |
| Horizontal scroll | **Disabled for track drags** (`threshold.x = 0`, `threshold.y = 0.2`); column-reorder drags keep the default |
| Empty-space drop | Reorderable list → reorder to nearest row (fallback `closestCenter` over track rows only) |
| Visual feedback | Target shows a faint "hold to add…" state on hover, then a solid "release to add" state once armed; surfaced via a small `DragArmContext` (no deep prop-drilling) |
| Tests | Vitest (new, dev-only) unit-testing the pure helpers |

## Architecture

Three changes, all anchored at the App-level `DndContext`, plus a tiny context
and a pure-helpers module.

### 1. Custom collision detection (`src/utils/dragCollision.ts`, pure)

- `isTrackId(id)` → `id.startsWith('track-')`
- `isAddTargetId(id)` → `id.startsWith('playlist-') || id === 'builder-no-target'`
- `pickTrackCollision(pointerHits)` → `{ kind: 'reorder' | 'add', collision }`
  or `{ kind: 'fallback' }`. Precedence: a track-row hit (reorder) beats an
  add-target hit (add); neither → fallback.
- `shouldCommitAdd(armedDroppableId, overId)` → `isAddTargetId(overId) &&
  armedDroppableId === overId`.
- `nextDwellAction(currentTarget, overId, activeIsTrack)` →
  `{ action: 'start' | 'keep' | 'clear', target }`. Drives the dwell timer.

App composes these into a `CollisionDetection`:
```
if (!isTrackId(activeId)) return closestCenter(args)   // columns, etc.
const hits = pointerWithin(args)
const picked = pickTrackCollision(hits)
if (picked.kind !== 'fallback') return [picked.collision]
const rows = args.droppableContainers.filter(c => isTrackId(id) && id !== activeId)
return rows.length ? closestCenter({ ...args, droppableContainers: rows }) : []
```

### 2. Dwell arming (App state)

- State `armedDroppableId: string | null`; refs `dwellTargetRef`, `dwellTimerRef`.
- New `onDragOver` handler feeds `(dwellTargetRef.current, overId, activeIsTrack)`
  to `nextDwellAction`: `start` → clear+restart a `setTimeout(ADD_DWELL_MS)` that
  sets `armedDroppableId`; `keep` → let the timer run; `clear` → cancel timer and
  clear armed.
- `onDragEnd` add branch gated by `shouldCommitAdd(...)` (else no-op). Reorder and
  column branches unchanged. `onDragStart`/`onDragEnd`/`onDragCancel` reset dwell.

### 3. Auto-scroll config (App `DndContext`)

`autoScroll` derived from the active drag kind:
`activeDragItem?.type === 'Track'` → `{ threshold: { x: 0, y: 0.2 } }`, else `true`.

### 4. Armed-state visual (`src/components/DragArmContext.tsx`)

`createContext<string | null>(null)` + `useArmedDroppableId()`. App wraps the tree
in `<DragArmContext.Provider value={armedDroppableId}>`. `PlaylistRow` and the Build
pane read it; when `isOver && !armed` → faint/pending style, when `armed` → solid
"release to add" style.

## Edge cases

- **Library (non-reorderable) track:** no `track-` droppables, so empty-space
  fallback yields `[]` → drag only adds when over a target (unchanged intent,
  now also gated by dwell).
- **Drop before dwell elapses:** `shouldCommitAdd` false → no-op. Mitigated by the
  short threshold + clear armed visual. Pointer-within already prevents the
  common accidental-add-during-reorder case, so this rarely bites.
- **Column-reorder drag over the header:** `activeId` isn't a track → `closestCenter`
  path unchanged; horizontal auto-scroll preserved.
- **Track dragged over a column header:** `pickTrackCollision` ignores non-track,
  non-add ids → won't resolve to a column.

## Testing

Vitest unit tests (`src/utils/dragCollision.test.ts`) for the pure helpers:
`isTrackId`, `isAddTargetId`, `pickTrackCollision` (reorder-beats-add, add-only,
fallback), `shouldCommitAdd` (armed/unarmed/mismatched), `nextDwellAction`
(start/keep/clear). Plus `tsc` typecheck and a manual smoke-test entry in
`USER_TASKS.md`.

## Out of scope

Queue reorder, builder-internal reorder, tag editor, and OS drag-out/file-import
paths are unchanged.
