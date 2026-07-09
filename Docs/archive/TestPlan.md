> **📦 Archived — historical / superseded.** Manual QA checklist for a since-merged feature branch. Predates AI tag suggestions, vocabulary expansion, and the play queue.
>
> For current behavior see the [CHANGELOG](../CHANGELOG.md), the [README](../../README.md), and the live docs in [Docs/reference/](../reference/). Kept for provenance; do not treat as an accurate description of the shipped app.

# Test Plan — Library Ownership & Sync (Phases 1–6)

Manual test pass for the `feature/file-management` branch (commits `38a0e7d` → `2345e84`).

Items marked ⚠️ touch Music.app or files on disk — save those for last, once the basics look good.

> A backup of the database was taken before testing:
> `~/Library/Application Support/com.factor8.tagdeck/tagdeck.db.backup-pre-phase6-test`

## Startup & migration (Phase 1 groundwork)

- [ ] App launches, all tracks and playlists present, tags/ratings/artwork intact
- [ ] No errors in the Logs window (Cmd+Opt+L) from the migration
- [ ] Sidebar shows two sections: iTunes-synced playlists and TagDeck playlists, split correctly

## Sync modes (Phase 2)

- [ ] Settings → iTunes Sync shows **Two-way** (the migrated default)
- [ ] Switch to **Off** → edit a tag on a track → nothing changes in Music.app
- [ ] While Off: Library Management settings visible in Settings (library folder, copy/move/in-place, organize toggle)
- [ ] Switch to **Import-only** → change a track's rating in Music.app → it flows into TagDeck; edit a tag in TagDeck → it does *not* appear in Music.app
- [ ] Back to **Two-way** → tag edit in TagDeck shows up in Music.app's comment field

## Sync Review & conflicts (Phase 3)

- [ ] Settings → "Review iTunes Changes…" opens a preview (not auto-applied); counts look sane
- [ ] With sync Off, edit a track in TagDeck *and* the same track in Music.app → turn sync back on → Sync Review flags it "Edited in both" and lets you pick a side
- [ ] Pick the TagDeck side (in Two-way) → your version lands in Music.app
- [ ] Delete a track in Music.app → TagDeck asks via Sync Review (default "Ask me first") instead of silently removing
- [ ] Choose "keep" → track stays with an *unlinked* badge; re-add it to Music.app → it relinks on next sync

## Per-playlist sync (Phase 4)

- [ ] Right-click iTunes playlist → **Stop Syncing with iTunes** → badge/section updates; rename it in TagDeck → Music.app copy untouched
- [ ] Change that playlist in Music.app (add/remove a track) → TagDeck ignores it
- [ ] Delete that playlist in Music.app → it survives in TagDeck
- [ ] ⚠️ Right-click a TagDeck playlist → **Sync to iTunes** → playlist appears in Music.app with its linked tracks; badge appears in TagDeck
- [ ] Folders don't offer Sync to iTunes; "Sync to iTunes" errors politely if not in Two-way mode

## File management (Phase 5)

- [ ] Drag an MP3 into the window → imports, appears in All Tracks, file lands per the import setting
- [ ] Drag the *same audio* from a different folder/filename → skipped as duplicate (hash match)
- [ ] Drag files onto a playlist → imported and added in order, toast confirms
- [ ] In Finder, move a file to another folder *inside* the TagDeck library root → within ~5s a toast reports it relocated; track still plays
- [ ] Move a file *out* of the root → toast, track gets *missing* badge; move it back → badge clears
- [ ] ⚠️ Settings → **Consolidate Library…** → confirm box → external tracks copied into the root (originals untouched, iTunes-managed tracks skipped), toast reports counts

## Exit path (Phase 6)

- [ ] Right-click playlist → **Export as M3U8…** → save dialog defaults to playlist name; open the file — paths, artist/title, durations all look right
- [ ] Export a playlist containing a missing track → it's skipped and the toast says so
- [ ] ⚠️ **Add TagDeck-only tracks to Music.app…** (Settings → iTunes) → only run if you're OK with *all* unlinked tracks going to Music; verify they appear there and lose their unlinked status in TagDeck. Safe version: test with just one standalone-imported track in the library

## Rekordbox export (Phase 7)

- [ ] Settings → Export → **Export to Rekordbox…** → save dialog → file written; toast reports track/playlist counts
- [ ] Open the XML in a text editor: locations are `file://localhost/...` paths, tags appear in `Comments`, BPM/ratings present, playlist tree matches the sidebar
- [ ] Re-export: save dialog defaults to the previously chosen file
- [ ] In Rekordbox: Preferences → Advanced → Database → "rekordbox xml" → select the file → playlists appear under *rekordbox xml* in the browser; drag a track into the collection and check title/BPM/comment carried over

## Drag-out (⌥-drag)

- [ ] Hold ⌥ and drag a track row → drop on Finder copies the file; drop on a Mail compose window attaches it
- [ ] ⌥-drag with several tracks selected → all selected files drag together
- [ ] ⌥-drag a *missing* track → nothing drags (no error)
- [ ] ⌥-drag and drop back onto the TagDeck window → nothing is imported, no toast
- [ ] Plain drag (no ⌥) still adds to playlists / reorders within a playlist
- [ ] ⚠️ ⌥-drag a track into a Rekordbox playlist → track imports there with tags in the comment field

## Playlist search

- [ ] Sidebar filter bar: typing narrows both sections; matches keep their folder context and folders show expanded; clearing (✕ or Escape) restores your previous expand/collapse state exactly
- [ ] Filter with no matches → "No matching playlists"; All Tracks stays visible
- [ ] ⌘K opens the palette; typing fuzzy-matches (try initials like "dh" for "Deep House"); ↑↓ + ↩ selects the playlist — track list switches, sidebar expands/scrolls/flashes to it
- [ ] ⌘K → pick a *folder* → it expands and flashes in the sidebar (track list unchanged)
- [ ] ⌘K → pick an iTunes playlist while the iTunes section is collapsed → section un-collapses and reveals it
- [ ] Escape and clicking the backdrop both close the palette; ⌘K toggles it closed too

## Spotify Integration

- [ ] Settings → Spotify tab: paste a Client ID from your own Spotify Developer Dashboard app (redirect URI set to exactly `http://127.0.0.1:43110/callback`) → **Connect to Spotify** opens your browser; approve access → the tab shows Connected as your account name
- [ ] Quit and relaunch TagDeck → Settings → Spotify still shows Connected with no browser round-trip, and the sidebar's Spotify section shows up on its own (no need to revisit Settings first)
- [ ] Paste an invalid or mismatched Client ID and click **Connect to Spotify** → the browser shows Spotify's own error page instead of a login prompt; TagDeck still resolves to a clear failure (denied right away, or a ~2-minute timeout) rather than hanging or crashing
- [ ] **Disconnect** → toast confirms; every imported playlist, ghost track, and tag is untouched — only the tab reverts to **Connect to Spotify**
- [ ] Sidebar's Spotify section → **Import playlists…** → checkbox list of your Spotify playlists with track counts; import a subset → toast reports the playlist/track counts and only the chosen playlists appear under the sidebar's Spotify section, rows dimmed with a small green Spotify glyph
- [ ] Reopen the import picker → a playlist you already imported shows an *Imported* tag instead of being offered as a plain new import
- [ ] Add or remove a track on an imported playlist in Spotify itself → within 15 minutes, or immediately after relaunching TagDeck, the change appears on that playlist's tracks with no action needed
- [ ] Select a ghost track inside a Spotify playlist → add a tag from the tag deck → it appears on the row right away and is still there after switching playlists (or relaunching)
- [ ] Select All Tracks → none of your imported Spotify ghost tracks appear there, even ones just imported
- [ ] Export a playlist containing ghosts to both Rekordbox XML and M3U8 → both exports quietly skip the ghosts (not counted as missing or failed) while including everything else
- [ ] Move a local file within the library root (as in Phase 5) so the watcher fires a verify pass → ghost tracks are never flagged missing (they have no file to check)
- [ ] Quit the Spotify desktop app entirely (and make sure no other device on your account is active), then double-click a ghost track → Spotify launches on its own (allow up to ~15s) and playback starts; the footer switches to the Spotify Connect transport (needs Spotify Premium)
- [ ] With Spotify already open and playing something else, double-click a different ghost track → it takes over playback on the active device
- [ ] While a ghost is playing: pause/resume with the transport button, drag (or arrow-key) the seek bar — the position only commits on release — and step Next/Previous to adjacent tracks in the playlist
- [ ] ⚠️ Drag in (or import) a local file whose artist, title, and duration closely match an imported ghost → auto-merges: a toast confirms it, the ghost disappears, its tags land in the file's comment, and it keeps its spot in the Spotify playlist as an ordinary (non-ghost) row
- [ ] ⚠️ Same, but the local file's title carries a remaster/version suffix the ghost's title doesn't have (e.g. "(2011 Remaster)") → still auto-merges
- [ ] Import a local file that's a plausible-but-uncertain match (matching title, a slightly different artist credit) → instead of merging it lands in the review queue: a toast flags a possible match and a numbered badge appears on the sidebar's Spotify header
- [ ] Click that badge → confirm one queued match → tags merge in and it drops off the list; reject another → it drops off without merging and the ghost is untouched
- [ ] Right-click a ghost with nothing queued for it → **Link to local track…** → the picker shows the ghost's album/duration and a searchable list of local tracks, with any candidate whose duration differs from the ghost's by more than 3 seconds highlighted in red → pick one → merges immediately (no confirmation step, and like all merges it isn't undoable — recover from a bad pick by re-importing the playlist and re-tagging)
- [ ] Remove an untagged ghost's track from its source playlist in Spotify, then sync (wait, or right-click a Spotify playlist → **Sync Now**) → the ghost disappears entirely; do the same with a *tagged* ghost instead → it drops out of the playlist but the ghost itself is kept
- [ ] Go offline (or otherwise make sync fail) and let auto-sync run → it fails quietly: no toast, just a cloud-off glyph on the sidebar's Spotify header (hover it for the reason) and an entry in Logs; right-click a Spotify playlist → **Sync Now** in that same offline state → this one does raise an error toast

## Cross-cutting

- [ ] Settings → Library → Playlist Backup: export writes a JSON file; Restore… opens the picker and recreates the chosen playlists (merged from main during the tab refactor — worth a smoke test)
- [ ] Cmd+Z still undoes tag edits and add-to-playlist
- [ ] Nothing unexpected in Logs after a full session

## Notes

- If Sync Review shows a huge diff on first open, that's likely real drift accumulated since the last sync — read it before applying anything.
- The library-root file watcher only picks up a *changed* root path after an app restart.
- Record anything weird here (exact toast text or screenshot) before moving to Phase 7 (Rekordbox export).
