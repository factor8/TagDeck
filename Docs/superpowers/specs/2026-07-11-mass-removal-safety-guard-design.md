# Mass-Removal Safety Guard — Design

**Date:** 2026-07-11
**Status:** Approved, ready for implementation plan
**Origin:** File/data-loss risk assessment (CRITICAL finding #1)

## Problem

`sync_recent_changes` detects tracks removed from Music.app as a pure set
difference: any linked persistent-ID in the DB that is absent from the live
set returned by `get_all_music_app_pids()` is treated as deleted
([commands.rs:887-890](../../../src-tauri/src/commands.rs)).

`get_all_music_app_pids()` ([apple_music.rs:680](../../../src-tauri/src/apple_music.rs))
returns `Ok(empty set)` — **not an error** — whenever Music.app's `every track`
yields nothing: an empty library, a library still loading (including right after
the `tell application "Music"` auto-launches it), a switched/unavailable library
file, or iCloud Music Library mid-sync.

When that set is empty, `deleted_pids` becomes **every linked track in the DB**.
With `DeletionBehavior::Remove`, the next automatic sync calls
`delete_tracks_by_itunes_pids` on the whole library
([commands.rs:997](../../../src-tauri/src/commands.rs)) — irreversibly destroying
all TagDeck-side tags, ratings, BPM, and playlist memberships, with no
confirmation, no threshold, and no backup. Under `Keep` it mass-unlinks every
track. The **same empty-snapshot vector** hits playlists: Phase 3
([commands.rs:1148-1158](../../../src-tauri/src/commands.rs)) removes from the DB
every sync-enabled playlist absent from `get_playlist_snapshot()`.

No on-disk audio file is deleted (DB rows only), but the destroyed data
(tags/ratings/playlist membership) lives **only** in TagDeck and is not
recoverable.

## Goal

Make it nearly impossible for a transient empty/partial Music.app snapshot to
trigger a mass removal of TagDeck data. A genuine bulk deletion must still be
actionable — surfaced, not silently swallowed.

## Approach

Guard the removal phases behind a suspiciousness check. When a removal batch
looks like the empty/partial-library failure mode, **do not** honor the
configured Remove/Keep/Ask behavior for that pass — route the removals to Sync
Review (tracks) or skip-and-warn (playlists) instead.

### 1. Pure helper

```rust
/// True when a detected removal batch looks like the empty/partial-library
/// failure mode rather than a genuine user deletion.
/// - `removed`: number of linked items absent from the live snapshot
/// - `live`:    number of items the snapshot actually returned
/// - `linked`:  number of linked items in the DB
fn removal_is_suspicious(removed: usize, live: usize, linked: usize) -> bool {
    if linked == 0 {
        return false; // nothing linked -> nothing to protect
    }
    // Empty/loading library while we have linked items: always suspicious.
    if live == 0 {
        return true;
    }
    // Otherwise trip only on a large absolute AND proportional batch.
    let threshold = MASS_REMOVAL_FLOOR.max((MASS_REMOVAL_PCT * linked as f64) as usize);
    removed > threshold
}
```

Constants (tunable; flagged as a user decision in USER_TASKS):
- `MASS_REMOVAL_FLOOR: usize = 25` — never trip on small absolute batches, so
  normal small deletions in any library size auto-act.
- `MASS_REMOVAL_PCT: f64 = 0.20` — trip when a pass would remove more than 20%
  of linked items.

Rationale for `max(FLOOR, PCT*linked)`: a large library deleting a handful of
tracks auto-acts (not annoying); an empty snapshot or a >20%-of-library batch
routes to review (safe). A tiny library must lose >25 items to trip on the
proportional rule, which is acceptable since the empty-case is covered
separately.

### 2. Track removals — [commands.rs:940-1011](../../../src-tauri/src/commands.rs)

Immediately before the `match deletion_behavior` block, evaluate
`removal_is_suspicious(deleted_pids.len(), music_pids.len(), db_pids.len())`.

- **Suspicious:** load the removed tracks (`get_tracks_by_itunes_pids`), push
  them into the existing `pending_removals` Sync Review channel, log a WARN, and
  **skip** the Keep/Remove/Ask branches for this pass — regardless of the
  configured `itunes_deletion_behavior`. Nothing is unlinked or deleted.
- **Not suspicious:** unchanged — the existing `match deletion_behavior` runs.

`music_pids` and `db_pids` are already in scope at this point
([commands.rs:875-877](../../../src-tauri/src/commands.rs)).

### 3. Playlist removals — [commands.rs:1148-1158](../../../src-tauri/src/commands.rs)

Apply the same guard against the playlist snapshot: if the live playlist
snapshot is empty (or the removed-playlist batch is over-threshold) while the DB
has sync-enabled playlists, **skip** `remove_playlists_by_persistent_ids` and
log a WARN. Playlists do not currently flow through Sync Review, so the guard
here is skip-and-warn — the playlists simply remain until a healthy sync
confirms the removal. (Building playlist removals into Sync Review is a larger,
separate change and is out of scope.)

### 4. Logging

WARN lines that state the counts and the reason so the event is diagnosable in
the logs window, e.g.:

> `Skipped auto-removal of 812 track(s): Music.app reported 0 tracks (library empty or still loading). Surfaced in Sync Review.`

> `Skipped auto-removal of 812 track(s): batch exceeds safety threshold (812 > 200 of 1000 linked). Surfaced in Sync Review.`

### 5. Testing

Unit tests on `removal_is_suspicious`:
- empty snapshot with linked > 0 → true
- over-threshold batch (absolute + proportional) → true
- under-threshold batch → false
- small-library floor (e.g. linked=100, removed=10) → false
- zero linked → false

Command-level wiring is verified by the manual test already recorded in
USER_TASKS.md (quit/empty Music.app mid-sync → confirm removals are skipped and
surfaced, and a genuine small deletion still reconciles).

## Out of scope (per design decisions)

- No `if application "Music" is running` guard on `get_all_music_app_pids`
  (sync may still auto-launch Music; the empty-set guard makes that safe).
- No `Result<Option<HashSet>>` "unavailable vs empty" signal refactor.
- No change to `delete_tracks_by_itunes_pids` / `unlink_tracks_by_itunes_pids` /
  `remove_playlists_by_persistent_ids` themselves.
- No change to the non-suspicious happy path.
- Other risk-assessment findings (Move-mode warning, comment-backup on push,
  atomic tag writes, reorder_playlist, Delete/Backspace confirm) are tracked
  separately and not part of this change.
