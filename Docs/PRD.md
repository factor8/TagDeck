# Product Requirements Document (PRD)

## Product Name (working)
**TagDeck**

## Target Platform
**macOS desktop app** (web UI packaged via Tauri or Electron)

## Target Workflow
Apple Music (iTunes) → local files → Rekordbox → CDJ

---

## Problem Statement
DJs use Apple Music to organize files and playlists, then move those files into Rekordbox for performance. There is no fast, **listening-first**, **playlist-aware**, **CDJ-safe** way to apply consistent semantic tags at scale.

Most tag editors:
- expose raw metadata fields,
- require manual text editing,
- are not optimized for rapid listening + tagging,
- or store tags in formats that break CDJ search.

---

## Product Goal
Enable a DJ to:
1. Open a playlist from Apple Music
2. Listen to each track
3. Apply semantic tags via **clickable pills**
4. Have those tags written as **file-level metadata**
5. See those tags searchable in both Apple Music **and on CDJs**

---

## Core Design Principles (non-negotiable)

1. File metadata is the source of truth
2. Human-readable text wins over machine encoding
3. CDJ search behavior dictates format
4. Users never edit raw metadata strings
5. The app owns normalization and formatting

---

## Metadata Storage Specification

### Target Field
- **Primary:** Comment (ID3v2 `COMM` frame)
- **Secondary:** Grouping (ID3v2 `TIT1` / `Content Group Description`) (Backup purposes)

### On-Disk Format (LOCKED)
`{Original User Comment / Key Info} && {Tag1}; {Tag2}; {Tag3}`

**Example:**
`3A - Energy 5 && Uplifting; Female Vocals; Atmospheric`

### Rationale
- **Compatibility:** Comment field is universally readable by iTunes/Apple Music, Rekordbox, Serato, Traktop, and Finder.
- **Data Preservation:** The "Left Side" of the delimiter (` && `) preserves existing metadata from tools like Mixed In Key or user notes.
- **Searchability:** Fully searchable in Apple Music and CDJs.
- **Safety:** Separating machine-managed tags from user comments prevents accidental data loss.

### Processing Logic
1. **Read:** Parse the Comment field. Split by ` && `.
2. **Write:**
   - Preserve text *before* ` && ` (or the whole text if no delimiter exists).
   - Overwrite text *after* ` && ` with the current set of active tags.


---

## Tag Normalization Rules (CDJ-safe)

### Allowed
- Letters, numbers, spaces
- Title Case or Sentence Case (choose one globally)
- Multi-word phrases

### Normalization applied by app
- Trim leading/trailing whitespace
- Collapse internal whitespace to single spaces
- Case normalization (e.g. `female vocals` → `Female Vocals`)
- Exact-match de-duplication

### Explicitly forbidden
- Underscores
- Hyphens as word replacements
- Brackets
- Hashes
- User-editable raw strings

---

## Core Features

### 1. Apple Music Playlist Ingestion
- User selects Apple Music / iTunes Library XML
- App parses:
  - playlists
  - track order
  - file locations
- Streaming / DRM tracks are ignored

**Acceptance Criteria**
- Playlist order matches Apple Music
- Track counts match
- Missing files are flagged, not fatal

---

### 2. Audio Playback
- Local file playback only
- No Apple Music scripting required
- Keyboard-first controls:
  - Play / pause
  - Next / previous
  - Skip ±N seconds

**Acceptance Criteria**
- Instant playback (<200ms on SSD)
- Scrubbing works
- No crashes across MP3, AIFF, AAC, ALAC

---

### 3. Tag Pills (Primary Interaction)
- Tags displayed as **pills**
- Clicking a pill:
  - adds it if absent
  - removes it if present
- Text input:
  - autocomplete from existing tags
  - creates new tag if not found
- Pills always reflect **current effective state**

**Rules**
- No duplicate pills
- No raw string editing
- All changes go through normalization

---

### 4. Frequency-Weighted Tag Cloud
**Purpose:** speed, not decoration

- Tag size scales with usage count
- Frequently used tags are easier to click
- Sources:
  - global library usage
  - current playlist usage
  - recent session usage

**Behavior**
- Clicking a tag toggles it on the current track
- Hover shows usage count
- Optional filter/search for long lists

**Acceptance Criteria**
- Cloud updates live as tags are applied
- Large libraries remain performant

---

### 5. Metadata Write Pipeline (Safety-First)

**On Save**
1. Read current file metadata
2. Compute tag diff
3. Write updated Comment string
4. Re-read file to verify
5. Store undo snapshot

**Undo**
- Session-level undo (per track)
- Stores previous Comment string

**Acceptance Criteria**
- No partial writes
- No corruption
- Verification failure halts write and warns user

---

### 6. Batch Tagging
- Multi-select tracks
- Apply/remove tags across selection
- Preview effective Comment string per track

**Acceptance Criteria**
- Batch operations are atomic per track
- Partial success clearly reported

---

## Format Support (Required)
- MP3 (ID3)
- AIFF (ID3 chunks)
- AAC / ALAC (.m4a)

**Risk Note**
AIFF Comment behavior has been validated against Apple Music + Rekordbox.
Grouping is secondary and less reliable in some older players.

---

## Data Model (SQLite)

### Tracks
- id
- file_path
- mtime
- size
- artist
- title
- album
- comment_raw
- grouping_raw (backup)
- duration
- format

### Playlists
- id
- name

### PlaylistTracks
- playlist_id
- track_id
- position

### Tags (derived)
- tag
- usage_count

---

## Performance Targets
- Library size: 100k tracks
- Search/filter latency: <100ms
- Tag application: <1s per track
- Throughput goal: **300+ tracks/hour**

---

# Build Plan (Agent-Ready)

## Phase 0 — Risk Burn-Down (MANDATORY)
**Goal:** verify AIFF + Comment interoperability

Tasks:
- [x] Write Comment to MP3 → verify Apple Music + Rekordbox
- [x] Write Comment to AIFF → verify both
- [x] Document edge cases (SyncStrategy.md)

Exit Criteria:
- Clear confirmation or fallback decision

---

## Phase 1 — Core Engine
- Library XML parser
- File resolver
- SQLite index
- Metadata read/write wrapper (TagLib)

(No UI polish)

---

## Phase 2 — Playback + Basic UI
- Playlist list
- Track list
- Player
- Tag pills (manual entry)
- Safe write + verify

---

## Phase 3 — Tag Cloud + Workflow Speed
- Frequency-weighted tag cloud
- Autocomplete
- Batch tagging
- Keyboard shortcuts
- Undo

---

## Phase 4 — Hardening
- Incremental rescans
- Missing file handling
- Preferences (field choice, casing)
- Large-library stress tests

---

## Explicit Non-Goals
- Artwork
- Lyrics
- Streaming content
- iOS support
- Apple Music database writes

---

## Definition of Success
A DJ can:
- Open a playlist
- Listen → click tags → next track
- Export to Rekordbox
- Type **“Female Vocals”** on a CDJ and get the right tracks

No hacks. No re-tagging later.
