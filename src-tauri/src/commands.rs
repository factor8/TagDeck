use crate::db::Database;
use crate::library_parser::parse_library;
use crate::system_library::fetch_system_library;
use crate::metadata::{write_metadata as write_tags_to_file, get_artwork};
use crate::apple_music::{update_track_comment, batch_update_track_comments, touch_file};
use crate::models::Track;
use std::sync::Mutex;
use tauri::{State, Manager};

pub struct AppState {
    pub db: Mutex<Database>,
}

#[tauri::command]
pub async fn import_library(app: tauri::AppHandle, xml_path: String, state: State<'_, AppState>) -> Result<usize, String> {
    println!("Importing library from: {}", xml_path);

    // 1. Parse XML
    let tracks = parse_library(&xml_path).map_err(|e| {
        let msg = format!("XML Parse Error: {}", e);
        app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
        e.to_string()
    })?;
    let count = tracks.len();
    println!("Found {} tracks", count);

    // 2. Insert into DB
    let db = state
        .db
        .lock()
        .map_err(|_| "Failed to lock DB".to_string())?;

    for track in tracks {
        if let Err(e) = db.insert_track(&track) {
            let msg = format!("DB Error (XML Import): {}", e);
             app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
             return Err(e.to_string());
        }
    }

    Ok(count)
}

#[tauri::command]
pub async fn get_tracks(state: State<'_, AppState>) -> Result<Vec<Track>, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Failed to lock DB".to_string())?;
    let tracks = db.get_all_tracks().map_err(|e| e.to_string())?;
    
    Ok(tracks)
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
    
    // Using get_track now that it exists
    let mut track = db.get_track(id).map_err(|e| e.to_string())?
        .ok_or("Track not found")?;

    // 2. Write to File
    write_tags_to_file(&track.file_path, &new_tags).map_err(|e| e.to_string())?;

    // 2a. Touch file (for Rekordbox/Finder to notice change)
    if let Err(e) = touch_file(&track.file_path) {
        println!("Warning: Failed to touch file: {}", e);
    }
    
    // 2b. Update in Music.app (via AppleScript) - Direct Metadata Update
    if let Err(e) = update_track_comment(&track.persistent_id, &new_tags) {
         println!("Warning: Failed to update track in Music: {}", e);
    }

    // 3. Update DB
    track.comment_raw = Some(new_tags);
    db.update_track(&track).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn batch_add_tag(ids: Vec<i64>, tag: String, state: State<'_, AppState>) -> Result<(), String> {
    let raw_tag = tag.trim();
    if raw_tag.is_empty() {
        return Ok(());
    }

    let db_mutex = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    
    // Collect tracks to avoid holding lock too long if we needed to, but here we need lock for update anyway
    // Or we iterate one by one. For safety/simplicity let's get all tracks first.
    let mut tracks_to_update = Vec::new();

    for id in &ids {
        if let Ok(Some(track)) = db_mutex.get_track(*id) {
             tracks_to_update.push(track);
        }
    }
    // Drop lock to perform file IO
    drop(db_mutex); 

    let mut apple_music_updates = Vec::new();

    for mut track in tracks_to_update {
        let current_comment = track.comment_raw.clone().unwrap_or_default();
        let (user_comment, tag_block) = if let Some(idx) = current_comment.find(" && ") {
            (&current_comment[..idx], &current_comment[idx + 4..])
        } else {
            (current_comment.as_str(), "")
        };

        // Check if exists
        let mut tags: Vec<String> = tag_block.split(';')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();

        // Case insensitive check
        if !tags.iter().any(|t| t.to_lowercase() == raw_tag.to_lowercase()) {
            tags.push(raw_tag.to_string());
            
            // Reconstruct
            let new_tag_block = tags.join("; ");
            let new_full_comment = if !new_tag_block.is_empty() {
                if user_comment.is_empty() {
                     format!(" && {}", new_tag_block)
                } else {
                     format!("{} && {}", user_comment, new_tag_block)
                }
            } else {
                user_comment.to_string()
            };

            // WRITE
            // 1. File
             if let Err(e) = write_tags_to_file(&track.file_path, &new_full_comment) {
                 println!("Failed to write file {}: {}", track.id, e);
                 continue; 
             }

            // 2. DB (re-lock)
            track.comment_raw = Some(new_full_comment.clone());
            {
                if let Ok(db) = state.db.lock() {
                    let _ = db.update_track(&track);
                }
            }

            // 3. Queue Music.app Update
             if !track.persistent_id.is_empty() {
                 apple_music_updates.push((track.persistent_id.clone(), new_full_comment));
             } else {
                 let _ = touch_file(&track.file_path);
             }
        }
    }

    // Flush Batch Update
    if !apple_music_updates.is_empty() {
        if let Err(e) = batch_update_track_comments(apple_music_updates) {
            println!("Batch update to Music app failed: {}", e);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn batch_remove_tag(ids: Vec<i64>, tag: String, state: State<'_, AppState>) -> Result<(), String> {
    let raw_tag = tag.trim();
    if raw_tag.is_empty() {
        return Ok(());
    }
    
    // Lock briefly to get tracks
    let mut tracks_to_update = Vec::new();
    {
        let db_mutex = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        for id in &ids {
            if let Ok(Some(track)) = db_mutex.get_track(*id) {
                tracks_to_update.push(track);
            }
        }
    } // Drop lock

    let mut apple_music_updates = Vec::new();

    for mut track in tracks_to_update {
        // Parse Comments
        let current_comment = track.comment_raw.clone().unwrap_or_default();
        let (user_comment, tag_block) = if let Some(idx) = current_comment.find(" && ") {
            (&current_comment[..idx], &current_comment[idx + 4..])
        } else {
            (current_comment.as_str(), "")
        };

        // Filter OUT the tag
        let mut tags: Vec<String> = tag_block.split(';')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        
        let initial_len = tags.len();
        tags.retain(|t| t.to_lowercase() != raw_tag.to_lowercase());
        
        // If changed
        if tags.len() != initial_len {
            // Reconstruct
            let new_tag_block = tags.join("; ");
            let new_full_comment = if !new_tag_block.is_empty() {
                if user_comment.is_empty() {
                     format!(" && {}", new_tag_block)
                } else {
                     format!("{} && {}", user_comment, new_tag_block)
                }
            } else {
                user_comment.to_string()
            };

            // WRITE
            if let Err(e) = write_tags_to_file(&track.file_path, &new_full_comment) {
                println!("Failed to write file {}: {}", track.id, e);
                continue; 
            }

            // DB
            track.comment_raw = Some(new_full_comment.clone());
            {
                if let Ok(db) = state.db.lock() {
                    let _ = db.update_track(&track);
                }
            }

            // Music.app Queue
             if !track.persistent_id.is_empty() {
                 apple_music_updates.push((track.persistent_id.clone(), new_full_comment));
             } else {
                 let _ = touch_file(&track.file_path);
             }
        }
    }

    // Flush Batch
    if !apple_music_updates.is_empty() {
        if let Err(e) = batch_update_track_comments(apple_music_updates) {
             println!("Batch update to Music app failed: {}", e);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn import_from_music_app(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    println!("Importing from Music.app...");

    // 1. Fetch from Sidecar
    let (tracks, playlists) = match fetch_system_library(&app).await {
        Ok(res) => res,
        Err(e) => {
            let msg = format!("Sidecar Error: {}", e);
            app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
            return Err(msg);
        }
    };
    let count = tracks.len();
    println!("Found {} tracks and {} playlists from Music.app", count, playlists.len());

    // 2. Insert into DB
    let db = state
        .db
        .lock()
        .map_err(|_| "Failed to lock DB".to_string())?;

    for track in tracks {
        if let Err(e) = db.insert_track(&track) {
            let msg = format!("DB Error (insert track): {}", e);
            app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
            return Err(msg);
        }
    }
    
    for playlist in playlists {
        if let Err(e) = db.insert_playlist(&playlist) {
             let msg = format!("DB Error (insert playlist): {}", e);
             app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
             return Err(msg);
        }
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

#[tauri::command]
pub async fn mark_track_missing(id: i64, missing: bool, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;

    if missing {
         if let Ok(path) = db.get_track_path(id) {
             println!("Debug: Marking track {} missing. Path: '{}'", id, path);
             // Check if it exists
             match std::fs::metadata(&path) {
                 Ok(_) => println!("  - File actually EXISTS!"),
                 Err(_) => {
                     println!("  - File NOT FOUND at path.");
                     
                     // Try heuristic fix for typical "iTunes vs iTunes/Music" nesting issue
                     // Expanded to handle iTunes Music, iTunes Media variations
                     if path.contains("/iTunes/") {
                         let candidates = [
                             "/iTunes/Music/",
                             "/iTunes/iTunes Music/",
                             "/iTunes/iTunes Media/Music/",
                             "/iTunes/iTunes Media/",
                         ];

                         for candidate in candidates {
                             let fixed_path = path.replace("/iTunes/", candidate);
                             if fixed_path != path && std::path::Path::new(&fixed_path).exists() {
                                 println!("  - FOUND at corrected path: '{}'", fixed_path);
                                 println!("  - Auto-correcting database entry...");
                                 if let Err(e) = db.update_track_path(id, &fixed_path) {
                                     println!("  - Failed to update DB: {}", e);
                                 } else {
                                     println!("  - DB Updated. Next playback should work.");
                                     return Ok(()); // Do NOT mark missing
                                 }
                             }
                         }
                     }
                 }
             }
         }
    }

    db.set_track_missing(id, missing).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn debug_db_path(_state: State<'_, AppState>) -> Result<String, String> {
    Ok("Debug path info not exposed directly but DB is open".to_string())
}

#[tauri::command]
pub async fn get_track_artwork(id: i64, state: State<'_, AppState>) -> Result<Option<Vec<u8>>, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    let path = db.get_track_path(id).map_err(|e| e.to_string())?;
    drop(db); // Release lock before doing IO
    
    get_artwork(&path).map_err(|e| e.to_string())
}
