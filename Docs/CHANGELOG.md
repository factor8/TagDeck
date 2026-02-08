# Changelog

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
