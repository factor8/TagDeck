# TagDeck

**TagDeck** is a high-performance local music library manager and tagging tool built for DJs, audiophiles, and power users. Designed for speed and efficiency, it helps you organize, search, and tag your music collection with a modern, keyboard-centric workflow.

## ✨ Features

- **🚀 High Performance:** Built with [Tauri](https://tauri.app/) and Rust for native speed and low memory usage.
- **🏷️ The Tag Deck:** A specialized interface for rapid-fire tagging of tracks using keyboard shortcuts and click-to-add workflows.
- **🔍 Advanced Search:** Multi-term fuzzy search capability that scans across Artist, Title, Album, Comments, and Tags simultaneously.
- **📊 Powerful Track List:**
  - Virtualized scrolling for large libraries.
  - Drag-and-drop column reordering.
  - Custom column visibility and resizing.
  - Sort by any field.
- **🎧 Built-in Player:** Instant playback of local audio files (MP3, AIFF, WAV, M4A) with a persistent footer player.
- **📂 Playlist Management:** View and navigate your library folder structure and playlists.
- **🎨 Modern UI:** Clean, dark-themed interface with resizable panels and smooth animations.

## 🛠️ Tech Stack

- **Backend:** [Tauri v2](https://v2.tauri.app/) (Rust)
- **Frontend:** [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **Build Tool:** [Vite](https://vitejs.dev/)
- **State/UI:** 
  - [TanStack Table](https://tanstack.com/table/v8) - Data Grid
  - [dnd-kit](https://dndkit.com/) - Drag and Drop
  - [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) - Layout
  - [Lucide React](https://lucide.dev/) - Icons

## 🚀 Getting Started

### Prerequisites

- **Node.js** (v18 or newer recommended)
- **Rust & Cargo** (Latest stable)

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
   This will launch the Tauri window with hot-module replacement enabled.

## 📦 Building for Production

To create an optimized production build/executable:

```bash
npm run tauri build
```
The output binaries will be located in `src-tauri/target/release/bundle/`.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

[MIT](LICENSE)
