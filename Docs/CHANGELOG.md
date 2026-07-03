# Changelog

## [Unreleased]

### Added
- **Per-playlist iTunes sync**: each playlist now has its own sync switch. Right-click a playlist for **"Stop Syncing with iTunes"** (TagDeck keeps its copy and stops reading from/writing to Music.app — the Music.app copy is left alone, and even deleting it there no longer removes the playlist from TagDeck) or **"Sync to iTunes"** (re-links it; if it doesn't exist in Music.app yet, TagDeck creates it there and pushes the linked tracks — requires Two-way sync). Playlists that came from iTunes default to syncing on; TagDeck-created playlists default to off. The sidebar's TagDeck/iTunes sections and the Music badge now reflect actual sync state rather than where a playlist originally came from.
- **Sync Review**: preview what changed in iTunes and approve it instead of having it auto-applied. Opens automatically the first time sync is turned back on after being off, from the new "Review iTunes Changes" button in Settings → iTunes Sync (works in any mode, as a drift audit), and when tracks were removed in iTunes with deletion behavior set to "Ask me first". Shows added, removed, and changed tracks (metadata, rating, BPM) plus playlist changes, with per-item choices and apply-all.
- **Conflict protection**: tracks edited in TagDeck while sync was off or import-only are no longer silently overwritten by incoming iTunes changes — they're flagged as conflicts ("Edited in both") in Sync Review, where you pick which side wins. Choosing the TagDeck side in two-way mode pushes your version back to iTunes.
- **"Ask me first" deletion behavior** (new default): when a track is removed in iTunes, TagDeck now asks what to do via Sync Review instead of deciding automatically. Keep/Remove remain available as automatic settings.
- **iTunes Sync mode setting** (Settings → iTunes Sync): choose the relationship between TagDeck and Music.app — **Off** (no connection), **Import only** (pull changes from iTunes, never write back), or **Two-way** (full sync, the previous always-on behavior). Existing users with Music.app default to Two-way; installs without Music.app default to Off. In Off/Import-only modes, imports are handled by TagDeck's own file manager and the Library Management settings become visible.
- **iTunes deletion behavior setting**: choose what happens when a track is removed in iTunes — keep it in TagDeck marked *unlinked* (default) or remove it from TagDeck too.

### Fixed
- In Import-only mode, syncing no longer overwrites tags with iTunes' stale copy of the comment field (TagDeck stops pushing comments in that mode, so the file/TagDeck copy is authoritative).

### Changed
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
