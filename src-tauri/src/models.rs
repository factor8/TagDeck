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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Playlist {
    pub id: i64,               // Database ID
    pub persistent_id: String, // From iTunes XML
    pub parent_persistent_id: Option<String>,
    pub name: String,
    pub is_folder: bool,
    pub track_ids: Option<Vec<String>>, // Persistent IDs of tracks
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub usage_count: i64,
}
