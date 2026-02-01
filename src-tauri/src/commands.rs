use crate::db::Database;
use crate::library_parser::parse_library;
use crate::system_library::fetch_system_library;
use crate::metadata::write_metadata as write_tags_to_file;
use crate::models::Track;
use std::sync::Mutex;
use tauri::{AppHandle, State};

pub struct AppState {
    pub db: Mutex<Database>,
}

#[tauri::command]
pub async fn import_library(xml_path: String, state: State<'_, AppState>) -> Result<usize, String> {
    println!("Importing library from: {}", xml_path);

    // 1. Parse XML
    let tracks = parse_library(&xml_path).map_err(|e| e.to_string())?;
    let count = tracks.len();
    println!("Found {} tracks", count);

    // 2. Insert into DB
    let db = state
        .db
        .lock()
        .map_err(|_| "Failed to lock DB".to_string())?;

    for track in tracks {
        db.insert_track(&track).map_err(|e| e.to_string())?;
    }

    Ok(count)
}

#[tauri::command]
pub async fn get_tracks(state: State<'_, AppState>) -> Result<Vec<Track>, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Failed to lock DB".to_string())?;
    db.get_all_tracks().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_global_tags(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Failed to lock DB".to_string())?;

    let tracks = db.get_all_tracks().map_err(|e| e.to_string())?;
    let mut unique_tags = std::collections::HashSet::new();

    for track in tracks {
        if let Some(raw) = track.comment_raw {
            // Logic must match TagEditor.tsx: Split on " && "
            if let Some(idx) = raw.find(" && ") {
                let tag_part = &raw[idx + 4..];
                for tag in tag_part.split(';') {
                    let trimmed = tag.trim();
                    if !trimmed.is_empty() {
                        unique_tags.insert(trimmed.to_string());
                    }
                }
            }
        }
    }

    let mut sorted_tags: Vec<String> = unique_tags.into_iter().collect();
    sorted_tags.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(sorted_tags)
}

#[tauri::command]
pub fn show_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to reveal file: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to reveal file: {}", e))?;
    }
    // simple fallback for linux/other
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // just open directory
         let _ = open::that(std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new(&path)));
    }
    
    Ok(())
}

#[tauri::command]
pub async fn write_tags(
    id: i64,
    new_tags: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // 1. Get file path from DB
    let db = state
        .db
        .lock()
        .map_err(|_| "Failed to lock DB".to_string())?;
    // We need a way to get a single track. For now, let's reuse get_all or add a get_track.
    // Optimization: Just add get_track_by_id to DB.

    // For now, let's iterate (hacky but works for small test).
    // REAL fix: Add get_track to DB.
    let tracks = db.get_all_tracks().map_err(|e| e.to_string())?;
    let track = tracks
        .into_iter()
        .find(|t| t.id == id)
        .ok_or("Track not found")?;

    // 2. Write to File
    write_tags_to_file(&track.file_path, &new_tags).map_err(|e| e.to_string())?;

    // 3. Update DB (partial update)
    // We strictly assume new_tags is the FULL comment field content.
    // We do NOT update grouping anymore as requested.
    // But we need to update comment_raw.

    // We should probably leave grouping_raw AS IS in the DB,
    // but the current update_track_metadata requires both.

    // Let's modify DB to allow partial update or just pass the existing grouping if we knew it?
    // Current helper: update_track_metadata(id, comment, grouping)
    // We don't have the OLD grouping here unless we query it again or modify the helper.
    // Hack: Just pass empty string? No, that might wipe it in the UI table (though it's backup).
    // Better: Update the DB helper to ONLY update comment.

    db.update_track_metadata(id, &new_tags)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn import_from_music_app(state: State<'_, AppState>) -> Result<usize, String> {
    println!("Importing from Music.app...");

    // 1. Fetch from Sidecar
    let (tracks, playlists) = fetch_system_library().map_err(|e| e.to_string())?;
    let count = tracks.len();
    println!("Found {} tracks and {} playlists from Music.app", count, playlists.len());

    // 2. Insert into DB
    let db = state
        .db
        .lock()
        .map_err(|_| "Failed to lock DB".to_string())?;

    for track in tracks {
        db.insert_track(&track).map_err(|e| e.to_string())?;
    }
    
    for playlist in playlists {
        db.insert_playlist(&playlist).map_err(|e| e.to_string())?;
    }

    Ok(count)
}

#[tauri::command]
pub async fn get_playlists(state: State<'_, AppState>) -> Result<Vec<crate::models::Playlist>, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.get_playlists().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_playlist_track_ids(state: State<'_, AppState>, playlist_id: i64) -> Result<Vec<i64>, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.get_playlist_track_ids(playlist_id).map_err(|e| e.to_string())
}
