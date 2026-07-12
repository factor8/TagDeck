# Atomic Tag Writes — Design

**Date:** 2026-07-12
**Status:** Approved (implementing)
**Risk-assessment finding:** #5 — non-atomic tag writes can corrupt an audio file (MEDIUM, file-corruption exposure)

## Problem

Every tag write in TagDeck ultimately calls lofty's `tag.save_to_path(path, …)`, which
**rewrites the audio file in place** — it opens the user's file, truncates/rewrites the tag
region, and re-lays the audio. If the process crashes, is killed, or the machine loses
power partway through, the file can be left truncated or with a half-written tag — i.e. a
corrupted audio file that no longer plays.

All tag writes funnel through one function, `save_tag_repairing` in `metadata.rs` (used by
both `write_metadata` for tag/comment edits and `write_track_info` for title/artist/album/BPM).
So a single fix makes every write path safe.

Note: the existing `normalize_mpeg_junk_gap` already writes atomically (temp + rename). Only
the main `save_to_path` writes are in-place.

## Design

Make `save_tag_repairing` write to a sibling temp copy and swap it in atomically:

1. **Temp copy.** `fs::copy(original → sibling_temp)` where the temp is in the **same
   directory** as the original (`path.with_extension("tagdeck-writing")`) so the final
   rename stays on one filesystem and is therefore atomic. lofty edits in place, so the
   temp must start as a full byte copy of the original, not an empty file.
2. **Write against the temp.** Run `save_to_path(temp, …)`; on the format-detection
   failure, run `normalize_mpeg_junk_gap(temp)` and retry against the temp — exactly the
   current repair logic, just pointed at the temp. lofty detects format from content, not
   extension, so the temp's extension is irrelevant to the write.
3. **Atomic swap.** On success, `fs::rename(temp → original)`. `rename(2)` on the same
   filesystem atomically replaces the destination, so a reader/crash sees either the old
   file or the new file, never a partial one.
4. **Clean failure.** On any error, delete the temp and return the error. The original is
   never opened for writing, so it is left byte-for-byte intact.

Permissions: `fs::copy` copies the source's permission bits on Unix, so the swapped-in file
keeps the original's mode. (mtime changes — acceptable; any tag edit changes mtime anyway.)

Concurrency: bulk tagging is sequential (one file at a time), and no two operations target
the same file concurrently, so a deterministic per-file temp name has no collision risk. A
stale temp from a prior crash is harmlessly overwritten by `fs::copy` (which truncates the
destination).

## Cost

One extra full-file copy per tag write. In-place writes already read+write the whole file,
so this roughly doubles per-track I/O. Bulk tagging is sequential (no parallel amplification),
and preventing file corruption is the stated priority — the trade is worth it. No change to
`Copy`/`InPlace` import or any non-tag path.

## Non-goals

- Not touching the `verify_tags` dev binary (separate, non-user path).
- Not adding fsync/durability guarantees beyond atomic replacement (crash-consistency of
  *which* version you get, not battery-backed durability).
- Not parallelizing bulk tagging.

## Testing

- **Unit (Rust):** write a real tag to a temp MP3/FLAC fixture via `write_metadata`, read it
  back, assert the value round-trips and the file still parses (proves the atomic path
  produces a valid file). Assert no `*.tagdeck-writing` leftover remains after a successful
  write. A crash mid-rename can't be simulated in-process; the atomicity guarantee rests on
  `rename(2)` semantics, which the design relies on rather than tests.
- **Manual (USER_TASKS):** tag a track normally and confirm the edit sticks and the file
  plays — a smoke check that the atomic swap didn't regress normal writes.

## Files

- `src-tauri/src/metadata.rs` — rewrite `save_tag_repairing` to temp-copy + atomic rename; add test.
- Docs: `CHANGELOG.md`, `reference/` (tag-write note if applicable), `USER_TASKS.md`, README index.
