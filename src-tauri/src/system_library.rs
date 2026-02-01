use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::models::Track;

#[derive(Debug, Deserialize)]
struct ExternalTrack {
    pub persistent_id: String,
    pub file_path: String,
    pub artist: Option<String>,
    pub title: Option<String>,
    pub album: Option<String>,
    pub comment_raw: Option<String>,
    pub grouping_raw: Option<String>,
    pub duration_secs: f64,
    pub format: String,
    pub size_bytes: i64,
    pub bit_rate: i64,
    pub modified_date: i64,
    pub rating: i64,
    pub date_added: i64,
}

impl ExternalTrack {
    fn into_track(self) -> Track {
        Track {
            id: 0, // Auto-increment ID, set to 0 for new non-DB instances
            persistent_id: self.persistent_id,
            file_path: self.file_path,
            artist: self.artist,
            title: self.title,
            album: self.album,
            comment_raw: self.comment_raw,
            grouping_raw: self.grouping_raw,
            duration_secs: self.duration_secs,
            format: self.format,
            size_bytes: self.size_bytes,
            bit_rate: self.bit_rate,
            modified_date: self.modified_date,
            rating: self.rating,
            date_added: self.date_added,
        }
    }
}

pub fn fetch_system_library() -> Result<Vec<Track>> {
    // Attempt to locate the binary relative to the current working directory
    // This assumes running from the project root (e.g. `npm run tauri dev`)
    let relative_path = Path::new("src-tauri/bin/fetch-library");
    
    // Check if we are inside the src-tauri directory (e.g. `cargo run` inside src-tauri)
    let relative_path_inner = Path::new("bin/fetch-library");

    let binary_path = if relative_path.exists() {
        relative_path.to_path_buf()
    } else if relative_path_inner.exists() {
        relative_path_inner.to_path_buf()
    } else {
        // Fallback: try to find it relative to the executable if possible, 
        // or just return an error if we can't find it in expected locations.
        // For development, relative path is usually sufficient.
        return Err(anyhow::anyhow!(
            "Could not find fetch-library binary. Checked {:?} and {:?}",
            relative_path,
            relative_path_inner
        ));
    };

    let binary_abs_path = std::env::current_dir()
        .context("Failed to get current directory")?
        .join(&binary_path);

    let output = Command::new(&binary_abs_path)
        .output()
        .with_context(|| format!("Failed to execute binary at {:?}", binary_abs_path))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!("fetch-library binary failed: {}", stderr));
    }

    let json_str = String::from_utf8(output.stdout)
        .context("Failed to parse binary output as UTF-8")?;

    let external_tracks: Vec<ExternalTrack> = serde_json::from_str(&json_str)
        .context("Failed to parse JSON output from fetch-library")?;

    let tracks = external_tracks
        .into_iter()
        .map(|t| t.into_track())
        .collect();

    Ok(tracks)
}
