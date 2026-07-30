# Rekordbox Live Sync — Design

**Date:** 2026-07-30
**Status:** Approved, ready for implementation
**Origin:** User request — replace the "TagDeck → iTunes → Rekordbox" hop with a direct TagDeck → Rekordbox bridge that *feels* like the iTunes sync it replaces (set up once, then just hit reload in Rekordbox).

## Problem

The user's current path is: tag/organize/build sets in TagDeck → TagDeck syncs to iTunes → Rekordbox reads the iTunes library → analyze + add memory cues → export to USB. To finally drop iTunes, TagDeck needs to feed Rekordbox directly, without the user losing the "it's just there when I reload" feel iTunes gives them today.

TagDeck already ships a one-way `rekordbox.xml` export (`rekordbox.rs` + the "Export to Rekordbox…" button in Settings → Export). It works, but it is **manual**: the user must remember to click it and re-pick a destination. That is the whole gap — the export is a button, not a background sync. This feature builds the missing half: **keep a fixed `rekordbox.xml` continuously current on its own.**

### Why this is safe (the trust story, captured for implementers and setup copy)

Rekordbox's iTunes bridge and its `rekordbox xml` bridge are architecturally the same: both surface a separate read-only tree in the browser, both require dragging tracks into the Collection to analyze/cue them, and both keep analysis + memory cues attached to the **Collection** track, keyed by **file path**. Switching the source tree from iTunes to XML therefore does not touch a single cue — *as long as file paths don't change*. TagDeck references files in place (it does not relocate iTunes' files), so paths match and cues stay matched.

On import from the XML tree, Rekordbox shows *"This track already exists in the current collection. Do you want to load information in the tag of the library being imported?"*. This is the **expected, good** outcome — it proves Rekordbox matched the file to the user's existing analyzed track (no duplicate is created; duplicates only happen when paths *don't* match). "Load tag information" and "import cue points" are **separate** operations in Rekordbox; saying **Yes** updates only text metadata (name/artist/album/**comment**/rating/bpm), never cues or beat grids. The setup UI must explain this so the user isn't spooked.

## Goal

A **Rekordbox Live Sync** mode: enable it once, point Rekordbox at the file once, and thereafter TagDeck rewrites the `rekordbox.xml` automatically (debounced) whenever the library changes. The user's only ongoing action is the reload button in Rekordbox — identical to their iTunes habit.

## Non-goals

- **Live auto-reload inside Rekordbox.** Rekordbox reads the XML on launch / manual reload only; it does not watch the file. The manual reload in Rekordbox stays — it already matches the user's workflow. We keep TagDeck's side current; Rekordbox's side is a button press, same as iTunes today.
- **Genre / key / year / track# / composer / sample-rate export.** None of these are stored in TagDeck today (see §"What's exported"). **Genre** is a committed fast-follow (own spec); the rest are out of scope.
- **Writing Rekordbox's `master.db`.** Never. Unsupported/dangerous. One-way XML bridge only (unchanged policy from `LibraryStrategy.md`).
- **Two-way / reading cues back from Rekordbox.** Out of scope.
- Replacing the existing manual "Export to Rekordbox…" button — it stays for one-off exports to arbitrary paths.

## What's exported

The exporter (`build_rekordbox_xml`, `rekordbox.rs`) currently writes: `TrackID, Name, Artist, Album, Kind, Size, TotalTime, AverageBpm` (only when `bpm > 0`), `DateAdded, Rating, Comments, Location`, plus the `PLAYLISTS` tree. Missing tracks are excluded from the collection and from playlist entries.

**Changes in this feature:**

| Field | Decision | Source |
|---|---|---|
| `AverageBpm` | **Keep** (was flagged for possible removal; user wants it) | `track.bpm` (i64, integer only) |
| `BitRate` | **Add** | `track.bit_rate` |
| `Grouping` | **Add** | `track.grouping_raw` |
| `Comments` | Keep — tags ride here (chosen tag-delivery: Comment field) | `track.comment_raw` |
| `Rating` | Keep | `track.rating` |
| Genre, Key, Year, Track#, Composer, SampleRate | **Not exported** — not stored in TagDeck | n/a |

Notes for implementers / UI copy:
- **BPM is integer-only** in TagDeck's model (`bpm: i64`) and only present where TagDeck actually captured it (from iTunes or from Mixed In Key). Tracks with no BPM in TagDeck export blank. Rekordbox re-derives the authoritative grid on analysis, so exported BPM is a hint, not ground truth. Emit `AverageBpm` only when `bpm > 0` (unchanged guard).
- `BitRate`: emit only when `> 0`. Rekordbox's `BitRate` attribute is in kbps; confirm `track.bit_rate`'s unit during implementation and convert if it is bps.
- `Grouping`: emit `track.grouping_raw` verbatim when non-empty. This is independent of the tag comment contract (grouping is not used for tags).

## User flow

**One-time setup** (Settings → Export → new "Rekordbox Live Sync" panel):
1. Toggle **Keep Rekordbox in sync** on.
2. Pick the XML file location once (default `~/Music/TagDeck/rekordbox.xml`); remembered thereafter (reuses the existing `rekordbox_xml_path` config key).
3. Follow the inline setup guide: in Rekordbox, Preferences → Advanced → Database → *rekordbox xml* → select this file; enable the *rekordbox xml* tree in the browser; note where the reload button is.
4. Read the short **"what to expect"** note about the *"already exists → Yes"* dialog (expected; safe; never touches cues; how tags land in the Comment).

**Steady state:** the user tags/organizes/builds sets in TagDeck as normal. TagDeck rewrites the XML in the background (debounced). The user tabs to Rekordbox and hits reload — their latest state is there.

## Architecture

### 1. Exporter content (`rekordbox.rs`)

- In `build_rekordbox_xml`, add `BitRate` (when `> 0`) and `Grouping` (when non-empty) attributes to each `<TRACK>`; keep `AverageBpm`. Update the unit tests (`escapes_and_encodes`, `builds_document_with_tree_and_skips_missing`) to assert the new attributes.
- `build_rekordbox_xml` stays a **pure function** (slices in, `(String, RekordboxStats)` out) — reused unchanged by both the manual command and the live flush.

### 2. Atomic write (shared)

Add a small generic atomic file-write helper (temp file in the **same directory** as the destination + `std::fs::rename`, mirroring the established idiom in `metadata.rs::save_tag_repairing` at `metadata.rs:97-128`). Rekordbox must never read a half-written XML.

- Use it in **both** the live flush **and** the existing `export_rekordbox_xml` command (`commands.rs:3117` currently uses a plain `std::fs::write` — switch it to the atomic helper).

### 3. Live-sync engine (the core new piece)

Model on the existing debounce loop in `library_watcher.rs:8-185` (`std::thread::spawn` + `mpsc` + `recv_timeout` trailing-edge debounce, started once from `lib.rs:135`).

**Dirty signal.** Today **no** mutation command emits any event or sets any dirty flag (`grep '.emit(' commands.rs` → nothing). Add an `mpsc::Sender<()>` (a "ping") to `AppState` (`commands.rs:20-24`) and a `mark_rekordbox_dirty()` helper that does a non-blocking `let _ = tx.send(());`. Call it from every library-mutation command (enumerated below). This is explicit instrumentation — there is no single write choke point (each command locks `state.db` directly), so the call sites are enumerated and a maintainability rule is documented (see Risks).

**Mutation call sites to instrument** (from the code recon; all in `commands.rs` unless noted):
- Playlists: `create_playlist` (1391), `rename_playlist` (1418), `delete_playlist` (1457), `move_playlist` (1564), `duplicate_playlist` (1600), `reorder_sibling_playlists` (1612), `update_playlist_metadata` (1637), `set_playlist_sync` (1483), `restore_playlist_backup` (3208).
- Membership/order: `add_to_playlist` (1649), `remove_from_playlist` (1736), `reorder_playlist_tracks` (1805), `copy_playlist_memberships` (2231).
- Tags/comments: `write_tags` (353), `batch_add_tag` (443), `batch_remove_tag` (588), `update_track_info` (2068).
- Ratings: `update_rating` (1865).
- Imports: `import_library` (41), `import_from_music_app` (728), `import_files` (2396), `consolidate_library` (2821).
- Missing/reconcile: `mark_track_missing` (1929), `verify_library_files` (2713), `sync_recent_changes`, `sync_review::apply_sync_changes`.
- Taxonomy (changes the comment tag block indirectly): `delete_tag` (2054), `set_tag_group` (2035), `delete_tag_group` (2021).

**Flush loop.** A background thread spawned from `lib.rs` setup (next to the library watcher), holding the `AppHandle`:
1. Blocks on `rx.recv_timeout(debounce)`; coalesces a burst into one settle (trailing-edge), exactly like `library_watcher`.
2. On settle: if Live Sync is disabled or no path is configured → skip. Otherwise lock `state.db`, load `tracks` (`get_all_tracks` minus ghosts, as `export_rekordbox_xml` does) + `playlists` (`get_playlists` + `get_playlist_track_ids`), **drop the lock**, build the XML.
3. **Skip-if-unchanged:** hash the generated XML; if equal to the last-written hash, do nothing (no disk write, no reload noise). Otherwise atomic-write, update last-written hash + timestamp.
4. Emit a `rekordbox-sync-status` event (see §5).
5. **Periodic backstop:** every N minutes (default 5) while enabled, run one settle regardless of pings — a self-heal for any missed dirty-mark. Cheap because of skip-if-unchanged (rebuild in memory, write only on real change).
6. **Single-flight** is automatic: one thread serializes all writes.

**Flush on quit:** best-effort final flush on app exit / main-window close so a last-second edit lands.

**Enabled gating:** the flush checks config each settle; when disabled it is a no-op. Mutation commands may ping unconditionally (cheap).

### 4. Config (config KV table via `db.set_config`/`get_config`)

- `rekordbox_live_enabled` — bool (default false).
- `rekordbox_xml_path` — **existing** key, reused (default `~/Music/TagDeck/rekordbox.xml` offered in the picker).
- `rekordbox_debounce_secs` — int, default **3** (range e.g. 1–15).

### 5. Frontend (Settings → Export, `ExportTab.tsx`)

New **Rekordbox Live Sync** panel above/below the existing manual export button:
- **Toggle** "Keep Rekordbox in sync" → writes `rekordbox_live_enabled`. On first enable with no path, prompt the file picker (default path above).
- **File path** display + "Change…" button (reuses the save dialog).
- **Setup guide** (collapsible): the exact Rekordbox steps + the "already exists → Yes" explainer.
- **Status line** (the trust signal): `Up to date · updated 6s ago` / `Saving…` / `Pending — updates in 3s` / `Error: <msg>`. Driven by the `rekordbox-sync-status` event, with an initial fetch via a `get_rekordbox_sync_status` command.
- **Debounce interval** control → writes `rekordbox_debounce_secs`.
- Copy note: to fully drop iTunes, set iTunes sync mode → Off (Settings → iTunes) and keep this on. Files never move, so Rekordbox cues stay matched. (No forced coupling.)

### 6. Independence from iTunes

The bridge needs nothing from iTunes and is orthogonal to `SyncMode`. Cutover = iTunes mode Off + Live Sync On. No data is converted or moved.

## Error handling

- Unwritable path / disk full / drive unplugged → status shows the error + a toast; the write retries on the next ping or backstop tick. The atomic write guarantees the last good file is never corrupted (a failed temp write is discarded, original untouched).
- Missing tracks excluded from the collection and playlist entries (existing behavior, unchanged).
- Per the DB-lock discipline used elsewhere: never hold the DB lock across the file write — snapshot under lock, drop, build, write.

## Testing

**Rust unit:**
- Exporter: `BitRate` and `Grouping` present when set / absent when empty; `AverageBpm` still emitted; existing tests updated.
- Atomic write: on simulated write failure, the destination retains its previous contents and no `.tmp` residue remains.
- Skip-if-unchanged: identical rebuild produces no write (hash compare).
- Debounce coalescing: a burst of pings within the window yields exactly one settle (test the loop's coalescing logic in isolation, mirroring how `library_watcher` is reasoned about).

**Frontend:**
- Toggle persists; first-enable triggers the picker.
- Status line renders each state (idle/pending/writing/error) from the event.
- Debounce control persists.

**Manual (add to `USER_TASKS.md` — needs live Rekordbox):**
- Enable Live Sync, point Rekordbox at the file, edit a tag / reorder a playlist / add a track in TagDeck → hit reload in Rekordbox → change appears.
- Confirm the "already exists → Yes" flow updates the Comment and leaves memory cues + beat grid intact.
- Confirm no duplicate Collection entries are created.
- Confirm BPM (where present), bitrate, and grouping show on the imported tracks.
- Unplug the destination drive mid-session → error status, no corruption; replug → next edit recovers.

## Documentation

- `Docs/reference/LibraryStrategy.md` — Rekordbox section: flip "auto-export-on-change toggle" from *Deferred* to shipped; document Live Sync, the new fields (BPM kept, bitrate, grouping), the atomic write, and the "already exists → Yes" guidance.
- `Docs/CHANGELOG.md` — `[Unreleased]` → Added.
- `Docs/README.md` — if a dedicated reference doc is added for the bridge, index it.
- `USER_TASKS.md` — the manual-test checklist above.

## Risks / notes

- **Missed dirty-mark on a future command.** Mitigation: the enumerated call sites, a documented rule ("any new library-mutating command must call `mark_rekordbox_dirty()`"), and the periodic backstop flush as a self-heal. Consider a follow-up that centralizes the ping if the DB write path is ever unified.
- **Large libraries:** full rebuild on every settle. Coalescing + skip-if-unchanged keep writes rare; the in-memory rebuild is the cost. Acceptable for now; the debounce and backstop interval are tunable. Revisit if profiling shows pain.
- **BPM fidelity:** integer-only and only where TagDeck has it. Set expectations in copy; Rekordbox's own analysis remains authoritative.

## Fast-follow (separate spec)

- **Genre capture + export:** add a `genre` column, read genre from file tags on import (lofty `ItemKey::Genre`), backfill existing tracks, and emit `Genre` in the XML. Deliberately deferred so it isn't rushed.
