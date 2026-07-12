# Safe Playlist Reorder (Music.app) — Design

**Date:** 2026-07-12
**Status:** Approved (implementing)
**Risk-assessment finding:** #4 — `reorder_playlist` deletes-then-re-adds; a mid-reorder failure can drop a playlist's Music.app membership (MEDIUM)

## Problem

When a synced playlist is drag-reordered, `reorder_playlist` (`apple_music.rs`) pushes the
new order to Music.app by: resolve each track by persistent ID → **`delete every track of
thePlaylist`** → re-add via `duplicate` in the new order.

TagDeck's own DB is updated first and is unaffected. But the Music.app copy is at risk:

1. **Non-atomic window.** Between the delete and the re-add loop finishing, the playlist is
   empty. A Music.app crash or an `osascript` kill mid-operation leaves it empty or partial.
2. **Silent shrink.** Every per-track lookup *and* the whole script sit inside error-swallowing
   `try` blocks ("log but don't fail"). Any PID that fails to resolve is silently dropped
   **after** the delete-all, quietly shrinking the playlist — and Rust always sees `Ok`.
3. **Wrong-target.** Nothing verifies the resolved playlist is a *user playlist*; a stray PID
   resolving to the main Library would run `delete every track` against the library.

No audio files are ever at risk — this is playlist membership in Music.app only.

Reorder only changes *order*, not membership (add/remove go through separate functions), so
the desired track set normally equals the current set — which makes snapshot-and-restore
nearly free.

## Design

Rewrite the AppleScript to be safe-by-construction and report real success/failure. Build it
via placeholder replacement (not `format!`) so the many literal `{}` AppleScript list braces
don't need escaping.

Sequence inside Music.app:

1. **Target guard.** Resolve the playlist by persistent ID; if `class of thePlaylist is not
   user playlist`, `error` out. Never delete from the library or a folder.
2. **Snapshot.** `set originalPIDs to (get persistent ID of every track of thePlaylist)` —
   the current membership, to restore if the rebuild fails.
3. **Resolve-before-delete.** Resolve every desired track by ID into `trackRefs` with **no**
   swallowing `try`. If any PID fails to resolve, or `count of trackRefs ≠ count of desired
   PIDs`, `error` out **before** deleting anything. This eliminates the silent-shrink path.
4. **Rebuild, guarded.** `delete every track`, then re-add `trackRefs` in order. Wrap the
   delete-through-verify in a `try`: on **any** error (a failed `duplicate`, or a final
   `count of tracks ≠ expected`), **restore** the original membership from `originalPIDs`
   (best-effort) and then `error` with a message. So a failure after the destructive delete
   still leaves the playlist as its original set, not truncated.
5. **Report.** Return `"OK"` on success. On failure the unhandled `error` makes `osascript`
   exit non-zero; Rust checks the exit status and surfaces stderr as a real `Err` (logged as
   WARN by the caller) instead of the old always-`Ok`.

Rust side:
- Early-return `Ok(())` if the desired PID list is empty (nothing linked to push) — never run
  the destructive script with an empty target set.
- Check `output.status.success()`; on failure return `Err` carrying stderr.

## What this does and doesn't guarantee

- **Eliminates** silent shrink (abort-before-delete + count check) and wrong-target deletion.
- **Bounds** rebuild failures (failed duplicate, count mismatch) by restoring the original set.
- **Surfaces** failures to the caller/log instead of swallowing them.
- Does **not** achieve true atomicity — Music.app's AppleScript has no transactional playlist
  edit and no reliable in-place index move, so delete-then-re-add remains the mechanism. A
  crash *during the restore itself* is the residual tail; it's far smaller than today's window.

## Non-goals

- Not changing add/remove-from-playlist or DB reorder (already correct; DB is source of truth).
- Not switching to a `move`-based reorder (Music.app can't do reliable index moves).

## Testing

- **Unit (Rust):** the reorder is a side-effecting AppleScript; the pure Rust logic is the
  empty-set early return. Add a small test asserting the desired-PID collection and the
  empty-guard behavior at the boundary the function can be exercised without Music.app. The
  AppleScript safety properties are verified manually (below).
- **Manual (USER_TASKS):** in Two-way mode, drag-reorder a synced playlist and confirm the
  new order appears in Music.app with the **same track count**; reorder a playlist containing
  a track that was removed from Music.app and confirm the reorder is refused (logged) rather
  than silently dropping tracks.

## Files

- `src-tauri/src/apple_music.rs` — rewrite `reorder_playlist` (guard + snapshot + resolve-before-delete + restore + real error).
- `src-tauri/src/commands.rs` — empty-set early return; log the real error (already logs WARN).
- Docs: `CHANGELOG.md`, `reference/LibraryStrategy.md` (or RealTimeSync note), `USER_TASKS.md`, README index.
