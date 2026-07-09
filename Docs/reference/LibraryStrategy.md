# Library Ownership & Sync Strategy

**Status:** Shipped — canonical design-of-record. This is the superset reference for TagDeck's library-ownership and iTunes-sync system; the whole build order below has landed.
**Decisions:** TagDeck owns the library (iTunes is an optional link) · global + per-playlist sync control · Off / Import-only / Two-way modes · Rekordbox via rekordbox.xml export bridge.

**Framing: parity first.** Nearly every user arrives with a library iTunes built. Full parity with that library is the default experience — first-run leads with "Import your iTunes library" (catalog only: no files are copied or moved; TagDeck references the files where iTunes keeps them) and Two-way sync stays on. "TagDeck owns the library" changes only the *divergence* path: disagreements between the two sides get surfaced instead of silently resolved in iTunes' favor.

## Background (the pre-refactor world)

Before this system shipped, the library was a derived mirror of iTunes. This is recorded here only as the starting point the refactor moved away from — none of it describes current behavior:

- Every track/playlist was keyed on the iTunes `persistent_id`.
- `sync_recent_changes` Phase 0 **deleted** any TagDeck track missing from Music.app. Playlists had an `origin` escape hatch ("tagdeck" playlists survived sync); tracks did not.
- `import_files` routed on *whether Music.app was installed*, not user preference. The standalone file pipeline (`file_manager.rs`: Copy/Move/InPlace, organized `~/Music/TagDeck` folders) only ran when Music.app was absent, and its settings UI was hidden otherwise.
- Tags already lived in the audio file's comment field (file = golden source), so they were independent of any library regime — the one thing carried through unchanged.

The sections below describe the **current shipped system**, which supersedes all of the above.

## The model (shipped)

**TagDeck is the library. iTunes is an optional, per-track link.**

```
Audio file (tags/comments)  ← golden source for tag data
        ↑↓
TagDeck DB (identity, playlists, ratings index)  ← owns existence
        ↑↓ optional link (itunes_pid)
Music.app                    ← peer, per sync mode
        ↓ export
rekordbox.xml → Rekordbox → CDJs
```

### Identity

- Keep `persistent_id` as TagDeck's internal stable ID (it's already the join key everywhere — no rekeying migration).
- Add nullable `tracks.itunes_pid`. Migration: for existing tracks, `itunes_pid = persistent_id` unless it starts with `TD-`. All sync joins move from `persistent_id` to `itunes_pid`.
- New imports always mint `TD-<hex>` persistent IDs. If the file is also added to Music.app, the returned Music PID goes in `itunes_pid`.
- A track vanishing from Music.app is **unlinked** (`itunes_pid = NULL`, `unlinked_at` stamped, badged in UI), never auto-deleted silently. A setting governs what happens next — **"When a track is removed from iTunes: ask me (default, via Sync Review) / remove from TagDeck too / keep as unlinked"** — so strict-mirror users can opt into the old strict-mirror behavior deliberately. In code this is `DeletionBehavior {Ask, Keep, Remove}` with **`Ask` as the persisted default**.[^deldefault]

[^deldefault]: One subtlety: the stored default is `Ask`, but the Phase 0 sync path in `commands.rs` falls back to `DeletionBehavior::Keep` **only when the config row can't be loaded** (`LibraryConfig::load(...).map(...).unwrap_or(DeletionBehavior::Keep)`). This is a fail-safe for the rare load failure — it unlinks rather than deleting — not the user-facing default, which remains `Ask`.

### iTunes relationship modes (global setting, stored in `library_config`)

| Mode | Pull (iTunes → TagDeck) | Push (TagDeck → iTunes) | Imports added to Music.app |
|---|---|---|---|
| **Off** | never | never | no |
| **Import-only** | on demand / real-time | never | no |
| **Two-way** (current behavior) | real-time | tags, ratings, track info, playlist edits | optional toggle |

- Replace every `is_apple_music_available()` *behavior* gate (import routing, settings visibility, write-back calls) with a mode check. Availability detection remains only to gray out modes that can't work.
- Migration/default: existing users with Music.app → **Two-way** (no behavior change); fresh installs get a first-run choice.
- **Import-only tag-clobber guard:** file comments are the golden source. In Import-only mode we never push comments to Music.app, so Music's comment goes stale; Phase 1 pulls must therefore **exclude the comment field** (or re-read it from the file) or a sync would overwrite fresh tags in the DB with iTunes' stale copy. Same guard applies in Two-way if a push fails.

### Sync Review (reconciliation helper)

The existing sync engine already computes every diff we need (Phase 0 adds/removes, Phase 1 metadata, Phase 2 rating/BPM snapshot, Phase 3 playlists). Sync Review reuses those diffs but **presents them for approval instead of auto-applying** — "while sync was off: 43 tracks added in iTunes, 3 removed, 12 comments changed…" with apply-all or per-item choices.

- **Dirty flags for conflict detection:** a per-track `dirty_since_sync` flag set on any TagDeck-side edit while sync is off/import-only. On reconcile, iTunes-only changes apply automatically; both-sides-changed items go to the review UI to pick a side. No three-way merge needed — file tags are never at risk (file is golden source); only the DB/iTunes view reconciles.
- One feature, three uses: reconciliation after a sync-off period, the "ask me" deletion confirm above, and an on-demand drift audit.
- Direction is symmetric: the same diff run with pushes enabled is the "export my TagDeck changes back to iTunes" path (see Exit path).

### Per-playlist sync

- Wire up the existing (persisted, never-read) `playlists.itunes_sync_enabled` flag.
- Defaults: iTunes-origin playlists → on; TagDeck-origin → off.
- Sync Phase 3 and the write-back gates in `add_to_playlist` / `remove_from_playlist` / `rename_playlist` switch from `origin == "itunes"` checks to `itunes_sync_enabled && mode == TwoWay`.
- Context-menu actions: **"Stop syncing with iTunes"** (flag off — playlist becomes TagDeck-owned, survives sync) and **"Sync to iTunes"** (creates the playlist in Music.app if missing, links, flag on).
- Turning the global mode Off simply stops all sync; nothing is converted or deleted. Links are kept so re-enabling reconnects cleanly.

### File management (always-on, not a fallback)

- Library root / Copy-Move-InPlace / organize settings become always visible. In Two-way mode with "add to Music.app" enabled, Music still organizes files (current behavior); otherwise `file_manager` handles every import.
- Populate the existing dead `file_hash` column on import; dedup by hash **or** path (today it's path-only).
- Extend `library_watcher` to also watch the TagDeck root: mark tracks `missing` on delete, offer relocate on move.
- Add **Consolidate Library**: copy all InPlace/external tracks into the organized root (already sketched in [FileManagementPlan.md](../roadmap/FileManagementPlan.md)).

### Rekordbox (export bridge)

**Resolved decision — shipped as the XML-bridge export in `rekordbox.rs`.** The considered alternatives (UI automation, direct `master.db` writes) were rejected as fragile / dangerous; the XML bridge is the one supported path.

- Writes a `rekordbox.xml` (`DJ_PLAYLISTS` format): `COLLECTION` of tracks (location, title/artist/album, BPM, comment — tags ride along in the comment) plus the `PLAYLISTS` tree. Missing tracks are excluded from the collection and from playlist entries.
- User points Rekordbox → Preferences → Advanced → Database → "rekordbox xml" at the file; playlists appear under *rekordbox xml* in the browser and can be dragged into the collection.
- Shipped: manual "Export to Rekordbox…" (Settings), destination remembered for re-export. Deferred: auto-export-on-change toggle, optional per-playlist include flag (would reuse the `itunes_sync_enabled` pattern).
- One-way by design. **Never** touches Rekordbox's own `master.db` (unsupported/dangerous). The existing `touch_file` behavior is kept so re-analyzed files refresh in Rekordbox.

### Exit path (back to iTunes)

A trust feature: users commit more readily when leaving is safe.

- **Tags survive by design** — they live in file comments, and Two-way mode already pushes them into Music.app. Files are never relocated from iTunes' folders by import, so quitting TagDeck leaves the iTunes library exactly as it was.
- **"Export to Music.app"** — for TagDeck-only tracks/playlists (standalone imports, tagdeck-origin playlists): add files via the existing `add_file_to_music_library` AppleScript and recreate playlists via existing write-back functions.
- **M3U8 playlist export** — universal escape hatch (also useful beyond iTunes).
- A user who ran sync-off for months runs Sync Review once with pushes enabled to land their TagDeck-side changes in iTunes before leaving.

## Tag storage format (still-live contract)

Tags are stored **in the audio file itself**, inside the standard Comment metadata field (ID3v2 `COMM` on MP3/AIFF, the equivalent Comment atom elsewhere). The file is the golden source for tag data; the DB's `comment_raw` column mirrors it. This delimited-comment contract — preserved here from the now-archived `SyncStrategy.md` — is shared across the Rust and TypeScript sides and read by iTunes, Rekordbox, and any other tag-aware player.

**Format:**

```text
{user comment} && {tag1; tag2; tag3}
```

**Example:**

```text
Great opener for sunset set && Energetic; Vocals; Ethereal
```

**Rules (see `metadata.rs` write path and `models.rs::parse_comment_tags`):**

1. Split the raw comment on the **first** `" && "` (space-ampersand-ampersand-space).
2. Part 0 is the user's free-text comment — preserved verbatim, never touched by TagDeck.
3. Part 1 is the tag block: `;`-separated tag names, each trimmed; empty entries dropped. On write it is fully overwritten with TagDeck's current active tags for the track.
4. A track with tags but no user comment is stored with a leading delimiter (`" && House; Techno"`). A track with no `" && "` at all has zero tags.
5. `metadata.rs` writes only the Comment field for this contract (Grouping / `ContentGroup` is intentionally left alone) and strips ID3v1 first to avoid iTunes reading a stale copy.

## Shipped architecture

All of the following has landed — this is the built system, not a plan. The original build order (foundation first: identity + mode setting, then everything layered on the mode) is preserved here as a map of where each piece lives.

- **Identity decoupling** — `itunes_pid` column + migration; all sync joins key on it; Phase 0 (`sync_recent_changes` in `commands.rs`) **unlinks** instead of deletes; "unlinked" badge; `dirty_since_sync` conflict flag.
- **Sync mode setting** — `SyncMode {Off, ImportOnly, TwoWay}` in `library_config` (`file_manager.rs`) + Settings UI; `pull_enabled()` / `push_enabled()` replace the old availability gates; import-only comment guard; first-run default logic; `DeletionBehavior` setting.
- **Sync Review** (`sync_review.rs`) — `preview_sync` computes a dry-run diff over the same phases as sync (Phase 0 adds/removes, Phase 1 metadata, Phase 2 rating/BPM, Phase 3 playlists); `apply_sync_changes` applies exactly what the user accepted; conflict detection via dirty flags; `Ask` deletions route here (surfaced as `conflicts_skipped` / `pending_removals` from a sync run).
- **Per-playlist sync** — `playlists.itunes_sync_enabled` wired; context-menu link/unlink; Phase 3 + write-back gates key on `itunes_sync_enabled && mode == TwoWay`.
- **File management hardening** — always-visible settings, SHA-256 `file_hash` dedup (`hash_file` in `file_manager.rs`), TagDeck-root watcher (`library_watcher.rs` also watches the library root and emits `tagdeck-library-changed` → `verify_library_files`), and **Consolidate Library** (`consolidate_library`).
- **Exit path** — "Add TagDeck-only tracks to Music.app" in Settings → iTunes Sync; per-playlist "Export as M3U8…". (Playlist recreation in Music.app is covered by the per-playlist "Sync to iTunes" action.)
- **Rekordbox export** — `rekordbox.xml` writer (`rekordbox.rs`, unit-tested) + "Export to Rekordbox…" in Settings; destination remembered for re-export.

## Risks / notes

- **Stale-comment clobber** (Import-only) is the one real data-loss hazard — handled by excluding comments from pulls in that mode.
- Unlinked-track accumulation: users who prune in Music.app will accrue unlinked tracks; the badge plus a "Show unlinked" filter (and easy multi-delete) keeps this manageable.
- Rekordbox XML import is manual on Rekordbox 6+ (no live sync possible); set expectations in UI copy.
- [FileManagementPlan.md](../roadmap/FileManagementPlan.md) checkboxes reflect the file-management-hardening work; remaining gaps tracked there: folder-as-playlist import, batch import optimization.
