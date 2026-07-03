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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TagGroup {
    pub id: i64,
    pub name: String,
    pub position: i64,
}
