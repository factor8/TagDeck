# Move-Import Safety — Design

**Date:** 2026-07-12
**Status:** Approved (implementing)
**Risk-assessment finding:** #3 — "Move" import mode silently deletes originals (HIGH)

## Problem

`import_file` in `file_manager.rs` supports three import modes: `Copy` (default),
`Move`, and `InPlace`. In `Move` mode the flow is:

1. `fs::copy(source → destination)`
2. compare `source` byte-length vs `destination` byte-length
3. if equal, `fs::remove_file(source)` — a **permanent** delete

Three ways this loses a user's original file:

1. **Size-only verification.** Two different files can have identical byte lengths. A
   truncated or corrupted copy that happens to match the source size passes the check,
   and the *only* good copy (the original) is then deleted.
2. **Hard delete.** `fs::remove_file` is unrecoverable — no Trash, no undo.
3. **No UI warning.** The settings radio reads "Move to library", which does not tell
   the user their originals will be deleted. A user can pick it without understanding
   the consequence.

The project goal is that it be *nearly impossible to accidentally lose a user's files*.
Move mode is the single place TagDeck deletes a file the user gave it.

## Design

Three independent hardenings; each is safe on its own.

### 1. Content-hash verification (replaces size-only)

Before removing the original, prove the copy is byte-identical:

- Hash the **source** with the existing `hash_file` (SHA-256, streamed in 1 MB chunks)
  *before* the copy.
- Hash the **destination** *after* the copy.
- Remove the original **only if the two digests match**. On mismatch, leave the original
  in place and `bail!` with a clear message (the destination copy remains too — a
  same-name re-import would overwrite it, and it's the untrusted one, so we do not touch
  either file automatically).

Cost: one extra full read of source + destination, on `Move` imports only. `Copy` and
`InPlace` are unaffected. Correctness beats the I/O here — this path deletes files.

### 2. Move-to-Trash (replaces hard delete)

Swap `fs::remove_file(source)` for the `trash` crate's `trash::delete(source)`, so the
original lands in the macOS Trash and is recoverable. If trashing fails, `bail!` and do
**not** fall back to a hard delete — a failure to trash must never escalate to permanent
loss. The destination copy already exists at this point, so the import still succeeds in
terms of the library having the file; only the original's disposal deferred to the user.

Add dependency: `trash = "5"` (maintained, macOS/Windows/Linux support; on macOS uses the
Finder/`NSFileManager` trash API).

### 3. UI: relabel + one-time confirmation

In `LibraryTab.tsx`:

- Relabel the radio: **"Move to library (deletes originals)"** with a secondary line:
  *"Originals are moved to the Trash after a verified copy."*
- When the user switches the selection **to** `Move` (and it wasn't already `Move`), show
  a confirmation dialog before committing the setting:
  > **Move originals into the library?**
  > New imports will be copied into your library and the original files moved to the
  > Trash (after a verified, byte-for-byte copy). Existing files aren't touched.
  > **[Cancel] [Use Move mode]**
- Cancel → selection stays on the previous mode. Confirm → `updateLibraryConfig({ import_mode: 'Move' })`.
- No confirmation when switching *away from* Move, or between Copy/InPlace.

## Non-goals

- Not changing `Copy` (already safe) or `InPlace` (never touches originals).
- Not retroactively trashing anything already hard-deleted.
- Not adding a global "undo import" — Trash recovery covers the loss case.

## Testing

- **Unit (Rust):** `import_file` in `Move` mode with a healthy source →
  destination exists, digests equal, source is gone from its path (trashed).
  A size-match-but-content-differs case cannot be produced through `fs::copy` (copy is
  faithful), so the hash-equality path is covered by asserting the happy path trashes and
  the guard is a `bail!` on inequality — the inequality branch is unit-tested by factoring
  the "should remove?" decision into a pure `contents_match(a_digest, b_digest)` check.
- **Manual (USER_TASKS):** set Move mode, import a file, confirm it appears in the library
  and the original is in the Trash (recoverable); confirm the settings confirmation dialog
  appears only when switching to Move.

## Files

- `src-tauri/Cargo.toml` — add `trash`.
- `src-tauri/src/file_manager.rs` — hash-verify + trash in `import_file`; `contents_match` helper + tests.
- `src/components/settings/LibraryTab.tsx` — relabel + confirm dialog.
- Docs: `CHANGELOG.md`, `reference/LibraryStrategy.md`, `USER_TASKS.md`.
