// Pure helpers for the app-level drag-and-drop disambiguation.
//
// The single App `DndContext` registers three kinds of droppable:
//   - `track-<id>`      sortable playlist rows  -> reorder targets
//   - `playlist-<id>`   sidebar playlists        -> add targets
//   - `builder-no-target` / `playlist-<id>`      the Build pane -> add target
// plus column-header droppables for table column reordering.
//
// These functions decide, for a *track* drag, whether a given pointer position
// means "reorder" or "add", and gate adds behind a hover-hold (dwell) so an add
// only commits when the target has been intentionally held. Kept pure so the
// logic is unit-testable without a real DOM drag. See dragCollision.test.ts.

/** A minimal shape of a dnd-kit collision (only `id` is needed here). */
export interface CollisionLike {
  id: string | number;
}

export const isTrackId = (id: string): boolean => id.startsWith('track-');

export const isAddTargetId = (id: string): boolean =>
  id.startsWith('playlist-') || id === 'builder-no-target';

export type TrackCollisionPick<T extends CollisionLike> =
  | { mode: 'reorder' }
  | { mode: 'add'; collision: T };

/**
 * Given the droppables the pointer is actually inside (from dnd-kit's
 * `pointerWithin`), decide whether a track drag is an add or a reorder:
 *   - pointer over an add target (sidebar playlist / Build pane) and NOT over a
 *     list row -> `add` (with the add collision)
 *   - anything else (over a row, empty list space, a column header, nothing)
 *     -> `reorder` — the caller then resolves the exact row with `closestCenter`,
 *     which (unlike `pointerWithin`) is reliable for a shifting sortable list.
 */
export function pickTrackCollision<T extends CollisionLike>(
  pointerHits: T[],
): TrackCollisionPick<T> {
  const overTrackRow = pointerHits.some((c) => isTrackId(String(c.id)));
  const addHit = pointerHits.find((c) => isAddTargetId(String(c.id)));
  if (addHit && !overTrackRow) return { mode: 'add', collision: addHit };
  return { mode: 'reorder' };
}

/**
 * Whether a drop should commit an add: the drop must land on an add target that
 * is the one currently armed (dwell satisfied). A drop before the dwell elapses,
 * or onto a different/non-add target, is a no-op.
 */
export function shouldCommitAdd(
  armedDroppableId: string | null,
  overId: string,
): boolean {
  return isAddTargetId(overId) && armedDroppableId === overId;
}

export type DwellAction = 'start' | 'keep' | 'clear';

/**
 * Pure state transition for the dwell timer, evaluated on every drag-over:
 *   - `start` a fresh timer when a track first enters a (new) add target
 *   - `keep` the running timer while still over the same target
 *   - `clear` when the pointer is over a track row / nothing, or the drag isn't a track
 */
export function nextDwellAction(
  currentTarget: string | null,
  overId: string | null,
  activeIsTrack: boolean,
): { action: DwellAction; target: string | null } {
  if (activeIsTrack && overId != null && isAddTargetId(overId)) {
    if (currentTarget === overId) return { action: 'keep', target: overId };
    return { action: 'start', target: overId };
  }
  return { action: 'clear', target: null };
}
