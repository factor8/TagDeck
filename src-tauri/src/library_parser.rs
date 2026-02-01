use crate::models::Track;
use anyhow::{Context, Result};
use plist::Value;
use std::path::Path;
use urlencoding::decode;

pub fn parse_library<P: AsRef<Path>>(path: P) -> Result<Vec<Track>> {
    let value = Value::from_file(path).context("Failed to read iTunes Library XML")?;

    let root_dict = value.as_dictionary().context("Root is not a dictionary")?;
    let tracks_dict = root_dict
        .get("Tracks")
        .context("No Tracks key")?
        .as_dictionary()
        .context("Tracks is not a dictionary")?;

    let mut tracks = Vec::new();

    for (_key, track_value) in tracks_dict {
        let track_info = track_value.as_dictionary().unwrap(); // Should handle error gracefully

        // Skip remote/streamed tracks
        if track_info.contains_key("Track Type") {
            if let Some(type_str) = track_info.get("Track Type").and_then(|v| v.as_string()) {
                if type_str == "Remote" || type_str == "Stream" {
                    continue;
                }
            }
        }

        // Essential fields
        let persistent_id = track_info
            .get("Persistent ID")
            .and_then(|v| v.as_string())
            .unwrap_or_default()
            .to_string();
        let location_raw = track_info.get("Location").and_then(|v| v.as_string());

        if location_raw.is_none() {
            continue; // Skip if no file location
        }

        let location = decode_location(location_raw.unwrap());

        let name = track_info
            .get("Name")
            .and_then(|v| v.as_string())
            .map(|s| s.to_string());
        let artist = track_info
            .get("Artist")
            .and_then(|v| v.as_string())
            .map(|s| s.to_string());
        let album = track_info
            .get("Album")
            .and_then(|v| v.as_string())
            .map(|s| s.to_string());
        let comments = track_info
            .get("Comments")
            .and_then(|v| v.as_string())
            .map(|s| s.to_string());
        let grouping = track_info
            .get("Grouping")
            .and_then(|v| v.as_string())
            .map(|s| s.to_string());
        let total_time_ms = track_info
            .get("Total Time")
            .and_then(|v| v.as_unsigned_integer())
            .unwrap_or(0);
        let size = track_info
            .get("Size")
            .and_then(|v| v.as_unsigned_integer())
            .unwrap_or(0);
        // plist::Date usually behaves like SystemTime or implements into
        let modified_date = track_info
            .get("Date Modified")
            .and_then(|v| v.as_date())
            .map(|d| d.clone().into())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        let modified_timestamp = modified_date
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        // Simple format detection from extension
        let format = location
            .split('.')
            .last()
            .unwrap_or("unknown")
            .to_lowercase();

        let track = Track {
            id: 0, // DB auto-increments
            persistent_id,
            file_path: location,
            artist,
            title: name,
            album,
            comment_raw: comments,
            grouping_raw: grouping,
            duration_secs: (total_time_ms as f64) / 1000.0,
            format,
            size_bytes: size as i64,
            modified_date: modified_timestamp,
        };

        tracks.push(track);
    }

    Ok(tracks)
}

fn decode_location(location: &str) -> String {
    // iTunes Location is file://localhost/Users/...
    let decoded = decode(location).expect("UTF-8").to_string();
    decoded
        .replace("file://localhost", "")
        .replace("file://", "")
}
