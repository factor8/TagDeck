use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Track {
    pub id: i64,               // Database ID
    pub persistent_id: String, // From iTunes XML (Persistent ID)
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
    pub modified_date: i64, // Unix timestamp
    pub rating: i64, // 0-100
    pub date_added: i64, // Unix timestamp
    pub bpm: i64,
    #[serde(default)]
    pub missing: bool,
    /// Link to the Music.app track, when one exists. NULL means the track is
    /// TagDeck-native or was removed from Music.app (see `unlinked_at`).
    #[serde(default)]
    pub itunes_pid: Option<String>,
    /// Set when a previously linked track disappeared from Music.app.
    #[serde(default)]
    pub unlinked_at: Option<i64>,
    /// "local" (has a file) or "spotify" (ghost — imported from Spotify, no file yet).
    #[serde(default = "default_source")]
    pub source: String,
    /// Spotify track ID. Set on ghosts; retained on the local track after a merge.
    #[serde(default)]
    pub spotify_id: Option<String>,
}

fn default_source() -> String {
    "local".to_string()
}

impl Track {
    /// Ghost = imported from Spotify with no local file yet.
    pub fn is_ghost(&self) -> bool {
        self.source == "spotify"
    }
}

/// Extract the applied tag names from a `comment_raw` string.
///
/// The convention (shared across Rust and TS) is `"<user comment> && Tag1; Tag2"`
/// — split on the FIRST `" && "`, then the tag block is `;`-separated and
/// trimmed. Returns an empty vec when there is no tag block.
pub fn parse_comment_tags(comment_raw: &str) -> Vec<String> {
    match comment_raw.find(" && ") {
        Some(idx) => comment_raw[idx + 4..]
            .split(';')
            .map(|t| t.trim())
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string())
            .collect(),
        None => Vec::new(),
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Playlist {
    pub id: i64,               // Database ID
    pub persistent_id: String, // From iTunes XML or TD-xxx for TagDeck-native
    pub parent_persistent_id: Option<String>,
    pub name: String,
    pub is_folder: bool,
    pub track_ids: Option<Vec<String>>, // Persistent IDs of tracks
    // Playlist management fields
    #[serde(default = "default_origin")]
    pub origin: String,                    // "itunes" | "tagdeck"
    #[serde(default)]
    pub itunes_sync_enabled: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub sort_position: i64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub spotify_playlist_id: Option<String>,
    #[serde(default)]
    pub spotify_snapshot_id: Option<String>,
}

fn default_origin() -> String {
    "itunes".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub usage_count: i64,
    pub group_id: Option<i64>,
    /// Optional user-authored prompt used for zero-shot tag suggestion.
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TagGroup {
    pub id: i64,
    pub name: String,
    pub position: i64,
}

/// A proposed brand-new tag (vocabulary expansion). Virtual until accepted: no
/// `tags` row exists for it until the user accepts a ghost chip on a track.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TagCandidate {
    pub id: i64,
    pub name: String,
    pub group_id: Option<i64>,
    /// Joined from `tag_groups` for display; not stored on the candidate row.
    pub group_name: Option<String>,
    /// Curated zero-shot prompt override (may be None → group template is used).
    pub description: Option<String>,
    /// 'proposed' | 'approved' | 'dismissed'
    pub status: String,
    /// 'concept_map' (future: 'llm')
    pub source: String,
}
