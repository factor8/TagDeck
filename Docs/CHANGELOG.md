# Changelog

## [Unreleased]

### Added
- **Spotify integration** (Settings → Spotify): import playlists selectively, tag Spotify tracks before you own the files, play them back via Spotify Connect, and automatically merge your tags into the file once you buy the track. Requires Spotify Premium.
- **Unlink from Spotify**: right-click a wrongly matched track to undo its Spotify link — the Spotify-only entry reappears with its tags, rating, and playlist memberships, and the local track gets back the exact tags it had before the match.
- **Playlist search**: a filter bar at the top of the sidebar narrows the playlist tree as you type (matches keep their folder context, folders auto-expand while filtering), and **⌘K** opens a quick switcher — fuzzy-search all playlists and folders with parent-path breadcrumbs and iTunes badges, then hit ↩ to jump straight to one (it's selected, revealed, and flashed in the sidebar).
- **Playlist backup and restore** (Settings → Library): export all playlists — folder tree and track references — to a versioned JSON file, and restore from one with a picker (choose which playlists, folders auto-include parents). Restored tracks match by ID with a file-path fallback.
- **Drag tracks out of the app** (⌥-drag): hold Option while dragging a track row to drag the actual audio file(s) out of TagDeck — drop into Finder to copy, onto Mail to attach, or into a Rekordbox playlist to import. Works with multi-selection; missing tracks are skipped. Plain drag still adds to playlists / reorders as before.
- **Export to Rekordbox** (Settings → Export): writes the whole library — collection and playlist tree, with titles, artists, albums, BPM, ratings, and comments (so TagDeck tags ride along) — to a rekordbox.xml file. Point Rekordbox at it via Preferences → Advanced → Database → "rekordbox xml" and your playlists appear in its browser. The export destination is remembered, so re-exporting refreshes the same file. One-way by design; missing tracks are skipped.
- **Export as M3U8**: right-click any playlist for "Export as M3U8…" — writes a standard extended M3U8 file (with artist/title and durations) usable by other players and DJ software. Missing tracks are skipped and counted.
- **Add TagDeck-only tracks to Music.app** (Settings → iTunes Sync): the exit path back to iTunes. Adds every track that isn't linked to Music.app into your Music library and links it; files already present in Music.app are linked instead of duplicated. Files stay where they are — Music.app applies its own copy/organize settings.
- **Consolidate Library** (Settings → Library Management): copies every TagDeck-managed track stored outside your library folder into it (organized by artist/album), then updates the library to point at the new copies. Originals are never deleted, and tracks managed by Music.app are skipped.
- **Library folder watching**: TagDeck now watches its own library folder. Files deleted outside the app are marked *missing*, files moved within the folder are automatically relocated, and missing tracks whose files reappear are restored — with a toast summarizing what changed.
- **Smarter duplicate detection on import**: imports now compare file contents (SHA-256), not just paths, so re-importing the same audio from a moved or copied file is skipped instead of duplicated.
- **Per-playlist iTunes sync**: each playlist now has its own sync switch. Right-click a playlist for **"Stop Syncing with iTunes"** (TagDeck keeps its copy and stops reading from/writing to Music.app — the Music.app copy is left alone, and even deleting it there no longer removes the playlist from TagDeck) or **"Sync to iTunes"** (re-links it; if it doesn't exist in Music.app yet, TagDeck creates it there and pushes the linked tracks — requires Two-way sync). Playlists that came from iTunes default to syncing on; TagDeck-created playlists default to off. The sidebar's TagDeck/iTunes sections and the Music badge now reflect actual sync state rather than where a playlist originally came from.
- **Sync Review**: preview what changed in iTunes and approve it instead of having it auto-applied. Opens automatically the first time sync is turned back on after being off, from the new "Review iTunes Changes" button in Settings → iTunes Sync (works in any mode, as a drift audit), and when tracks were removed in iTunes with deletion behavior set to "Ask me first". Shows added, removed, and changed tracks (metadata, rating, BPM) plus playlist changes, with per-item choices and apply-all.
- **Conflict protection**: tracks edited in TagDeck while sync was off or import-only are no longer silently overwritten by incoming iTunes changes — they're flagged as conflicts ("Edited in both") in Sync Review, where you pick which side wins. Choosing the TagDeck side in two-way mode pushes your version back to iTunes.
- **"Ask me first" deletion behavior** (new default): when a track is removed in iTunes, TagDeck now asks what to do via Sync Review instead of deciding automatically. Keep/Remove remain available as automatic settings.
- **iTunes Sync mode setting** (Settings → iTunes Sync): choose the relationship between TagDeck and Music.app — **Off** (no connection), **Import only** (pull changes from iTunes, never write back), or **Two-way** (full sync, the previous always-on behavior). Existing users with Music.app default to Two-way; installs without Music.app default to Off. In Off/Import-only modes, imports are handled by TagDeck's own file manager and the Library Management settings become visible.
- **iTunes deletion behavior setting**: choose what happens when a track is removed in iTunes — keep it in TagDeck marked *unlinked* (default) or remove it from TagDeck too.

### Fixed
- Text fields no longer trigger macOS autocorrect, spell-check underlines, auto-capitalization, or autocomplete suggestions — search/filter bars, inline track editing (titles, artists, etc.), tag entry, and rename fields now take exactly what you type.
- Spotify tracks are no longer falsely reported as "removed from Music.app": a startup migration was stamping them with a fake iTunes link, which made deletion detection offer to remove them from TagDeck. Existing affected tracks are healed automatically on next launch.
- Tags no longer vanish after a Spotify track is matched to a purchased track: the merged tags are now pushed to Music.app (or flagged as a conflict when the sync mode doesn't allow pushing), so the next iTunes sync can't overwrite them with Music.app's stale copy of the comment.
- Loading Spotify playlists no longer fails with "missing field `tracks`": the Spotify API now reports playlist track counts under `items` instead of `tracks`, and TagDeck accepts both (a playlist missing the count entirely shows 0 instead of failing the whole list).
- Importing a Spotify playlist no longer produces an empty playlist: the same Spotify API rename also changed the per-row track wrapper from `track` to `item`, which TagDeck was silently skipping. Both names are accepted now — re-import any playlist that came in empty to backfill its tracks.
- Seeking in the Spotify player now works (the handle no longer snaps back), and pause/resume/next/previous are no longer at risk of the same failure: Spotify's servers reject bodyless PUT/POST requests without a `Content-Length` header ("411 Length Required"), so TagDeck now sends an explicit empty body on those calls.
- The app icon now follows Apple's icon-grid sizing (artwork inset with the standard transparent margin), so it no longer looks oversized next to other icons in the Dock.
- In Import-only mode, syncing no longer overwrites tags with iTunes' stale copy of the comment field (TagDeck stops pushing comments in that mode, so the file/TagDeck copy is authoritative).

### Changed
- **Settings reorganized into tabs**: the settings panel now uses a sidebar of categories — General, iTunes, Library, Export, Appearance, Developer — instead of one long two-column list. All settings are unchanged, just easier to find; the panel remembers your last open tab.
- **Library Management settings are always visible** in Settings, including under Two-way sync (with a note that Music.app currently handles imports in that mode).
- **Tracks removed from iTunes are no longer deleted from TagDeck.** They are now "unlinked": the track, its tags, and its playlist memberships stay in TagDeck, marked with an *unlinked* badge in the track list. Re-adding the track to Music.app relinks it automatically. (Previously, deleting a track in Music.app silently deleted it from TagDeck on the next sync.)

### Added
- **Persistent Logging**: All application logs now write to `~/Library/Logs/TagDeck/` following macOS conventions. Log files auto-rotate at 5 MB with up to 5 rotated files kept.
- **Debug Mode**: New toggle in Settings → Developer section. When enabled:
  - A `DEBUG` badge appears in the header bar.
  - TrackList shows a debug status bar with track count, file path, persistent ID, format, and bitrate for the selected track.
  - Player footer shows format, bitrate, BPM, and file size for the playing track.
  - Backend emits verbose `DEBUG`-level log entries (suppressed when debug mode is off).
- **Enhanced Logs Window**: Level filter pills (ERROR / WARN / INFO / DEBUG), text search, log count indicator, and a Clear button.
- **Log Management in Settings**: Developer section shows log file stats (count, total size) with buttons to open the log folder in Finder or launch the Logs window.
- **Frontend → Backend Logging**: New `log_from_frontend` Tauri command allows React code to send structured log entries through the same persistent logging pipeline.

## [0.1.2] - 2026-02-02

### Fixed
- **Tag Editing**: Fixed an issue where subsequent tag edits would fail or overwrite previous edits due to stale track data in the UI. The application now correctly refreshes the selection state after saving.
- **File Path Resolution**: Fixed an issue where files were incorrectly marked as missing due to URI decoding errors (specifically related to `file://` and `localhost` prefixes in iTunes XML).
- **Library Parsing**: Improved robust parsing of file paths from iTunes library syncing to handle various format quirks.
- **Path Auto-Correction**: Enhanced `mark_track_missing` recovery logic to check multiple common iTunes folder structures (`Music`, `iTunes Music`, `iTunes Media`) and auto-correct database entries if files are found.
- **Phantom Ratings**: Fixed an issue where tracks with "Computed" (gray) ratings in Music.app were incorrectly showing as 5-star ratings in TagDeck. The importer now correctly ignores computed ratings.
- **Build Errors**: Resolved unused variable warnings in MetadataViewer causing build failures.

### Added
- **Real-time Library Monitoring**: Implemented a background file system watcher that detects changes in the Apple Music library database (`Music Library.musiclibrary` and legacy `iTunes Library.xml` files).
- **Smart Auto-Sync**: Automatically synchronizes metadata changes from Apple Music to TagDeck within seconds of the edit. Uses a 5-second debounce and ignore logic for temporary files.
- **AppleScript Delta Query**: Replaced full library re-scans with a targeted AppleScript query that fetches only tracks modified in the last 10 minutes (plus safety buffer).
- **Metadata Viewer**: Added a new collapsible panel in the sidebar to view detailed technical metadata for selected tracks (Bitrate, File Path, Format, etc.).
