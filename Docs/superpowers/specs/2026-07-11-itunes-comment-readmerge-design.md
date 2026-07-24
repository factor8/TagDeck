# iTunes Comment Read-Merge on Push — Design

**Date:** 2026-07-11
**Status:** Approved, ready for implementation
**Origin:** File/data-loss risk assessment (HIGH finding #2)

## Problem

TagDeck stores its tags inside the audio Comments field as
`"<user free-text> && tag1; tag2; tag3"` (delimiter `" && "`). In two-way
(push-enabled) sync, every tag edit reconstructs that whole string from the DB's
`comment_raw` and writes it to Music.app wholesale via
`set comment of myTrack to "..."` ([apple_music.rs:225](../../../src-tauri/src/apple_music.rs)).

The user free-text portion is carried along from the DB's copy — which is only
as fresh as the last pull. When the DB's `comment_raw` is stale relative to
iTunes' live comment (first time two-way is enabled on a track, a track whose
iTunes comment was edited since import, or a push that races ahead of the
watcher's pull), the push **overwrites the user's iTunes note** with TagDeck's
stale copy. There is no backup and no merge.

No audio file is corrupted; the data at risk is the user's free-text note in the
iTunes Comments field.

## Goal

Make it impossible for a tag-edit push to overwrite the user's live iTunes note,
without regressing the one path where the user *intentionally* edits that note in
TagDeck.

## Model

**iTunes owns the free-text note; TagDeck owns the tag block.** A tag-edit push
never authors free-text — it only replaces the tag block, preserving whatever
note currently lives in iTunes. The single path where the user authors free-text
in TagDeck (the inline comment-column edit) keeps writing it directly.

This is safe with no regression because the tag editor's free-text field is
**read-only** (parsed from `comment_raw` and passed back unchanged —
[TagEditor.tsx:308-334](../../../src/components/TagEditor.tsx)); it never carries
a user-authored note into the push.

## Approach

### Read-merge push (tag paths)

Change the tag-carrying push so, per track:

```
live      = read `comment` from Music.app        // authoritative user note
user      = live before the first " && "         // preserved as-is
tag_block = <TagDeck's tag block>                // derived in Rust
next      = if tag_block empty        -> user
           else if user empty         -> " && " + tag_block   // matches existing format
           else                       -> user + " && " + tag_block
set comment = next
```

`tag_block` is derived in Rust from the full comment the callers already pass
(`full.splitn(2, " && ").nth(1).unwrap_or("")`), so **callers are unchanged**.
The live read + rebuild happens inside the push functions.

Music.app not running → the existing `app.running()` / `is running` guard makes
the push a no-op (unchanged); the edit still lands in the file and DB.

### Which paths read-merge (tag/tag-block pushes)

- `batch_update_track_comments` ([apple_music.rs:248](../../../src-tauri/src/apple_music.rs)) —
  all six callers push a reconstructed `"user && tags"` and never author
  free-text: batch add/remove tag ([commands.rs:560](../../../src-tauri/src/commands.rs),
  [commands.rs:700](../../../src-tauri/src/commands.rs)), tag undo/redo
  ([undo.rs:107](../../../src-tauri/src/undo.rs), [undo.rs:199](../../../src-tauri/src/undo.rs)),
  Spotify merge/unlink push ([merge.rs:293](../../../src-tauri/src/spotify/merge.rs),
  [spotify/commands.rs:264](../../../src-tauri/src/spotify/commands.rs)).
- `write_tags` single-track save ([commands.rs:403](../../../src-tauri/src/commands.rs)) —
  rerouted from `update_track_comment` to the read-merge batch function with a
  single entry.

### Which paths stay direct-set (user authored the note → TagDeck wins)

- Inline comment-column edit via `update_track_info`
  ([commands.rs:2065](../../../src-tauri/src/commands.rs)) — the only free-text
  authoring path.
- Undo/redo of a track-info edit ([undo.rs:302](../../../src-tauri/src/undo.rs)).
- Sync Review "keep TagDeck side" conflict resolution
  ([sync_review.rs:513](../../../src-tauri/src/sync_review.rs)).

These continue to call `update_track_comment` (direct `set comment`), which
remains a direct-set for exactly these whole-comment authoring cases.

## Implementation

1. **`batch_update_track_comments`** — Rust derives `tag_block` per entry and
   passes `{id, tagBlock}` (JSON) to the JXA. The JXA reads
   `tracks[0].comment()`, takes the substring before the first `" && "`, and
   rebuilds per the rule above.
2. **`write_tags`** — replace the `update_track_comment(itunes_pid, &new_tags)`
   call with a single-entry read-merge push (the batch function, or a thin
   `update_track_tag_block` wrapper over it).
3. **`update_track_comment`** — unchanged (direct set); still used by the
   authoring paths above.
4. Extract the tag-block derivation into a small pure Rust helper so it can be
   unit-tested.

No DB schema change. No frontend change.

## Edge cases

- Empty user note + tags → `" && tags"` (leading `" && "`), matching TagDeck's
  existing reconstruction so pulls stay consistent.
- Tags cleared (no tag block) → the live user note only.
- User note containing a literal `" && "` → first-delimiter split, identical to
  the parsing already used across the app (pre-existing, accepted ambiguity).
- iTunes-side tag edits not yet pulled are overwritten by TagDeck's tag block on
  the next tag push — unchanged from today and consistent with "TagDeck owns the
  tag block" (they are pulled back via modification-date sync regardless).

## Testing

- Unit tests on the tag-block derivation helper (has-tags, no-delimiter,
  empty-tags, leading-`" && "`).
- The live JXA read-merge requires a running Music.app; covered by a manual
  test recorded in USER_TASKS.md (edit a note in iTunes, add a tag in TagDeck,
  confirm the note survives; then edit the note in TagDeck's comment column and
  confirm it pushes).

## Out of scope

- No `comment_raw` baseline/three-way-merge column (the read-merge model makes it
  unnecessary for the tag paths; the authoring path is intentional and direct).
- Other risk-assessment findings (Move-mode warning, atomic tag writes,
  reorder_playlist, Delete/Backspace confirm) are tracked separately.
