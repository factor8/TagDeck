use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Supported audio file extensions for import.
const SUPPORTED_EXTENSIONS: &[&str] = &["mp3", "m4a", "aiff", "aif", "wav", "flac", "alac"];

/// How imported files should be handled.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ImportMode {
    /// Copy files into the managed library folder, leaving originals untouched.
    Copy,
    /// Move files into the managed library folder (delete originals after verified copy).
    Move,
    /// Add files to the database without relocating them.
    InPlace,
}

/// Relationship with Apple Music / iTunes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SyncMode {
    /// No communication with Music.app in either direction.
    Off,
    /// Pull changes from Music.app; never push TagDeck edits back.
    ImportOnly,
    /// Full bidirectional sync (original TagDeck behavior).
    TwoWay,
}

impl SyncMode {
    /// May we read changes from Music.app (real-time sync, manual sync)?
    pub fn pull_enabled(self) -> bool {
        matches!(self, SyncMode::ImportOnly | SyncMode::TwoWay)
    }

    /// May we write TagDeck edits (tags, ratings, playlists) to Music.app?
    pub fn push_enabled(self) -> bool {
        matches!(self, SyncMode::TwoWay)
    }
}

/// What sync does when a linked track has been removed from Music.app.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum DeletionBehavior {
    /// Don't decide automatically — surface the removals in Sync Review.
    Ask,
    /// Unlink the track but keep it (and its tags/playlists) in TagDeck.
    Keep,
    /// Mirror the deletion: remove the track from TagDeck too.
    Remove,
}

/// Persistent library configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryConfig {
    pub root_path: String,
    pub import_mode: ImportMode,
    pub organize_files: bool,
    pub sync_mode: SyncMode,
    pub itunes_deletion_behavior: DeletionBehavior,
}

/// Result of importing a single file.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportResult {
    pub success: bool,
    pub original_path: String,
    pub new_path: Option<String>,
    pub error: Option<String>,
}

/// Aggregate summary returned after a batch import.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportSummary {
    pub total: usize,
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub results: Vec<ImportResult>,
    /// DB IDs of successfully imported tracks (used by frontend for post-import reorder).
    pub imported_track_ids: Vec<i64>,
}

// ---------------------------------------------------------------------------
// LibraryConfig persistence helpers
// ---------------------------------------------------------------------------

impl LibraryConfig {
    /// Load the library configuration from the database, falling back to sensible
    /// defaults when no values have been stored yet.
    pub fn load(db: &crate::db::Database) -> Result<Self> {
        let root_path = db
            .get_config("library_root")?
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

        let organize_files = db
            .get_config("organize_files")?
            .map(|v| v == "true")
            .unwrap_or(true);

        // Absent key means the startup migration hasn't run; TwoWay matches the
        // app's original always-sync behavior so existing users see no change.
        let sync_mode = match db.get_config("sync_mode")?.as_deref() {
            Some("off") => SyncMode::Off,
            Some("import_only") => SyncMode::ImportOnly,
            _ => SyncMode::TwoWay,
        };

        let itunes_deletion_behavior = match db.get_config("itunes_deletion_behavior")?.as_deref() {
            Some("remove") => DeletionBehavior::Remove,
            Some("keep") => DeletionBehavior::Keep,
            _ => DeletionBehavior::Ask,
        };

        Ok(Self {
            root_path,
            import_mode,
            organize_files,
            sync_mode,
            itunes_deletion_behavior,
        })
    }

    /// Persist the current configuration to the database.
    pub fn save(&self, db: &crate::db::Database) -> Result<()> {
        db.set_config("library_root", &self.root_path)?;
        db.set_config(
            "import_mode",
            match self.import_mode {
                ImportMode::Copy => "copy",
                ImportMode::Move => "move",
                ImportMode::InPlace => "in_place",
            },
        )?;
        db.set_config(
            "organize_files",
            if self.organize_files { "true" } else { "false" },
        )?;
        db.set_config(
            "sync_mode",
            match self.sync_mode {
                SyncMode::Off => "off",
                SyncMode::ImportOnly => "import_only",
                SyncMode::TwoWay => "two_way",
            },
        )?;
        db.set_config(
            "itunes_deletion_behavior",
            match self.itunes_deletion_behavior {
                DeletionBehavior::Ask => "ask",
                DeletionBehavior::Keep => "keep",
                DeletionBehavior::Remove => "remove",
            },
        )?;
        Ok(())
    }

    /// The effective sync mode, read directly from config. Falls back to TwoWay
    /// (original behavior) if config can't be read.
    pub fn sync_mode(db: &crate::db::Database) -> SyncMode {
        db.get_config("sync_mode")
            .ok()
            .flatten()
            .map(|v| match v.as_str() {
                "off" => SyncMode::Off,
                "import_only" => SyncMode::ImportOnly,
                _ => SyncMode::TwoWay,
            })
            .unwrap_or(SyncMode::TwoWay)
    }
}

// ---------------------------------------------------------------------------
// Filename / path helpers
// ---------------------------------------------------------------------------

/// Replace filesystem-unsafe characters with hyphens and strip control chars.
pub fn sanitize_filename(name: &str) -> String {
    let mut result = String::with_capacity(name.len());

    for c in name.chars() {
        match c {
            '/' | '\\' | ':' | '?' | '*' | '"' | '<' | '>' | '|' => result.push('-'),
            '\0' => {}
            _ if c.is_control() => {}
            _ => result.push(c),
        }
    }

    let trimmed = result.trim();
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Build the iTunes-style organised destination path:
///
/// ```text
/// <library_root>/<Artist>/<Album>/<TrackNum Title.ext>
/// ```
///
/// Handles compilations, missing metadata, and filename collisions.
pub fn generate_organized_path(
    library_root: &Path,
    artist: Option<&str>,
    album: Option<&str>,
    title: Option<&str>,
    track_number: Option<u32>,
    original_filename: &str,
    is_compilation: bool,
) -> Result<PathBuf> {
    let extension = Path::new(original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");

    // Artist folder
    let artist_folder = if is_compilation {
        "Compilations".to_string()
    } else {
        sanitize_filename(artist.unwrap_or("Unknown Artist"))
    };

    // Album folder
    let album_folder = sanitize_filename(album.unwrap_or("Unknown Album"));

    // Title component — fall back to original file stem
    let title_part = title
        .map(|t| sanitize_filename(t))
        .unwrap_or_else(|| {
            Path::new(original_filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown")
                .to_string()
        });

    // Build filename
    let filename = match (track_number, is_compilation, artist) {
        (Some(num), true, Some(a)) => {
            format!("{:02} {} - {}.{}", num, sanitize_filename(a), title_part, extension)
        }
        (Some(num), _, _) => {
            format!("{:02} {}.{}", num, title_part, extension)
        }
        (None, true, Some(a)) => {
            format!("{} - {}.{}", sanitize_filename(a), title_part, extension)
        }
        _ => {
            format!("{}.{}", title_part, extension)
        }
    };

    let mut path = library_root
        .join(&artist_folder)
        .join(&album_folder)
        .join(&filename);

    // Handle collisions by appending a counter
    if path.exists() {
        let stem = Path::new(&filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file")
            .to_string();
        let mut counter: u32 = 2;
        loop {
            let new_name = format!("{} {}.{}", stem, counter, extension);
            path = path.parent().unwrap().join(new_name);
            if !path.exists() {
                break;
            }
            counter += 1;
            if counter > 1000 {
                bail!("Too many filename collisions for {}", original_filename);
            }
        }
    }

    Ok(path)
}

// ---------------------------------------------------------------------------
// Core import logic
// ---------------------------------------------------------------------------

/// Metadata extracted from an audio file for organising purposes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackImportMeta {
    pub artist: Option<String>,
    pub title: Option<String>,
    pub album: Option<String>,
    pub track_number: Option<u32>,
    pub duration_secs: f64,
    pub bpm: Option<i64>,
    pub comment: Option<String>,
    pub grouping: Option<String>,
    pub is_compilation: bool,
    pub bit_rate: i64,
}

/// Check whether a path has a supported audio extension.
pub fn is_supported_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            SUPPORTED_EXTENSIONS
                .iter()
                .any(|&e| e.eq_ignore_ascii_case(ext))
        })
        .unwrap_or(false)
}

/// Import a single file into the managed library.
///
/// Returns the final destination path of the file.
pub fn import_file(
    source_path: &Path,
    config: &LibraryConfig,
    meta: &TrackImportMeta,
) -> Result<PathBuf> {
    if !source_path.exists() {
        bail!("Source file does not exist: {}", source_path.display());
    }
    if !source_path.is_file() {
        bail!("Source is not a file: {}", source_path.display());
    }

    // In-place mode: just return the source path unmodified.
    if config.import_mode == ImportMode::InPlace {
        return Ok(source_path.to_path_buf());
    }

    let library_root = Path::new(&config.root_path);

    let destination = if config.organize_files {
        generate_organized_path(
            library_root,
            meta.artist.as_deref(),
            meta.album.as_deref(),
            meta.title.as_deref(),
            meta.track_number,
            source_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file"),
            meta.is_compilation,
        )?
    } else {
        // Flat structure — just put the file at the library root
        let fname = source_path
            .file_name()
            .context("Source has no filename")?;
        library_root.join(fname)
    };

    // Ensure parent directory tree exists
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).context("Failed to create destination directory")?;
    }

    // Copy the file
    fs::copy(source_path, &destination).context("Failed to copy file to library")?;

    // If Move mode, verify then delete original
    if config.import_mode == ImportMode::Move {
        let src_size = fs::metadata(source_path)
            .context("Failed to stat source")?
            .len();
        let dst_size = fs::metadata(&destination)
            .context("Failed to stat destination")?
            .len();

        if src_size == dst_size {
            fs::remove_file(source_path).context("Failed to remove source after move")?;
        } else {
            bail!(
                "File size mismatch after copy ({} vs {}), aborting move",
                src_size,
                dst_size
            );
        }
    }

    Ok(destination)
}

/// Recursively collect all supported audio files from a list of paths.
///
/// If a path is a directory it will be walked; regular files are checked
/// for a supported extension.
pub fn collect_audio_files(paths: &[String]) -> Vec<PathBuf> {
    let mut files = Vec::new();

    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            if let Ok(entries) = fs::read_dir(path) {
                let mut sub: Vec<String> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path().to_string_lossy().to_string())
                    .collect();
                sub.sort(); // deterministic order
                files.extend(collect_audio_files(&sub));
            }
        } else if is_supported_audio_file(path) {
            files.push(path.to_path_buf());
        }
    }

    files
}
