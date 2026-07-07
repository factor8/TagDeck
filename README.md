# TagDeck

**TagDeck** is a high-performance local music library manager and tagging tool for macOS, built for DJs, audiophiles, and power users. It helps you organize, search, and tag your collection with a fast, keyboard-centric workflow — and writes your tags directly into the audio files so they travel with your music.

100% vibe coded by Gemini 3.

## Features

### Tagging

- **The Tag Deck:** A specialized panel for rapid-fire tagging with keyboard shortcuts, frequency-weighted tag ordering, and click-to-add workflows.
- **Tag Editor:** Pill-based editing sidebar with autocomplete, auto-save, and batch tagging across multi-selected tracks.
- **CDJ-safe metadata writes:** Tags are written to each file's Comment field as `{Original Comment} && {Tag1}; {Tag2}`, preserving Mixed In Key results and existing notes. Every write is verified by re-reading the file.
- **Tag groups**, global **undo/redo** for tag and playlist edits, and iTunes-style **star ratings** with half-star precision.

### Apple Music / iTunes Sync

- **Library import:** Ingests your Apple Music (iTunes) library — playlists, folder structure, track order, and ratings — via a native Swift bridge.
- **Real-time monitoring:** Watches the Music.app database and picks up edits within seconds using efficient delta queries.
- **Sync modes:** Off, Import-only, or full Two-way sync with per-playlist toggles.
- **Sync Review:** Preview and approve added/removed/changed tracks before anything is applied, with conflict detection when a track was edited on both sides.
- **Safe deletions:** Tracks removed from Music.app are never silently deleted — keep them as "unlinked" (tags and playlist memberships intact, relinked automatically if they return) or choose per-case.

### Playback

- **Built-in player** with instant streaming start, plus an optional **waveform view** (WaveSurfer) that renders progressively during playback.
- **Play queue:** Play Next / Play Later (`Q` / `⇧Q` or right-click), a Queue tab with drag-reorder, remove, jump, and clear — and the queue survives restarts.
- Space to play/pause anywhere, `←`/`→` for previous/next, elapsed/remaining time toggle.

### Search

- **Query syntax:** Implicit AND, quoted phrases, `-` negation, field filters (`artist:`, `title:`, `album:`, `genre:`, `label:`, `tag:`, `key:`), and numeric ranges like `bpm:120-130` or `bpm:>120`. Built-in search help panel.
- **BPM tap counter** right in the search bar.
- **Playlist search:** Sidebar filter plus a `⌘K` fuzzy quick-switcher with folder breadcrumbs.

### Playlists & File Management

- Playlist tree with folders, drag-and-drop reordering, bulk membership copying, and versioned **backup/restore** to JSON.
- **Standalone file import** with drag-and-drop and SHA-256 duplicate detection — no iTunes required.
- **Library folder watching:** Externally deleted files are flagged missing, moved files are auto-relocated, and reappearing files are restored.
- **Consolidate Library** copies externally stored tracks into your library folder (originals are never deleted).

### Spotify Integration

- Import selected Spotify playlists and **tag tracks before you own the files**; tags auto-merge into the local file once you buy the track (with a match review step — nothing merges without your confirmation).
- In-app playback via Spotify Connect (Premium required), library matching, `⌘L` link-to-local-track, and Open in Spotify.
- OAuth tokens stored securely in the macOS Keychain.

### Export & Interop

- **Rekordbox export:** Full library and playlist tree to `rekordbox.xml`, including BPM, ratings, and comments/tags.
- **M3U8 export** for individual playlists.
- **⌥-drag files out** of TagDeck straight into Finder, Mail, or Rekordbox.
- **Mixed In Key:** Right-click to analyze tracks (single or batch) with Mixed In Key 8 and pull the key/BPM results back in.

### UI & Power-User Details

- Virtualized track list that stays smooth on large libraries, with column reorder/resize/visibility, inline editing, and multi-select.
- Tabbed Settings (General, iTunes, Library, Export, Appearance, Spotify, Developer) with themes and custom accent colors.
- Extensive keyboard shortcuts — see [Docs/KeyCommands.md](Docs/KeyCommands.md).
- Persistent rotating logs, a searchable Logs window (`⌘⌥L`), and a Debug Mode for troubleshooting.

## Tech Stack

- **Backend:** [Tauri v2](https://v2.tauri.app/) (Rust) — [lofty](https://github.com/Serial-ATA/lofty-rs) for metadata read/write, SQLite (rusqlite), `notify` for file watching, plus a native Swift sidecar bridging to Music.app via AppleScript.
- **Frontend:** [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/), built with [Vite](https://vitejs.dev/).
- **Key libraries:** [TanStack Table](https://tanstack.com/table/v8) + Virtual, [dnd-kit](https://dndkit.com/), [wavesurfer.js](https://wavesurfer.xyz/), [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels), [Lucide React](https://lucide.dev/).

**Supported formats:** MP3, M4A/ALAC, AIFF, WAV, FLAC.

**Platform:** macOS. The iTunes bridge, Keychain storage, and Mixed In Key automation are macOS-specific.

## Getting Started

### Prerequisites

- **macOS** with Xcode command-line tools (the Swift sidecar is compiled during the build)
- **Node.js** (v18 or newer)
- **Rust & Cargo** (latest stable)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/factor8/TagDeck.git
   cd TagDeck
   ```

2. **Install frontend dependencies:**
   ```bash
   npm install
   ```

3. **Run the development server:**
   ```bash
   npm run tauri dev
   ```
   This launches the Tauri window with hot-module replacement enabled.

### Tests

Rust unit tests cover the sync, export, and metadata layers:

```bash
cd src-tauri && cargo test
```

A manual QA checklist lives in [Docs/TestPlan.md](Docs/TestPlan.md).

## Building for Production

```bash
npm run tauri build
```

Output binaries land in `src-tauri/target/release/bundle/`.

## Documentation

The [Docs/](Docs/) folder contains the PRD, changelog, search syntax reference, keyboard shortcuts, and design docs for major subsystems (sync strategy, file management, Spotify integration, and more).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[MIT](LICENSE)
