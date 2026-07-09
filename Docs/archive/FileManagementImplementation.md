> **📦 Archived — historical / superseded.** Pre-implementation code-dump for file management. The shipped code diverged substantially; use the source and reference/LibraryStrategy.md instead.
>
> For current behavior see the [CHANGELOG](../CHANGELOG.md), the [README](../../README.md), and the live docs in [Docs/reference/](../reference/). Kept for provenance; do not treat as an accurate description of the shipped app.

# File Management Implementation Guide

## Architecture Overview

This document details the technical implementation of TagDeck's file management system, including drag-and-drop import, iTunes-style organization, and library consolidation.

---

## 1. Rust Backend Implementation

### 1.1 New Module: `file_manager.rs`

```rust
// src-tauri/src/file_manager.rs

use std::path::{Path, PathBuf};
use std::fs;
use anyhow::{Result, Context, bail};
use serde::{Serialize, Deserialize};
use crate::metadata;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ImportMode {
    Copy,     // Copy files to library, keep originals
    Move,     // Move files to library, delete originals
    InPlace,  // Reference in place, don't move
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LibraryConfig {
    pub root_path: PathBuf,
    pub import_mode: ImportMode,
    pub organize_files: bool,  // Enable artist/album folder structure
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub success: bool,
    pub original_path: String,
    pub new_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ImportSummary {
    pub total: usize,
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub results: Vec<ImportResult>,
}

impl LibraryConfig {
    pub fn load(db: &crate::db::Database) -> Result<Self> {
        // Load from database or use defaults
        let root_path = db.get_config("library_root")?
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_default()
                    .join("Music")
                    .join("TagDeck")
                    .to_string_lossy()
                    .to_string()
            });
        
        let import_mode = match db.get_config("import_mode")?.as_deref() {
            Some("move") => ImportMode::Move,
            Some("in_place") => ImportMode::InPlace,
            _ => ImportMode::Copy,
        };
        
        let organize_files = db.get_config("organize_files")?
            .map(|v| v == "true")
            .unwrap_or(true);
        
        Ok(LibraryConfig {
            root_path: PathBuf::from(root_path),
            import_mode,
            organize_files,
        })
    }
    
    pub fn save(&self, db: &crate::db::Database) -> Result<()> {
        db.set_config("library_root", &self.root_path.to_string_lossy())?;
        db.set_config("import_mode", match self.import_mode {
            ImportMode::Copy => "copy",
            ImportMode::Move => "move",
            ImportMode::InPlace => "in_place",
        })?;
        db.set_config("organize_files", if self.organize_files { "true" } else { "false" })?;
        Ok(())
    }
}

/// Sanitize filename by removing/replacing unsafe characters
pub fn sanitize_filename(name: &str) -> String {
    let mut result = String::with_capacity(name.len());
    
    for c in name.chars() {
        match c {
            '/' | '\\' | ':' | '?' | '*' | '"' | '<' | '>' | '|' => {
                result.push('-');
            }
            '\0' => {
                // Skip null bytes entirely
            }
            _ if c.is_control() => {
                // Skip other control characters
            }
            _ => {
                result.push(c);
            }
        }
    }
    
    // Trim and ensure not empty
    let trimmed = result.trim();
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Generate organized path based on metadata
/// Returns: ~/Music/TagDeck/Artist/Album/01 Title.ext
pub fn generate_organized_path(
    library_root: &Path,
    artist: Option<&str>,
    album: Option<&str>,
    title: Option<&str>,
    track_number: Option<i32>,
    original_filename: &str,
    is_compilation: bool,
) -> Result<PathBuf> {
    let extension = Path::new(original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");
    
    // Determine artist folder
    let artist_name = if is_compilation {
        "Compilations"
    } else {
        artist.unwrap_or("Unknown Artist")
    };
    let artist_folder = sanitize_filename(artist_name);
    
    // Determine album folder
    let album_name = album.unwrap_or("Unknown Album");
    let album_folder = sanitize_filename(album_name);
    
    // Build filename
    let title_part = title
        .map(|t| sanitize_filename(t))
        .unwrap_or_else(|| {
            Path::new(original_filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown")
                .to_string()
        });
    
    let filename = if let Some(num) = track_number {
        // If compilation, include artist in filename
        if is_compilation && artist.is_some() {
            format!("{:02} {} - {}.{}", num, sanitize_filename(artist.unwrap()), title_part, extension)
        } else {
            format!("{:02} {}.{}", num, title_part, extension)
        }
    } else {
        // If compilation without track number, still include artist
        if is_compilation && artist.is_some() {
            format!("{} - {}.{}", sanitize_filename(artist.unwrap()), title_part, extension)
        } else {
            format!("{}.{}", title_part, extension)
        }
    };
    
    let mut path = library_root.join(artist_folder).join(album_folder).join(filename);
    
    // Handle collisions
    if path.exists() {
        let stem = path.file_stem().unwrap().to_string_lossy();
        let mut counter = 2;
        loop {
            let new_filename = format!("{} {}.{}", stem, counter, extension);
            path = path.parent().unwrap().join(new_filename);
            if !path.exists() {
                break;
            }
            counter += 1;
            if counter > 1000 {
                bail!("Too many filename collisions");
            }
        }
    }
    
    Ok(path)
}

/// Import a single file to the library
pub fn import_file(
    source_path: &Path,
    config: &LibraryConfig,
    track_metadata: Option<&crate::models::TrackMetadata>,
) -> Result<PathBuf> {
    // Validate source exists and is a file
    if !source_path.exists() {
        bail!("Source file does not exist");
    }
    if !source_path.is_file() {
        bail!("Source is not a file");
    }
    
    let destination = if config.organize_files {
        // Read metadata if not provided
        let metadata = if let Some(meta) = track_metadata {
            meta.clone()
        } else {
            metadata::read_metadata(source_path)?
        };
        
        generate_organized_path(
            &config.root_path,
            metadata.artist.as_deref(),
            metadata.album.as_deref(),
            metadata.title.as_deref(),
            metadata.track_number,
            source_path.file_name().unwrap().to_str().unwrap(),
            metadata.is_compilation,
        )?
    } else {
        // Flat structure
        config.root_path.join(source_path.file_name().unwrap())
    };
    
    // Ensure parent directory exists
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .context("Failed to create destination directory")?;
    }
    
    // Copy or move based on config
    match config.import_mode {
        ImportMode::Copy => {
            fs::copy(source_path, &destination)
                .context("Failed to copy file")?;
        }
        ImportMode::Move => {
            fs::copy(source_path, &destination)
                .context("Failed to copy file")?;
            
            // Verify copy before deleting
            let source_size = fs::metadata(source_path)?.len();
            let dest_size = fs::metadata(&destination)?.len();
            
            if source_size == dest_size {
                fs::remove_file(source_path)
                    .context("Failed to remove source file after move")?;
            } else {
                bail!("File size mismatch after copy, aborting move");
            }
        }
        ImportMode::InPlace => {
            // Just return the source path
            return Ok(source_path.to_path_buf());
        }
    }
    
    Ok(destination)
}

/// Get list of supported audio file extensions
pub fn supported_extensions() -> &'static [&'static str] {
    &["mp3", "m4a", "aiff", "aif", "wav", "flac", "alac"]
}

/// Check if file has supported audio extension
pub fn is_supported_audio_file(path: &Path) -> bool {
    if let Some(ext) = path.extension() {
        if let Some(ext_str) = ext.to_str() {
            return supported_extensions()
                .iter()
                .any(|&e| e.eq_ignore_ascii_case(ext_str));
        }
    }
    false
}
```

### 1.2 Database Changes

```rust
// Add to src-tauri/src/db.rs

// New table for configuration
const CONFIG_TABLE: &str = r#"
    CREATE TABLE IF NOT EXISTS library_config (
        key TEXT PRIMARY KEY,
        value TEXT
    );
"#;

// Add columns to tracks table (in migration)
// ALTER TABLE tracks ADD COLUMN original_path TEXT;
// ALTER TABLE tracks ADD COLUMN import_date INTEGER;
// ALTER TABLE tracks ADD COLUMN file_hash TEXT;

impl Database {
    pub fn get_config(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare("SELECT value FROM library_config WHERE key = ?")?;
        let result = stmt.query_row([key], |row| row.get(0)).optional()?;
        Ok(result)
    }
    
    pub fn set_config(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO library_config (key, value) VALUES (?, ?)",
            params![key, value],
        )?;
        Ok(())
    }
    
    pub fn insert_imported_track(
        &self,
        track: &crate::models::Track,
        original_path: Option<&str>,
        file_hash: Option<&str>,
    ) -> Result<i64> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;
        
        self.conn.execute(
            "INSERT INTO tracks (
                file_path, artist, title, album, comment_raw, grouping_raw,
                duration_secs, format, size_bytes, bit_rate, rating, bpm,
                original_path, import_date, file_hash, date_added
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                track.file_path, track.artist, track.title, track.album,
                track.comment_raw, track.grouping_raw, track.duration_secs,
                track.format, track.size_bytes, track.bit_rate, track.rating,
                track.bpm, original_path, now, file_hash, now
            ],
        )?;
        
        Ok(self.conn.last_insert_rowid())
    }
    
    pub fn find_duplicate_by_path(&self, file_path: &str) -> Result<Option<crate::models::Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM tracks WHERE file_path = ? OR original_path = ? LIMIT 1"
        )?;
        
        let result = stmt.query_row(params![file_path, file_path], |row| {
            // Parse row into Track
            Ok(crate::models::Track {
                id: row.get(0)?,
                persistent_id: row.get(1).ok(),
                file_path: row.get(2)?,
                artist: row.get(3)?,
                title: row.get(4)?,
                album: row.get(5)?,
                // ... other fields
            })
        }).optional()?;
        
        Ok(result)
    }
}
```

### 1.3 Tauri Commands

```rust
// Add to src-tauri/src/commands.rs

use crate::file_manager::{
    LibraryConfig, ImportMode, ImportResult, ImportSummary,
    import_file, is_supported_audio_file
};

#[tauri::command]
pub async fn get_library_config(state: State<'_, AppState>) -> Result<LibraryConfig, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    LibraryConfig::load(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_library_config(
    config: LibraryConfig,
    state: State<'_, AppState>
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    config.save(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_files(
    app: tauri::AppHandle,
    file_paths: Vec<String>,
    target_playlist_id: Option<i64>,
    state: State<'_, AppState>,
) -> Result<ImportSummary, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    let config = LibraryConfig::load(&db).map_err(|e| e.to_string())?;
    drop(db); // Release lock for parallel processing
    
    let mut results = Vec::new();
    let mut imported_track_ids = Vec::new();
    
    for path_str in &file_paths {
        let path = std::path::Path::new(path_str);
        
        // Validate file
        if !is_supported_audio_file(path) {
            results.push(ImportResult {
                success: false,
                original_path: path_str.clone(),
                new_path: None,
                error: Some("Unsupported file format".to_string()),
            });
            continue;
        }
        
        // Check for duplicate
        let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
        if let Some(_existing) = db.find_duplicate_by_path(path_str)
            .map_err(|e| e.to_string())? {
            results.push(ImportResult {
                success: false,
                original_path: path_str.clone(),
                new_path: None,
                error: Some("Duplicate file".to_string()),
            });
            drop(db);
            continue;
        }
        drop(db);
        
        // Read metadata
        let metadata = match crate::metadata::read_metadata(path) {
            Ok(m) => m,
            Err(e) => {
                results.push(ImportResult {
                    success: false,
                    original_path: path_str.clone(),
                    new_path: None,
                    error: Some(format!("Failed to read metadata: {}", e)),
                });
                continue;
            }
        };
        
        // Import file
        let new_path = match import_file(path, &config, Some(&metadata)) {
            Ok(p) => p,
            Err(e) => {
                results.push(ImportResult {
                    success: false,
                    original_path: path_str.clone(),
                    new_path: None,
                    error: Some(format!("Import failed: {}", e)),
                });
                continue;
            }
        };
        
        // Create track in database
        let track = crate::models::Track {
            id: 0, // Will be set by DB
            persistent_id: None,
            file_path: new_path.to_string_lossy().to_string(),
            artist: metadata.artist.clone(),
            title: metadata.title.clone(),
            album: metadata.album.clone(),
            comment_raw: metadata.comment.clone(),
            grouping_raw: metadata.grouping.clone(),
            duration_secs: metadata.duration_secs,
            format: Some(new_path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("unknown")
                .to_string()),
            size_bytes: std::fs::metadata(&new_path)
                .map(|m| m.len() as i64)
                .unwrap_or(0),
            bit_rate: metadata.bit_rate,
            rating: metadata.rating.unwrap_or(0),
            bpm: metadata.bpm.unwrap_or(0),
            // ... other fields
        };
        
        let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
        let track_id = db.insert_imported_track(&track, Some(path_str), None)
            .map_err(|e| e.to_string())?;
        drop(db);
        
        imported_track_ids.push(track_id);
        
        results.push(ImportResult {
            success: true,
            original_path: path_str.clone(),
            new_path: Some(new_path.to_string_lossy().to_string()),
            error: None,
        });
        
        // Log success
        app.state::<crate::logging::LogState>().add_log(
            "INFO",
            &format!("Imported: {}", path_str),
            &app
        );
    }
    
    // Add to playlist if specified
    if let Some(playlist_id) = target_playlist_id {
        let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
        for track_id in imported_track_ids {
            let _ = db.add_track_to_playlist(playlist_id, track_id);
        }
    }
    
    let imported = results.iter().filter(|r| r.success).count();
    let failed = results.iter().filter(|r| !r.success && r.error.as_ref().map(|e| !e.contains("Duplicate")).unwrap_or(false)).count();
    let skipped = results.len() - imported - failed;
    
    Ok(ImportSummary {
        total: results.len(),
        imported,
        skipped,
        failed,
        results,
    })
}

#[tauri::command]
pub async fn check_duplicate(
    file_path: String,
    state: State<'_, AppState>
) -> Result<Option<Track>, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    db.find_duplicate_by_path(&file_path).map_err(|e| e.to_string())
}
```

---

## 2. Frontend Implementation

### 2.1 Import Drop Zone Component

```tsx
// src/components/ImportDropZone.tsx

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './ImportDropZone.css';

interface ImportSummary {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  results: Array<{
    success: boolean;
    original_path: string;
    new_path?: string;
    error?: string;
  }>;
}

export function ImportDropZone({ onImportComplete }: { onImportComplete?: () => void }) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportSummary | null>(null);

  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      setIsDragOver(true);
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (!e.dataTransfer) return;

      // Get file paths from drag data
      const files = Array.from(e.dataTransfer.files);
      const paths = files.map(f => (f as any).path).filter(Boolean);

      if (paths.length === 0) return;

      setIsImporting(true);
      try {
        const summary = await invoke<ImportSummary>('import_files', {
          filePaths: paths,
          targetPlaylistId: null,
        });
        
        setImportProgress(summary);
        
        if (onImportComplete) {
          onImportComplete();
        }
        
        // Auto-hide after 3 seconds if all successful
        if (summary.failed === 0 && summary.skipped === 0) {
          setTimeout(() => {
            setImportProgress(null);
            setIsImporting(false);
          }, 3000);
        }
      } catch (err) {
        console.error('Import failed:', err);
        alert(`Import failed: ${err}`);
        setIsImporting(false);
      }
    };

    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', handleDrop);

    return () => {
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('drop', handleDrop);
    };
  }, [onImportComplete]);

  if (!isDragOver && !isImporting) {
    return null;
  }

  return (
    <div className={`import-drop-zone ${isDragOver ? 'drag-over' : ''}`}>
      {isImporting && importProgress ? (
        <div className="import-progress">
          <h2>Import Complete</h2>
          <div className="import-stats">
            <div className="stat success">
              <strong>{importProgress.imported}</strong> imported
            </div>
            {importProgress.skipped > 0 && (
              <div className="stat skipped">
                <strong>{importProgress.skipped}</strong> skipped
              </div>
            )}
            {importProgress.failed > 0 && (
              <div className="stat failed">
                <strong>{importProgress.failed}</strong> failed
              </div>
            )}
          </div>
          
          {importProgress.failed > 0 && (
            <div className="import-errors">
              <h3>Errors:</h3>
              <ul>
                {importProgress.results
                  .filter(r => !r.success && r.error && !r.error.includes('Duplicate'))
                  .map((r, i) => (
                    <li key={i}>
                      <strong>{r.original_path.split('/').pop()}</strong>: {r.error}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          
          <button onClick={() => {
            setImportProgress(null);
            setIsImporting(false);
          }}>
            Close
          </button>
        </div>
      ) : (
        <div className="drop-prompt">
          <div className="drop-icon">📁</div>
          <h2>Drop files to import</h2>
          <p>Supported: MP3, M4A, AIFF, WAV, FLAC</p>
        </div>
      )}
    </div>
  );
}
```

### 2.2 Settings Panel - Library Section

```tsx
// Add to src/components/SettingsPanel.tsx

interface LibraryConfig {
  root_path: string;
  import_mode: 'Copy' | 'Move' | 'InPlace';
  organize_files: boolean;
}

function LibrarySettings() {
  const [config, setConfig] = useState<LibraryConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const cfg = await invoke<LibraryConfig>('get_library_config');
      setConfig(cfg);
    } catch (err) {
      console.error('Failed to load library config:', err);
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async (updates: Partial<LibraryConfig>) => {
    if (!config) return;
    
    const newConfig = { ...config, ...updates };
    try {
      await invoke('set_library_config', { config: newConfig });
      setConfig(newConfig);
    } catch (err) {
      console.error('Failed to save config:', err);
      alert(`Failed to save: ${err}`);
    }
  };

  const chooseFolder = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Choose Library Folder',
    });
    
    if (selected) {
      saveConfig({ root_path: selected as string });
    }
  };

  if (loading || !config) {
    return <div>Loading...</div>;
  }

  return (
    <div className="settings-section library-settings">
      <h3>Library Management</h3>
      
      <div className="setting-row">
        <label>Library Location:</label>
        <div className="folder-picker">
          <input
            type="text"
            value={config.root_path}
            readOnly
          />
          <button onClick={chooseFolder}>Choose...</button>
        </div>
      </div>

      <div className="setting-row">
        <label>When importing files:</label>
        <div className="radio-group">
          <label>
            <input
              type="radio"
              name="import-mode"
              checked={config.import_mode === 'Copy'}
              onChange={() => saveConfig({ import_mode: 'Copy' })}
            />
            Copy to library (recommended)
          </label>
          <label>
            <input
              type="radio"
              name="import-mode"
              checked={config.import_mode === 'Move'}
              onChange={() => saveConfig({ import_mode: 'Move' })}
            />
            Move to library
          </label>
          <label>
            <input
              type="radio"
              name="import-mode"
              checked={config.import_mode === 'InPlace'}
              onChange={() => saveConfig({ import_mode: 'InPlace' })}
            />
            Keep files in place (advanced)
          </label>
        </div>
      </div>

      <div className="setting-row">
        <label>
          <input
            type="checkbox"
            checked={config.organize_files}
            onChange={(e) => saveConfig({ organize_files: e.target.checked })}
          />
          Organize files by artist and album
        </label>
      </div>

      <div className="setting-row">
        <button className="consolidate-button" disabled>
          Consolidate Library...
        </button>
        <p className="setting-description">
          Organize all existing files in library (coming soon)
        </p>
      </div>
    </div>
  );
}
```

### 2.3 Playlist Drop Target

```tsx
// Modify src/components/Sidebar.tsx to handle drops on playlists

function PlaylistItem({ playlist }: { playlist: Playlist }) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    const paths = files.map(f => (f as any).path).filter(Boolean);

    if (paths.length === 0) return;

    try {
      const summary = await invoke<ImportSummary>('import_files', {
        filePaths: paths,
        targetPlaylistId: playlist.id,
      });
      
      alert(`Added ${summary.imported} tracks to ${playlist.name}`);
      
      // Refresh playlist
      // ... trigger refresh
    } catch (err) {
      console.error('Import to playlist failed:', err);
      alert(`Failed: ${err}`);
    }
  };

  return (
    <div
      className={`playlist-item ${isDragOver ? 'drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {playlist.name}
    </div>
  );
}
```

---

## 3. CSS Styling

```css
/* src/components/ImportDropZone.css */

.import-drop-zone {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.9);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  animation: fadeIn 0.2s ease-in-out;
}

.import-drop-zone.drag-over {
  background: rgba(37, 99, 235, 0.2);
  border: 4px dashed var(--accent-color);
}

.drop-prompt {
  text-align: center;
  color: white;
  user-select: none;
}

.drop-icon {
  font-size: 80px;
  margin-bottom: 20px;
  animation: bounce 1s ease-in-out infinite;
}

.drop-prompt h2 {
  font-size: 32px;
  margin-bottom: 10px;
}

.drop-prompt p {
  font-size: 16px;
  opacity: 0.7;
}

.import-progress {
  background: var(--panel-bg);
  border-radius: 12px;
  padding: 30px;
  max-width: 500px;
  width: 90%;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.import-stats {
  display: flex;
  gap: 20px;
  justify-content: center;
  margin: 20px 0;
}

.stat {
  text-align: center;
}

.stat strong {
  display: block;
  font-size: 32px;
  margin-bottom: 5px;
}

.stat.success strong {
  color: #10b981;
}

.stat.skipped strong {
  color: #f59e0b;
}

.stat.failed strong {
  color: #ef4444;
}

.import-errors {
  margin-top: 20px;
  padding: 15px;
  background: rgba(239, 68, 68, 0.1);
  border-radius: 8px;
  max-height: 200px;
  overflow-y: auto;
}

.import-errors ul {
  list-style: none;
  padding: 0;
  margin: 10px 0 0 0;
}

.import-errors li {
  padding: 5px 0;
  font-size: 14px;
  color: #ef4444;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-20px); }
}

/* Playlist drop target styling */
.playlist-item.drag-over {
  background: rgba(37, 99, 235, 0.2);
  border-left: 4px solid var(--accent-color);
}
```

---

## 4. Testing Plan

### Unit Tests
- `sanitize_filename()` with edge cases
- `generate_organized_path()` with various metadata combinations
- Duplicate detection logic
- File collision handling

### Integration Tests
- Import single file (copy mode)
- Import single file (move mode)
- Import folder with 10+ files
- Import to playlist
- Duplicate skip behavior
- Permission error handling

### Manual Testing Checklist
- [ ] Drag MP3 file → imports successfully
- [ ] Drag AIFF file → imports successfully
- [ ] Drag unsupported file → shows error
- [ ] Drag duplicate → skips with message
- [ ] Drag onto playlist → adds to playlist
- [ ] File organized as Artist/Album/Track
- [ ] Special characters in metadata handled
- [ ] Missing metadata uses fallbacks
- [ ] Settings persist across app restart
- [ ] Consolidate library (phase 4)

---

## 5. Migration & Rollout

### Phase 1: Basic Import (Week 1-2)
- Implement file_manager.rs core functions
- Add Tauri commands
- Build basic drop zone UI
- Flat file structure only
- Copy mode only

### Phase 2: Organization (Week 3)
- Implement iTunes-style folder structure
- Add artist/album/track hierarchy
- Filename sanitization
- Collision detection

### Phase 3: Settings & Config (Week 4)
- Settings panel UI
- Library location picker
- Copy/Move/In-place modes
- Persist configuration

### Phase 4: Playlist Integration (Week 5)
- Drop onto playlist
- Batch import optimizations
- Progress reporting
- Error recovery

### Phase 5: Polish (Week 6)
- Consolidate library feature
- Advanced duplicate detection
- Import history/undo
- Performance optimization

---

## 6. Performance Considerations

- **Batch Processing:** Process files in chunks of 50
- **Async Operations:** Use Tokio for parallel file I/O
- **Progress Streaming:** Use Tauri events to stream progress
- **Database Transactions:** Batch inserts in single transaction
- **Memory Management:** Stream large files, don't load entirely

---

## 7. Error Handling

### User-Facing Errors
- "File not found"
- "Unsupported format"
- "Permission denied"
- "Duplicate file"
- "Disk full"

### Recovery Strategies
- Retry transient errors (3 attempts)
- Skip and continue for batch imports
- Preserve original files until verified
- Log all errors for support

---

## Success Criteria

✅ User can drag 100 MP3 files and have them organized in < 30 seconds  
✅ No data loss or corruption during import  
✅ File organization matches iTunes structure exactly  
✅ All metadata preserved and readable  
✅ Graceful error handling with user feedback  
✅ Settings persist across sessions  
✅ Works on both Apple Silicon and Intel Macs  

---

This implementation transforms TagDeck into a fully independent music library manager while maintaining backward compatibility with iTunes libraries.
