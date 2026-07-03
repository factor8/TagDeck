# Library Ownership & Sync Strategy

**Status:** Approved direction — July 2026
**Decisions:** TagDeck owns the library (iTunes is an optional link) · global + per-playlist sync control · Off / Import-only / Two-way modes · Rekordbox via rekordbox.xml export bridge.

## Where we are today

The library is a derived mirror of iTunes:

- Every track/playlist is keyed on the iTunes `persistent_id`.
- `sync_recent_changes` Phase 0 **deletes** any TagDeck track missing from Music.app. Playlists have an `origin` escape hatch ("tagdeck" playlists survive sync); tracks do not.
- `import_files` routes on *whether Music.app is installed*, not user preference. The standalone file pipeline (`file_manager.rs`: Copy/Move/InPlace, organized `~/Music/TagDeck` folders) only runs when Music.app is absent, and its settings UI is hidden otherwise.
- Tags already live in the audio file's comment field (file = golden source), so they are independent of any library regime. This stays unchanged.

## Target model

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
- A track vanishing from Music.app is **unlinked** (`itunes_pid = NULL`, badged in UI), never auto-deleted. Deletion is only ever user-initiated in TagDeck.

### iTunes relationship modes (global setting, stored in `library_config`)

| Mode | Pull (iTunes → TagDeck) | Push (TagDeck → iTunes) | Imports added to Music.app |
|---|---|---|---|
| **Off** | never | never | no |
| **Import-only** | on demand / real-time | never | no |
| **Two-way** (current behavior) | real-time | tags, ratings, track info, playlist edits | optional toggle |

- Replace every `is_apple_music_available()` *behavior* gate (import routing, settings visibility, write-back calls) with a mode check. Availability detection remains only to gray out modes that can't work.
- Migration/default: existing users with Music.app → **Two-way** (no behavior change); fresh installs get a first-run choice.
- **Import-only tag-clobber guard:** file comments are the golden source. In Import-only mode we never push comments to Music.app, so Music's comment goes stale; Phase 1 pulls must therefore **exclude the comment field** (or re-read it from the file) or a sync would overwrite fresh tags in the DB with iTunes' stale copy. Same guard applies in Two-way if a push fails.

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
- Add **Consolidate Library**: copy all InPlace/external tracks into the organized root (already sketched in FileManagementPlan.md).

### Rekordbox (export bridge)

- Write a `rekordbox.xml` (`DJ_PLAYLISTS` format): `COLLECTION` of tracks (location, title/artist/album, BPM, comment — tags ride along in the comment) plus the `PLAYLISTS` tree.
- User points Rekordbox → Preferences → Advanced → Database → "rekordbox xml" at the file; playlists appear under *rekordbox xml* in the browser and can be dragged into the collection.
- Manual "Export to Rekordbox" button first; later an auto-export-on-change toggle. Optional per-playlist include flag (reuse the sort of pattern as `itunes_sync_enabled`).
- One-way by design. No master.db writing (unsupported/dangerous). Keep the existing `touch_file` behavior so re-analyzed files refresh in Rekordbox.

## Build order

1. **Identity decoupling** — `itunes_pid` column + migration; sync joins on it; Phase 0 unlinks instead of deletes; "unlinked" badge.
2. **Sync mode setting** — Off/Import-only/Two-way in `library_config` + Settings UI; replace availability gates; import-only comment guard; first-run default logic.
3. **Per-playlist sync** — wire `itunes_sync_enabled`; context-menu link/unlink actions; update Phase 3 + write-back gates.
4. **File management hardening** — always-visible settings, `file_hash` dedup, TagDeck-root watcher, Consolidate Library.
5. **Rekordbox export** — rekordbox.xml writer + export UI.

Each phase ships independently; 1–2 are the foundation and should land before anything else builds on the mode setting.

## Risks / notes

- **Stale-comment clobber** (Import-only) is the one real data-loss hazard — handled by excluding comments from pulls in that mode.
- Unlinked-track accumulation: users who prune in Music.app will accrue unlinked tracks; the badge plus a "Show unlinked" filter (and easy multi-delete) keeps this manageable.
- Rekordbox XML import is manual on Rekordbox 6+ (no live sync possible); set expectations in UI copy.
- Docs/FileManagementPlan.md checkboxes are stale (Phases 1–4 are actually implemented) — update when Phase 4 work starts.
