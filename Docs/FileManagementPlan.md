# File Management System - Product Plan

## Vision
Transform TagDeck from an iTunes-dependent tag editor into a **standalone music library manager** that can import, organize, and manage audio files independently, while maintaining the iTunes-style folder structure users know and love.

---

## Problem Statement
Currently, TagDeck:
- ✅ Reads from iTunes Library.xml
- ✅ Writes tags to files
- ❌ Cannot import new files
- ❌ Relies on iTunes for file organization
- ❌ Requires iTunes to discover new music

**Goal:** Enable users to drag audio files into TagDeck and have them automatically organized, imported, and ready to tag—without ever opening iTunes.

---

## Core Features

### 1. Drag & Drop Import
**User Experience:**
- Drag audio files or folders into the main window
- Drag directly onto a playlist to import AND add to that playlist
- Visual drop zones with hover states
- Progress indicator during import

**Behavior:**
- Accept: `.mp3`, `.m4a`, `.aiff`, `.aif`, `.wav`, `.flac`, `.alac`
- Reject invalid formats with user-friendly error
- Batch processing with progress reporting
- Automatic metadata reading

### 2. iTunes-Style File Organization
**Structure:**
```
~/Music/TagDeck/
├── Artist Name/
│   ├── Album Name/
│   │   ├── 01 Track Title.mp3
│   │   ├── 02 Track Title.mp3
│   │   └── cover.jpg (optional)
│   └── Single/
│       └── Track Title.mp3
└── Compilations/
    └── Album Name/
        ├── 01 Artist - Track.mp3
        └── 02 Artist - Track.mp3
```

**Naming Rules:**
- Use metadata to determine Artist, Album, Title
- Handle "Various Artists" → Compilations folder
- Sanitize filenames: remove `/`, `\`, `:`, `?`, `*`, `"`, `<`, `>`, `|`
- Preserve track numbers with zero-padding (01, 02, etc.)
- Handle missing metadata gracefully (use "Unknown Artist", "Unknown Album")

### 3. Copy vs. Move Options
**User Preference (Settings):**
- **Copy (default):** Leave original files untouched, copy to managed folder
- **Move:** Delete original after successful copy
- **In-place:** Add to library without moving (advanced users)

**Safety:**
- Always verify copy succeeded before deleting original
- MD5 or file size verification
- Undo/rollback capability

### 4. Duplicate Detection
**Strategy:**
- Check by file path first (already in library?)
- Audio fingerprinting or metadata matching
- Prompt user:
  - Skip duplicate
  - Import anyway (keep both)
  - Replace existing

### 5. Library Root Configuration
**Settings Panel:**
- Choose library root folder (default: `~/Music/TagDeck`)
- Option to organize existing files
- "Consolidate Library" action (like iTunes)

### 6. Playlist Integration
**Drag onto Playlist:**
- Import files if not in library
- Add to target playlist in order dropped
- Visual feedback during operation

**Import into New Playlist:**
- Right-click folder → "Import as Playlist"
- Playlist named after folder
- Maintains file order

---

## User Experience Flow

### Basic Import
1. User drags `track.mp3` into TagDeck window
2. App reads metadata: Artist="Moby", Album="Play", Title="Porcelain"
3. App copies file to: `~/Music/TagDeck/Moby/Play/01 Porcelain.mp3`
4. App creates track in database with new file path
5. Track appears in "All Tracks" and is ready to tag

### Import to Playlist
1. User drags 3 files onto "Chill Vibes" playlist
2. App imports each file (as above)
3. App adds all 3 tracks to "Chill Vibes" in drop order
4. Toast notification: "Added 3 tracks to Chill Vibes"

### Folder Import
1. User drags folder with 50 files
2. Progress modal: "Importing 50 tracks..."
3. App processes each file, shows progress bar
4. Summary: "Imported 48 tracks, skipped 2 duplicates"

---

## Technical Architecture

### Frontend Components
```
ImportDropZone (overlay)
├── Handles drag events on window
├── Shows visual feedback
└── Triggers import command

PlaylistDropZone (per playlist)
├── Handles drops on playlist items
└── Triggers import + add-to-playlist

ImportProgressModal
├── Shows file processing progress
├── List of successes/errors
└── Cancel button

SettingsPanel (new section)
├── Library root folder picker
├── Copy/Move/In-place selector
└── "Consolidate Library" button
```

### Rust Backend (Tauri Commands)

#### New Commands
```rust
// Import files from arbitrary paths
import_files(paths: Vec<String>, target_playlist_id: Option<i64>)
  → Result<ImportSummary, String>

// Organize existing library files
consolidate_library()
  → Result<ConsolidationReport, String>

// Get/set library configuration
get_library_config() → Result<LibraryConfig, String>
set_library_root(path: String) → Result<(), String>
set_import_mode(mode: ImportMode) → Result<(), String>

// Check for duplicates
check_duplicate(file_path: String) → Result<Option<Track>, String>
```

#### New Modules
```rust
// src-tauri/src/file_manager.rs
- copy_and_organize_file()
- generate_organized_path()
- sanitize_filename()
- verify_copy()

// src-tauri/src/duplicate_detector.rs
- check_by_path()
- check_by_fingerprint()
- find_similar()
```

### Database Schema Changes
```sql
-- Track library configuration
CREATE TABLE library_config (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Track original file paths for reference
ALTER TABLE tracks ADD COLUMN original_path TEXT;
ALTER TABLE tracks ADD COLUMN import_date INTEGER;
ALTER TABLE tracks ADD COLUMN file_hash TEXT;
```

---

## Settings UI

**New "Library" section in Settings Panel:**
```
┌─ Library Management ────────────────────────────┐
│                                                  │
│ Library Location:                                │
│ [~/Music/TagDeck              ] [Choose...]      │
│                                                  │
│ When importing files:                            │
│ ○ Copy to library (recommended)                  │
│ ○ Move to library                                │
│ ○ Keep files in place (advanced)                 │
│                                                  │
│ ☐ Organize files by artist and album            │
│                                                  │
│ [Consolidate Library...]                         │
│ Organize all existing files in library           │
│                                                  │
└──────────────────────────────────────────────────┘
```

---

## Edge Cases & Considerations

### Missing Metadata
- **No Artist:** Use "Unknown Artist"
- **No Album:** Use "Singles" or "Unknown Album"
- **No Title:** Use original filename
- **No Track Number:** Don't prepend number

### Filename Collisions
- If `01 Track.mp3` exists, try:
  - `01 Track 2.mp3`
  - `01 Track 3.mp3`
  - etc.

### Special Characters
- Unicode support for international characters
- Replace filesystem-unsafe characters with safe equivalents:
  - `/` → `-`
  - `:` → `-`
  - `?` → `` (remove)

### Compilation Albums
- Check metadata for "compilation" flag or various artists
- Route to `Compilations/` instead of artist folder
- Include artist in track filename: `01 Artist - Title.mp3`

### Large Imports
- Process in batches (50 files at a time)
- Async/non-blocking UI
- Allow cancellation mid-process
- Show detailed progress

### Permission Errors
- Graceful handling of read-only files
- Error reporting with file path and reason
- Retry mechanism for transient errors

---

## Phase 1 (MVP)
- [ ] Basic drag & drop into window
- [ ] Copy files to library root (flat structure)
- [ ] Read metadata and create track records
- [ ] Simple progress indicator
- [ ] Error handling and reporting

## Phase 2 (Organized)
- [ ] Implement iTunes-style folder organization
- [ ] Artist/Album/Track hierarchy
- [ ] Filename sanitization
- [ ] Settings for library location

## Phase 3 (Playlists)
- [ ] Drag onto playlist to import + add
- [ ] Import folder as playlist
- [ ] Duplicate detection

## Phase 4 (Polish)
- [ ] Copy vs. Move vs. In-place options
- [ ] Consolidate library feature
- [ ] Advanced duplicate handling
- [ ] Batch import optimization

---

## Success Metrics
1. **User can import 100 files in < 30 seconds**
2. **Zero data loss during import**
3. **File organization matches iTunes structure 1:1**
4. **Users can fully manage library without iTunes**
5. **All metadata preserved during import**

---

## Migration Path
For existing TagDeck users who have iTunes libraries:

1. **Continue iTunes workflow** (no breaking changes)
2. **Optionally import new files** via drag & drop
3. **Gradually migrate** with "Consolidate Library" button
4. **Eventually remove iTunes.xml dependency** (if desired)

TagDeck becomes both an iTunes companion AND a standalone app.
