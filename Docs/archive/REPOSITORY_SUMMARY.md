# Repository Analysis: TagDeck

## Overview

TagDeck is a high-performance macOS desktop application designed for music library management with a specialized focus on DJ workflows. Built with Tauri 2 and React 19, it bridges the gap between Apple Music/iTunes library management and professional DJ software (Rekordbox, Serato) by providing a fast, keyboard-centric interface for tagging and organizing local audio files. The application writes tags directly to audio file metadata, ensuring compatibility across DJ hardware (Pioneer CDJs) and software platforms.

**Project Genesis:** January 30, 2026  
**Development Intensity:** 149 commits in 10 days (100% within last year)  
**Primary Author:** Jordan Layman (solo project)  
**Current Version:** 0.1.2  
**Tagline:** "100% vibe coded by Gemini 3"

## Architecture

TagDeck follows a modern desktop application architecture using the Tauri framework, which provides a Rust backend with a web-based frontend UI:

### Backend (Rust)
- **Tauri 2.x Core:** Manages the native desktop application lifecycle, system integration, and security
- **SQLite Database:** Local storage for track metadata, playlists, and application state
- **Audio Metadata:** Lofty library for reading/writing ID3 tags to audio files
- **Apple Music Integration:** Native Swift binary (`FetchLibrary`) communicates with Music.app via AppleScript
- **File System Watching:** Real-time monitoring of Apple Music library changes using the `notify` crate
- **Command Pattern:** Strict separation between frontend and backend via Tauri command handlers

### Frontend (React + TypeScript)
- **React 19:** Latest React with modern hooks and concurrent features
- **Vite:** Lightning-fast build tool and dev server with HMR
- **TanStack Table v8:** Advanced data grid with virtualization, sorting, filtering, and column management
- **dnd-kit:** Drag-and-drop functionality for playlist management and UI reordering
- **WaveSurfer.js:** Audio waveform visualization and playback control
- **Lucide React:** Consistent icon system
- **react-resizable-panels:** Flexible panel-based layout system

### Data Flow

```
Apple Music/iTunes
    ↓ (Library XML / AppleScript)
FetchLibrary (Swift) → Commands (Rust)
    ↓
SQLite Database (Rust)
    ↓ (Tauri Commands)
React Frontend (TypeScript)
    ↓ (User Edits)
Metadata Writer (Rust/Lofty)
    ↓
Audio Files (ID3 Tags)
```

**Key Flow Patterns:**
1. **Library Import:** User triggers import → Swift FetchLibrary queries Music.app → Rust parser processes data → SQLite storage
2. **Real-Time Sync:** notify watcher detects library changes → debounced sync trigger → AppleScript delta query → update only changed tracks
3. **Tag Editing:** User modifies tags in UI → immediate save to SQLite → write to audio file Comment field using format: `{Original Comment} && {Tag1}; {Tag2}; {Tag3}`
4. **Playback:** User selects track → load audio file → decode via Web Audio API or fallback to MediaElement → WaveSurfer visualization

## Key Components

### Backend Components (Rust)

- **commands.rs (34 changes):** Central command hub exposing ~30+ Tauri commands for frontend-backend communication. Handles track queries, tag operations, playlist management, and system operations.

- **db.rs (24 changes):** SQLite database abstraction layer with schema management, queries, and migrations. Manages tracks, playlists, tags, tag groups, and application state.

- **apple_music.rs (12 changes):** Apple Music/iTunes integration layer. Orchestrates library imports, playlist parsing, and synchronization logic.

- **library_parser.rs (8 changes):** XML parsing and data transformation from iTunes Library.xml format into internal database schema.

- **library_watcher.rs:** Real-time file system monitoring using the `notify` crate. Watches for changes to Music.app database files and triggers automatic synchronization.

- **metadata.rs (4 changes):** Audio file metadata reading/writing using the Lofty library. Implements the CDJ-safe tag format with delimiter-based comment preservation.

- **system_library.rs (8 changes):** System-level operations for library location detection and file path resolution.

- **undo.rs:** Global undo/redo stack implementation for tag edits and playlist modifications.

- **logging.rs:** Persistent logging infrastructure writing to `~/Library/Logs/TagDeck/` with automatic rotation.

- **swift/FetchLibrary.swift (6 changes):** Native macOS Swift binary that uses AppleScript to query Music.app for track and playlist data, returning JSON to Rust.

### Frontend Components (React/TypeScript)

- **TrackList.tsx (51 changes):** The heart of the application. Implements the virtualized track table with sorting, filtering, column management, selection state, and inline editing. Most frequently modified file in the repository.

- **App.tsx (45 changes):** Root application component managing global state, layout, keyboard shortcuts, and inter-component communication.

- **Player.tsx (39 changes):** Audio playback engine with dual modes (standard scrub bar / waveform visualization). Handles Web Audio API decoding, fallback playback, and transport controls.

- **TagEditor.tsx (17 changes):** Right sidebar component for tag management. Implements auto-save, tag pill interface, and CDJ-safe tag normalization.

- **TagDeck.tsx (12 changes):** Specialized rapid-tagging interface for bulk tagging workflows.

- **Sidebar.tsx (12 changes):** Left navigation panel showing playlists, folders, and library structure with scroll-to-selected behavior.

- **SettingsPanel.tsx (7 changes):** Application settings including library import controls, playback preferences, logging configuration, and developer tools.

- **MetadataViewer.tsx:** Collapsible technical metadata inspector showing bitrate, format, file path, and other track details.

- **BpmCounter.tsx:** Interactive BPM tap counter integrated into the search bar for live tempo detection.

- **StarRating.tsx:** iTunes-style 5-star rating component with half-star precision.

- **Toast.tsx:** Non-blocking notification system for user feedback.

- **CopyPlaylistsModal.tsx:** Bulk playlist membership copying tool.

- **SearchHelpPanel.tsx:** Context-sensitive help for the advanced search syntax.

- **DebugContext.tsx:** Developer mode context providing debug information and verbose logging.

### Utility Modules

- **searchParser.ts (7 changes):** Advanced search query parser supporting multi-field fuzzy matching, boolean operators, and metadata filters.

- **types.ts:** TypeScript type definitions and interfaces shared across the application.

## Technologies Used

### Languages
- **Rust** (Backend, ~50% of codebase)
- **TypeScript** (Frontend, ~40% of codebase)
- **Swift** (Apple Music integration binary)

### Frameworks & Core Libraries
- **Tauri 2.x** - Desktop application framework
- **React 19** - UI framework
- **Vite 7** - Build tool and dev server

### Rust Dependencies (Backend)
- **rusqlite** - SQLite database interface
- **lofty 0.21** - Audio metadata reading/writing
- **serde/serde_json** - Serialization
- **plist** - Apple property list parsing
- **notify 8.0** - File system watching
- **anyhow/thiserror** - Error handling
- **chrono** - Date/time handling
- **tauri-plugin-dialog** - Native file dialogs
- **tauri-plugin-fs** - File system access
- **tauri-plugin-shell** - Shell command execution
- **tauri-plugin-opener** - Open files/URLs in default apps
- **dirs** - Platform-specific directory paths

### React Dependencies (Frontend)
- **@tanstack/react-table 8.21** - Data grid
- **@tanstack/react-virtual 3.13** - Virtual scrolling
- **@dnd-kit/core** - Drag-and-drop primitives
- **react-resizable-panels** - Panel layout
- **wavesurfer.js 7.12** - Audio waveform visualization
- **lucide-react 0.563** - Icon library

### Development Tools
- **TypeScript 5.8** - Type checking
- **Node.js** (v18+) - Package management
- **Cargo** - Rust build system
- **npm** - JavaScript package manager

### Audio Formats Supported
- MP3 (MPEG Audio)
- AIFF (Audio Interchange File Format)
- WAV (Waveform Audio File Format)
- M4A (MPEG-4 Audio)

## Team and Ownership

**Solo Developer:** Jordan Layman

The repository shows a single-author development pattern with complete ownership across all components:

- **Full Stack:** Equal comfort with Rust backend and React frontend
- **Platform Specialist:** Deep macOS integration knowledge (AppleScript, Swift, system conventions)
- **Audio Domain Expertise:** Understanding of DJ workflows, audio metadata standards, and CDJ compatibility requirements
- **Rapid Iteration:** Average of 14.9 commits per day during active development periods
- **Night Owl Pattern:** Peak commit activity at 11 PM (20 commits), with secondary peaks mid-afternoon (13-16:00)

**Maintenance Philosophy:**
- Conventional commits (feat/fix/chore/docs/style prefixes)
- Frequent small commits over large batches
- Documentation updated alongside code
- No external contributors or pull requests (yet)

## Development Patterns

### Commit Categories
- **Features (feat):** 22 commits (~15%) - New capabilities and user-facing additions
- **Fixes (fix):** 16 commits (~11%) - Bug fixes and issue resolution
- **Refactoring/Chore/Docs/Style:** ~40 commits (~27%) - Code quality and maintenance
- **Unlabeled/Legacy:** ~71 commits (~48%) - Early development and multi-purpose changes

### Stability Evolution
The project has matured from a rapid prototyping phase (66 commits on Feb 1) to more measured feature development with increased focus on polish, bug fixes, and user experience refinement.

### Testing Strategy
- Manual testing via dev environment (`npm run tauri dev`)
- Binary utility `verify_tags` for metadata validation
- No automated test suite visible (early stage project)

## Current State (February 2026)

The project is in **active early development** (v0.1.2), having moved from initial prototype to functional application in just 10 days. Recent focus areas include:

1. **Player Stability:** Multiple commits addressing play/pause race conditions, mode switching crashes, and audio decoding fallbacks
2. **Real-Time Sync:** Mature implementation of automatic library monitoring and incremental updates
3. **Developer Experience:** Comprehensive logging system with rotation, debug mode, and frontend logging integration
4. **Polish Phase:** Transition from core feature building to UX refinement, edge case handling, and stability improvements

The codebase shows signs of preparation for wider use: persistent logging, debug tooling, comprehensive documentation, and increasing attention to error handling and user feedback mechanisms.
