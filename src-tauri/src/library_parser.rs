use crate::models::Track;
use anyhow::{Context, Result};
use plist::Value;
use std::path::Path;
use url::Url;

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
        let bit_rate = track_info
            .get("Bit Rate")
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

        let rating_raw = track_info
            .get("Rating")
            .and_then(|v| v.as_unsigned_integer())
            .unwrap_or(0);

        // Check if the rating is computed (i.e. not explicitly set by user on this track)
        // iTunes XML adds <key>Rating Computed</key><true/> if the rating comes from the Album Rating.
        let rating_computed = track_info
            .get("Rating Computed")
            .and_then(|v| v.as_boolean()) // plist boolean
            .unwrap_or(false);

        let rating = if rating_computed { 0 } else { rating_raw };

        let date_added = track_info
            .get("Date Added")
            .and_then(|v| v.as_date())
            .map(|d| d.clone().into())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        let date_added_timestamp = date_added
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let bpm = track_info
            .get("BPM")
            .and_then(|v| v.as_unsigned_integer())
            .unwrap_or(0);

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
            bit_rate: bit_rate as i64,
            modified_date: modified_timestamp,
            rating: rating as i64,
            date_added: date_added_timestamp,
            bpm: bpm as i64,
            missing: false,
        };

        tracks.push(track);
    }

    Ok(tracks)
}

fn decode_location(location: &str) -> String {
    // 1. Try robust parsing using url crate first
    // This handles standard file:/// paths correctly yielding system paths
    if let Ok(parsed) = Url::parse(location) {
        // Only accept if it has no host or host is "localhost" (which we treat as local)
        let is_local = parsed.host_str().map(|h| h == "localhost" || h.is_empty()).unwrap_or(true);
        
        if is_local {
            if let Ok(file_path) = parsed.to_file_path() {
                if let Some(s) = file_path.to_str() {
                    return finalize_path(s);
                }
            }
        }
    }

    // 2. Fallback: Manual decoding if Url crate fails or rejects strictly
    // Common in iTunes XML: file://localhost/Users/... which standard parsers might dislike
    let decoded = urlencoding::decode(location)
        .unwrap_or(std::borrow::Cow::Borrowed(location))
        .to_string();
    
    let cleaned = decoded
        .replace("file://localhost", "")
        .replace("file://", "");

    finalize_path(&cleaned)
}

fn finalize_path(path_str: &str) -> String {
    // Heuristic: Strip Volume Name if it points to Users directory on boot drive
    // e.g. /Volumes/Macintosh HD/Users/... -> /Users/...
    // This handles the case where XML includes the boot volume name but the system expects root paths.
    if path_str.starts_with("/Volumes/") {
        if let Some(users_idx) = path_str.find("/Users/") {
             // Check if it's likely the boot drive (contains Users)
             return path_str[users_idx..].to_string();
        }
    } else if !path_str.starts_with("/Users/") && path_str.contains("/Users/") {
        // Handle weird cases like "/Macintosh HD/Users/..."
        if let Some(users_idx) = path_str.find("/Users/") {
            return path_str[users_idx..].to_string();
        }
    }

    path_str.to_string()
}
