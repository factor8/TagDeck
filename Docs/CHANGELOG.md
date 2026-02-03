# Changelog

## [0.1.2] - 2026-02-02

### Fixed
- **File Path Resolution**: Fixed an issue where files were incorrectly marked as missing due to URI decoding errors (specifically related to `file://` and `localhost` prefixes in iTunes XML).
- **Library Parsing**: Improved robust parsing of file paths from iTunes library syncing to handle various format quirks.
- **Path Auto-Correction**: Enhanced `mark_track_missing` recovery logic to check multiple common iTunes folder structures (`Music`, `iTunes Music`, `iTunes Media`) and auto-correct database entries if files are found.
- **Phantom Ratings**: Fixed an issue where tracks with "Computed" (gray) ratings in Music.app were incorrectly showing as 5-star ratings in TagDeck. The importer now correctly ignores computed ratings.

### Added
- **Metadata Viewer**: Added a new collapsible panel in the sidebar to view detailed technical metadata for selected tracks (Bitrate, File Path, Format, etc.).
