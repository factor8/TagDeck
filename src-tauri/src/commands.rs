use crate::db::Database;
use crate::library_parser::parse_library;
use crate::system_library::fetch_system_library;
use crate::metadata::{write_metadata as write_tags_to_file, get_artwork, write_track_info};
use crate::file_manager::{
    LibraryConfig, ImportResult, ImportSummary, SyncMode, DeletionBehavior,
    import_file, is_supported_audio_file, collect_audio_files,
};
use crate::apple_music::{
    update_track_comment, batch_update_track_comments, update_track_rating, touch_file, add_track_to_playlist, get_changes_since, get_snapshot_fields, get_playlist_snapshot,
    remove_track_from_playlist as apple_remove_from_playlist, get_play_count, set_play_count, update_track_info as apple_update_track_info,
    get_all_music_app_pids, get_tracks_by_persistent_ids
};
use crate::models::{Track, Playlist};
use crate::undo::{UndoStack, Action, TrackState, TrackRef};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{State, Manager};

pub struct AppState {
    pub db: Mutex<Database>,
    pub undo_stack: Mutex<UndoStack>,
    pub is_syncing: AtomicBool,
}

#[tauri::command]
pub async fn undo(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let mut undo_stack = state.undo_stack.lock().map_err(|_| "Failed to lock undo stack")?;
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    undo_stack.undo(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn redo(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let mut undo_stack = state.undo_stack.lock().map_err(|_| "Failed to lock undo stack")?;
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    undo_stack.redo(&db).map_err(|e| e.to_string())
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

    // Sync tags
    if let Err(e) = db.sync_tags() {
        let msg = format!("Tag Sync Error: {}", e);
        app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
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
    println!("Revealing file at: {}", path);
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
pub async fn analyze_with_mixed_in_key(app: tauri::AppHandle, track_ids: Vec<i64>, file_paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let file_count = file_paths.len();
    
    #[cfg(target_os = "macos")]
    {
        let mik_path = "/Applications/Mixed In Key 8.app";
        if !std::path::Path::new(mik_path).exists() {
            return Err("Mixed In Key 8 not found. Please install from https://mixedinkey.com/".to_string());
        }

        // Validate files exist and capture their current modification times
        let mut file_mod_times: Vec<(String, std::time::SystemTime)> = Vec::new();
        for path in &file_paths {
            let path_obj = std::path::Path::new(path);
            if !path_obj.exists() {
                return Err(format!("File not found: {}", path));
            }
            
            // Get current modification time
            let metadata = std::fs::metadata(path_obj)
                .map_err(|e| format!("Failed to read file metadata: {}", e))?;
            let mod_time = metadata.modified()
                .map_err(|e| format!("Failed to get modification time: {}", e))?;
            
            file_mod_times.push((path.clone(), mod_time));
        }

        // Build AppleScript to automate Mixed In Key 8
        let paths_arg = file_paths.iter()
            .map(|p| format!("POSIX file \"{}\"", p.replace("\"", "\\\"")))
            .collect::<Vec<_>>()
            .join(", ");

        let script = format!(r#"
tell application "Mixed In Key 8"
    activate
    delay 1
    
    -- Add files to queue
    set fileList to {{{}}}
    repeat with aFile in fileList
        try
            open aFile
        end try
    end repeat
    
    -- Give MiK8 time to start processing
    delay 3
end tell
"#, paths_arg);

        let launch_msg = format!("Launching Mixed In Key 8 with {} file(s)", file_count);
        app.state::<crate::logging::LogState>().add_log("INFO", &launch_msg, &app);
        
        // Launch MiK8 in the background
        std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| format!("Failed to launch Mixed In Key with AppleScript: {}", e))?;
        
        // Wait for all files to be modified (indicating MiK8 has processed them)
        let max_wait_seconds = 10 + (file_count * 15); // 10s base + 15s per file
        let poll_interval = std::time::Duration::from_secs(2);
        let start_time = std::time::Instant::now();
        
        let mut files_processed = 0;
        
        loop {
            // Check if we've exceeded the timeout
            if start_time.elapsed().as_secs() > max_wait_seconds as u64 {
                let timeout_msg = format!("Mixed In Key timeout: {} of {} files processed", files_processed, file_count);
                app.state::<crate::logging::LogState>().add_log("ERROR", &timeout_msg, &app);
                break;
            }
            
            // Check each file's modification time
            let mut all_processed = true;
            files_processed = 0;
            
            for (path, original_time) in &file_mod_times {
                if let Ok(metadata) = std::fs::metadata(path) {
                    if let Ok(current_time) = metadata.modified() {
                        if current_time > *original_time {
                            files_processed += 1;
                        } else {
                            all_processed = false;
                        }
                    }
                }
            }
            
            if all_processed {
                break;
            }
            
            std::thread::sleep(poll_interval);
        }
        
        // Give MiK8 a moment to finish writing
        std::thread::sleep(std::time::Duration::from_secs(1));
        
        // Try to quit MiK8
        let quit_script = r#"
tell application "Mixed In Key 8"
    quit
end tell
"#;
        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(quit_script)
            .output();
        
        // After MiK8 finishes, refresh the metadata for all processed tracks
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        
        let mut success_count = 0;
        for track_id in &track_ids {
            if let Err(e) = refresh_track_metadata_from_file(&db, *track_id) {
                let error_msg = format!("Failed to refresh track {}: {}", track_id, e);
                app.state::<crate::logging::LogState>().add_log("ERROR", &error_msg, &app);
            } else {
                success_count += 1;
            }
        }
        
        let completion_msg = format!("Mixed In Key analysis complete: {} of {} tracks updated", success_count, file_count);
        app.state::<crate::logging::LogState>().add_log("INFO", &completion_msg, &app);
    }
    
    #[cfg(not(target_os = "macos"))]
    {
        return Err("Mixed In Key integration is only supported on macOS".to_string());
    }
    
    Ok(())
}

/// Helper function to refresh a track's metadata from its file
fn refresh_track_metadata_from_file(db: &Database, track_id: i64) -> Result<(), String> {
    use crate::metadata::read_metadata;
    use lofty::read_from_path;
    use lofty::prelude::*;
    use lofty::tag::ItemKey;
    
    // Get the track from database to get its file path
    let track = db.get_track(track_id)
        .map_err(|e| format!("Failed to get track: {}", e))?
        .ok_or_else(|| format!("Track {} not found", track_id))?;
    
    // Read metadata from the file
    let (comment, grouping) = read_metadata(&track.file_path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    
    // Read BPM from file using lofty
    let tagged_file = read_from_path(&track.file_path)
        .map_err(|e| format!("Failed to read audio file: {}", e))?;
    
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());
    
    // Read BPM from the standard BPM tag field
    let bpm = tag
        .and_then(|t| t.get_string(&ItemKey::Bpm))
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0);
    
    // Update the database with the new metadata
    let mut updated_track = track;
    updated_track.comment_raw = Some(comment);
    updated_track.grouping_raw = Some(grouping);
    updated_track.bpm = bpm;
    
    db.update_track(&updated_track)
        .map_err(|e| format!("Failed to update track in database: {}", e))?;
    
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

    // Ghost tracks (Spotify, no file): DB-only tag storage; no file IO,
    // no Music.app push, no dirty flag, no undo (nothing external to revert).
    if track.is_ghost() {
        track.comment_raw = Some(new_tags);
        db.update_track(&track).map_err(|e| e.to_string())?;
        let _ = db.sync_tags();
        return Ok(());
    }

    // Prepare Undo
    let old_comment = track.comment_raw.clone().unwrap_or_default();
    let undo_action = Action::UpdateTrackComments { 
        tracks: vec![TrackState {
            id: track.id,
            // Undo uses this only for Music.app write-back; empty = unlinked, skipped
            persistent_id: track.itunes_pid.clone().unwrap_or_default(),
            file_path: track.file_path.clone(),
            old_comment: old_comment.clone(),
            new_comment: new_tags.clone(),
        }]
    };

    // 2. Write to File
    write_tags_to_file(&track.file_path, &new_tags).map_err(|e| e.to_string())?;

    // 2a. Touch file (for Rekordbox/Finder to notice change)
    if let Err(e) = touch_file(&track.file_path) {
        println!("Warning: Failed to touch file: {}", e);
    }
    
    // 2b. Update in Music.app (via AppleScript) - only for linked tracks, and only
    // when the sync mode allows pushing TagDeck edits back to Music.app.
    let push_enabled = LibraryConfig::sync_mode(&db).push_enabled();
    if push_enabled {
        if let Some(itunes_pid) = &track.itunes_pid {
            if let Err(e) = update_track_comment(itunes_pid, &new_tags) {
                 println!("Warning: Failed to update track in Music: {}", e);
            }
        }
    } else {
        // Push is disabled, so this edit diverges from Music.app - flag for later reconciliation.
        if let Err(e) = db.mark_tracks_dirty(&[track.id]) {
            println!("Warning: Failed to mark track dirty: {}", e);
        }
    }

    // 3. Update DB
    track.comment_raw = Some(new_tags);
    db.update_track(&track).map_err(|e| e.to_string())?;

    // 4. Push Undo
    drop(db); // Drop DB lock before locking Undo Stack to prevent deadlocks (though different mutexes, good practice)
    if let Ok(mut stack) = state.undo_stack.lock() {
        stack.push(undo_action);
    }

    Ok(())
}

#[tauri::command]
pub async fn batch_add_tag(ids: Vec<i64>, tag: String, state: State<'_, AppState>) -> Result<(), String> {
    let raw_tag = tag.trim();
    if raw_tag.is_empty() {
        return Ok(());
    }

    let db_mutex = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    let mode = LibraryConfig::sync_mode(&db_mutex);

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
    let mut undo_track_states = Vec::new();
    let mut dirty_ids: Vec<i64> = Vec::new();

    for mut track in tracks_to_update {
        let current_comment = track.comment_raw.clone().unwrap_or_default();
        let old_comment_val = current_comment.clone(); // Capture for undo

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

            // Ghost tracks (Spotify, no file): DB-only tag storage.
            if track.is_ghost() {
                track.comment_raw = Some(new_full_comment.clone());
                if let Ok(db) = state.db.lock() {
                    let _ = db.update_track(&track);
                }
                continue; // no file write, no Music push, no undo entry
            }

            // Prepare Undo State
            undo_track_states.push(TrackState {
                id: track.id,
                // Undo uses this only for Music.app write-back; empty = unlinked, skipped
                persistent_id: track.itunes_pid.clone().unwrap_or_default(),
                file_path: track.file_path.clone(),
                old_comment: old_comment_val,
                new_comment: new_full_comment.clone(),
            });

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

            // 3. Queue Music.app Update (only when the sync mode allows pushing)
             if mode.push_enabled() {
                 if let Some(itunes_pid) = &track.itunes_pid {
                     apple_music_updates.push((itunes_pid.clone(), new_full_comment));
                 } else {
                     let _ = touch_file(&track.file_path);
                 }
             } else {
                 let _ = touch_file(&track.file_path);
                 dirty_ids.push(track.id);
             }
        }
    }

    // Flush Batch Update
    if !apple_music_updates.is_empty() {
        if let Err(e) = batch_update_track_comments(apple_music_updates) {
            println!("Batch update to Music app failed: {}", e);
        }
    }

    // Push is disabled for these edits, so they diverge from Music.app - flag for later reconciliation.
    if !dirty_ids.is_empty() {
        if let Ok(db) = state.db.lock() {
            if let Err(e) = db.mark_tracks_dirty(&dirty_ids) {
                println!("Warning: Failed to mark tracks dirty: {}", e);
            }
        }
    }

    // Push Undo Action
    if !undo_track_states.is_empty() {
        if let Ok(mut stack) = state.undo_stack.lock() {
            stack.push(Action::UpdateTrackComments { tracks: undo_track_states });
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
    let mode = {
        let db_mutex = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        for id in &ids {
            if let Ok(Some(track)) = db_mutex.get_track(*id) {
                tracks_to_update.push(track);
            }
        }
        LibraryConfig::sync_mode(&db_mutex)
    }; // Drop lock

    let mut apple_music_updates = Vec::new();
    let mut undo_track_states = Vec::new();
    let mut dirty_ids: Vec<i64> = Vec::new();

    for mut track in tracks_to_update {
        // Parse Comments
        let current_comment = track.comment_raw.clone().unwrap_or_default();
        let old_comment_val = current_comment.clone();

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

            // Ghost tracks (Spotify, no file): DB-only tag storage.
            if track.is_ghost() {
                track.comment_raw = Some(new_full_comment.clone());
                if let Ok(db) = state.db.lock() {
                    let _ = db.update_track(&track);
                }
                continue; // no file write, no Music push, no undo entry
            }

            // Prepare Undo State
            undo_track_states.push(TrackState {
                id: track.id,
                // Undo uses this only for Music.app write-back; empty = unlinked, skipped
                persistent_id: track.itunes_pid.clone().unwrap_or_default(),
                file_path: track.file_path.clone(),
                old_comment: old_comment_val,
                new_comment: new_full_comment.clone(),
            });

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

            // Music.app Queue (only when the sync mode allows pushing)
             if mode.push_enabled() {
                 if let Some(itunes_pid) = &track.itunes_pid {
                     apple_music_updates.push((itunes_pid.clone(), new_full_comment));
                 } else {
                     let _ = touch_file(&track.file_path);
                 }
             } else {
                 let _ = touch_file(&track.file_path);
                 dirty_ids.push(track.id);
             }
        }
    }

    // Flush Batch
    if !apple_music_updates.is_empty() {
        if let Err(e) = batch_update_track_comments(apple_music_updates) {
             println!("Batch update to Music app failed: {}", e);
        }
    }

    // Push is disabled for these edits, so they diverge from Music.app - flag for later reconciliation.
    if !dirty_ids.is_empty() {
        if let Ok(db) = state.db.lock() {
            if let Err(e) = db.mark_tracks_dirty(&dirty_ids) {
                println!("Warning: Failed to mark tracks dirty: {}", e);
            }
        }
    }

    // Push Undo Action
    if !undo_track_states.is_empty() {
        if let Ok(mut stack) = state.undo_stack.lock() {
            stack.push(Action::UpdateTrackComments { tracks: undo_track_states });
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn import_from_music_app(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let mode = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        LibraryConfig::sync_mode(&db)
    };
    if mode == SyncMode::Off {
        return Err("iTunes sync is turned off in Settings".to_string());
    }

    // Acquire sync lock
    if state.is_syncing.swap(true, Ordering::SeqCst) {
        return Err("Sync already in progress".to_string());
    }

    // Ensure lock is released even on error
    struct SyncGuard<'a>(&'a AtomicBool);
    impl<'a> Drop for SyncGuard<'a> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = SyncGuard(&state.is_syncing);

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
        // In modes that don't push comments back to Music.app, its copy is stale
        // relative to the file (golden source) — preserve any existing DB row's
        // comment/grouping instead of overwriting with Music.app's copy.
        let insert_result = if mode.push_enabled() {
            db.insert_track(&track).map(|_| ())
        } else {
            db.insert_track_preserving_comment(&track).map(|_| ())
        };
        if let Err(e) = insert_result {
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

#[derive(serde::Serialize, Default)]
pub struct SyncResult {
    pub tracks_updated: usize,
    pub tracks_added: usize,
    /// Tracks that disappeared from Music.app. They are unlinked, not deleted.
    pub tracks_unlinked: usize,
    pub playlists_updated: usize,
    /// Tracks removed in Music.app awaiting a keep/remove decision
    /// (deletion behavior = Ask). Resolved via `apply_sync_changes`.
    pub pending_removals: Vec<crate::sync_review::RemovedTrack>,
    /// Incoming iTunes changes NOT applied because the track was edited in
    /// TagDeck while pushes were off (conflict — resolve in Sync Review).
    pub conflicts_skipped: usize,
}

#[tauri::command]
pub async fn sync_recent_changes(app: tauri::AppHandle, state: State<'_, AppState>, since_timestamp: i64) -> Result<SyncResult, String> {
    
    // Check if full sync is running, but don't error out hard—just skip
    if state.is_syncing.load(Ordering::SeqCst) {
        println!("Sync skipped: Full sync in progress");
        return Ok(SyncResult::default());
    }

    // Sync mode may disallow pulling from Music.app entirely (Off). Check before
    // taking the sync lock so we never need to release it on this early return.
    let mode = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        LibraryConfig::sync_mode(&db)
    };
    if !mode.pull_enabled() {
        let msg = "Sync skipped: iTunes pull is disabled by the current sync mode";
        println!("{}", msg);
        app.state::<crate::logging::LogState>().add_log("INFO", msg, &app);
        return Ok(SyncResult::default());
    }
    // We do NOT set the lock for real-time sync (unless we want to block full sync?)
    // Actually, we should probably lock it too to prevent concurrent real-time syncs?
    // User requested "realtime sync doesnt happen when the Full Sync is running".
    // It's safer if they are mutually exclusive.
    
    if state.is_syncing.swap(true, Ordering::SeqCst) {
        // Race condition caught
        return Ok(SyncResult::default());
    }

    struct SyncGuard<'a>(&'a AtomicBool);
    impl<'a> Drop for SyncGuard<'a> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = SyncGuard(&state.is_syncing);

    let start_msg = format!("Syncing recent changes from Music.app since timestamp: {}", since_timestamp);
    println!("{}", start_msg);
    app.state::<crate::logging::LogState>().add_log("INFO", &start_msg, &app);

    let mut total_updated = 0;
    let mut tracks_added = 0;
    let mut tracks_unlinked = 0;
    let mut pending_removals: Vec<crate::sync_review::RemovedTrack> = Vec::new();
    let mut conflicts_skipped = 0;

    // Tracks edited in TagDeck while pushes were off must not be silently
    // overwritten by an incoming iTunes change — they are conflicts for Sync
    // Review to resolve, whatever the current mode.
    let dirty_pids = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.get_dirty_itunes_pids().unwrap_or_default()
    };

    // --- Phase 0: Detect newly imported and removed tracks ---
    // Compare the set of persistent IDs in Music.app vs our linked tracks to find
    // additions and removals. Removals only unlink — TagDeck owns track existence.
    let phase0_msg = "Phase 0: Checking for imported/removed tracks...";
    println!("{}", phase0_msg);
    app.state::<crate::logging::LogState>().add_log("INFO", phase0_msg, &app);

    match get_all_music_app_pids() {
        Ok(music_pids) => {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            let db_pids = db.get_all_itunes_pids().map_err(|e| e.to_string())?;
            drop(db); // Release lock before potentially slow AppleScript calls

            // Detect NEW tracks (in Music.app but not linked in our DB)
            let new_pids: Vec<String> = music_pids.iter()
                .filter(|pid| !db_pids.contains(*pid))
                .cloned()
                .collect();

            // Detect REMOVED tracks (linked in our DB but gone from Music.app)
            let deleted_pids: Vec<String> = db_pids.iter()
                .filter(|pid| !music_pids.contains(*pid))
                .cloned()
                .collect();

            // Handle newly imported tracks
            if !new_pids.is_empty() {
                let import_msg = format!("Found {} new track(s) in Music.app. Importing...", new_pids.len());
                println!("{}", import_msg);
                app.state::<crate::logging::LogState>().add_log("INFO", &import_msg, &app);

                match get_tracks_by_persistent_ids(&new_pids) {
                    Ok(new_tracks) => {
                        let count = new_tracks.len();
                        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
                        for track in &new_tracks {
                            // See insert_track_preserving_comment: avoid clobbering DB
                            // comments with Music.app's stale copy when not pushing.
                            let insert_result = if mode.push_enabled() {
                                db.insert_track(track).map(|_| ())
                            } else {
                                db.insert_track_preserving_comment(track).map(|_| ())
                            };
                            if let Err(e) = insert_result {
                                let msg = format!("DB Error importing new track {}: {}", track.persistent_id, e);
                                app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                            }
                        }
                        // Log some details
                        for (i, track) in new_tracks.iter().enumerate() {
                            if i < 10 {
                                let title = track.title.as_deref().unwrap_or("Unknown");
                                let artist = track.artist.as_deref().unwrap_or("Unknown");
                                let detail = format!("Imported: {} - {}", artist, title);
                                println!("{}", detail);
                                app.state::<crate::logging::LogState>().add_log("INFO", &detail, &app);
                            }
                        }
                        if count > 10 {
                            let more = format!("...and {} more imported tracks", count - 10);
                            app.state::<crate::logging::LogState>().add_log("INFO", &more, &app);
                        }
                        drop(db);
                        tracks_added += count;
                        total_updated += count;
                    }
                    Err(e) => {
                        let msg = format!("Failed to fetch new track data from Music.app: {}", e);
                        app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                    }
                }
            }

            // Handle removed tracks per the `itunes_deletion_behavior` setting:
            // Keep (default) unlinks — the track and all its TagDeck data stay;
            // Remove mirrors the deletion into TagDeck too.
            if !deleted_pids.is_empty() {
                let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
                let deletion_behavior = LibraryConfig::load(&db)
                    .map(|c| c.itunes_deletion_behavior)
                    .unwrap_or(DeletionBehavior::Keep);

                match deletion_behavior {
                    DeletionBehavior::Ask => {
                        // Don't decide — report the removals so the frontend can
                        // open Sync Review. Until the user resolves them (via
                        // apply_sync_changes) each sync re-reports the same set.
                        let ask_msg = format!("Found {} track(s) removed from Music.app. Awaiting user decision (deletion behavior: ask).", deleted_pids.len());
                        println!("{}", ask_msg);
                        app.state::<crate::logging::LogState>().add_log("INFO", &ask_msg, &app);

                        match db.get_tracks_by_itunes_pids(&deleted_pids) {
                            Ok(tracks) => {
                                pending_removals.extend(tracks.iter().map(|t| crate::sync_review::RemovedTrack {
                                    track_id: t.id,
                                    itunes_pid: t.itunes_pid.clone().unwrap_or_default(),
                                    title: t.title.clone(),
                                    artist: t.artist.clone(),
                                }));
                            }
                            Err(e) => {
                                let msg = format!("DB Error loading removed tracks for review: {}", e);
                                app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                            }
                        }
                    }
                    DeletionBehavior::Keep => {
                        let delete_msg = format!("Found {} track(s) removed from Music.app. Unlinking (deletion behavior: keep)...", deleted_pids.len());
                        println!("{}", delete_msg);
                        app.state::<crate::logging::LogState>().add_log("INFO", &delete_msg, &app);

                        match db.unlink_tracks_by_itunes_pids(&deleted_pids) {
                            Ok(count) => {
                                let msg = format!("Unlinked {} track(s) removed from Music.app (kept in TagDeck)", count);
                                println!("{}", msg);
                                app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);
                                tracks_unlinked += count;
                                total_updated += count;
                            }
                            Err(e) => {
                                let msg = format!("DB Error unlinking removed tracks: {}", e);
                                app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                            }
                        }
                    }
                    DeletionBehavior::Remove => {
                        let delete_msg = format!("Found {} track(s) removed from Music.app. Deleting from TagDeck (deletion behavior: remove)...", deleted_pids.len());
                        println!("{}", delete_msg);
                        app.state::<crate::logging::LogState>().add_log("INFO", &delete_msg, &app);

                        match db.delete_tracks_by_itunes_pids(&deleted_pids) {
                            Ok(count) => {
                                let msg = format!("Deleted {} track(s) removed from Music.app", count);
                                println!("{}", msg);
                                app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);
                                tracks_unlinked += count;
                                total_updated += count;
                            }
                            Err(e) => {
                                let msg = format!("DB Error deleting removed tracks: {}", e);
                                app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                            }
                        }
                    }
                }
                drop(db);
            }

            if new_pids.is_empty() && deleted_pids.is_empty() {
                let msg = "Phase 0: No imported or removed tracks detected.";
                println!("{}", msg);
                app.state::<crate::logging::LogState>().add_log("INFO", msg, &app);
            }
        }
        Err(e) => {
            let msg = format!("Phase 0 failed (non-fatal): {}", e);
            eprintln!("{}", msg);
            app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
        }
    }

    // --- Phase 1: Date-based query for metadata changes (title, artist, album, comment, grouping) ---
    // `modification date` in Music.app covers these fields.
    let tracks = get_changes_since(since_timestamp).map_err(|e| {
        let msg = format!("Failed to fetch date-based changes: {}", e);
        app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
        msg
    })?;

    let meta_count = tracks.len();
    println!("Found {} metadata-changed tracks via modification date", meta_count);
    app.state::<crate::logging::LogState>().add_log("INFO", &format!("Found {} metadata-changed tracks via modification date", meta_count), &app);

    if meta_count > 0 {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        for t in &tracks {
            let title = t.title.as_deref().unwrap_or("Unknown Title");
            let artist = t.artist.as_deref().unwrap_or("Unknown Artist");
            println!("Syncing metadata: {} - {}", artist, title);
            if total_updated < 10 {
                app.state::<crate::logging::LogState>().add_log("INFO", &format!("Syncing metadata: {} - {}", artist, title), &app);
            }
        }
        let mut applied = 0;
        for track in tracks {
            if dirty_pids.contains(&track.persistent_id) {
                let msg = format!("Conflict: skipping iTunes change for {} (edited in TagDeck since last sync)", track.persistent_id);
                println!("{}", msg);
                app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
                conflicts_skipped += 1;
                continue;
            }
            // See insert_track_preserving_comment: avoid clobbering DB comments
            // with Music.app's stale copy when not pushing edits back to it.
            let insert_result = if mode.push_enabled() {
                db.insert_track(&track).map(|_| ())
            } else {
                db.insert_track_preserving_comment(&track).map(|_| ())
            };
            if let Err(e) = insert_result {
                let msg = format!("DB Error (update track {}): {}", track.persistent_id, e);
                app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
            } else {
                applied += 1;
            }
        }
        total_updated += applied;
        drop(db);
    }

    // --- Phase 2: Snapshot diff for rating & BPM ---
    // Music.app does NOT update `modification date` when rating or BPM changes.
    // We fetch a lightweight snapshot of (persistent_id, rating, bpm) for all tracks
    // and diff against our DB to detect changes.
    let snapshot_msg = "Fetching rating/BPM snapshot from Music.app for diff...";
    println!("{}", snapshot_msg);
    app.state::<crate::logging::LogState>().add_log("INFO", snapshot_msg, &app);

    match get_snapshot_fields() {
        Ok(snapshot) => {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            let db_snapshot = db.get_rating_bpm_snapshot().map_err(|e| e.to_string())?;

            let mut diff_count = 0;
            for entry in &snapshot {
                if let Some(&(db_rating, db_bpm)) = db_snapshot.get(&entry.persistent_id) {
                    if db_rating != entry.rating || db_bpm != entry.bpm {
                        if dirty_pids.contains(&entry.persistent_id) {
                            conflicts_skipped += 1;
                            continue;
                        }
                        if let Err(e) = db.update_rating_bpm(&entry.persistent_id, entry.rating, entry.bpm) {
                            let msg = format!("DB Error (snapshot update {}): {}", entry.persistent_id, e);
                            app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                        } else {
                            diff_count += 1;
                            if diff_count <= 10 {
                                let detail = format!("Snapshot diff: {} — rating {} → {}, bpm {} → {}",
                                    entry.persistent_id, db_rating, entry.rating, db_bpm, entry.bpm);
                                println!("{}", detail);
                                app.state::<crate::logging::LogState>().add_log("INFO", &detail, &app);
                            }
                        }
                    }
                }
                // If persistent_id not in our DB, skip (track not imported yet)
            }

            let snap_msg = format!("Snapshot diff found {} rating/BPM changes", diff_count);
            println!("{}", snap_msg);
            app.state::<crate::logging::LogState>().add_log("INFO", &snap_msg, &app);
            total_updated += diff_count;
        }
        Err(e) => {
            let msg = format!("Snapshot diff failed (non-fatal): {}", e);
            eprintln!("{}", msg);
            app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
        }
    }

    // --- Phase 3: Playlist snapshot diff ---
    // Detect added, removed, renamed, reordered playlists and membership changes.
    let mut playlist_changes = 0;
    let playlist_msg = "Fetching playlist snapshot from Music.app for diff...";
    println!("{}", playlist_msg);
    app.state::<crate::logging::LogState>().add_log("INFO", playlist_msg, &app);

    match get_playlist_snapshot() {
        Ok(music_playlists) => {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            let db_snapshot = db.get_playlist_snapshot().map_err(|e| e.to_string())?;
            
            // Fetch all known track PIDs to filter the music_playlist tracks
            // This prevents false positive diffs when a playlist contains tracks not in TagDeck's DB.
            let all_track_pids = db.get_all_itunes_pids().map_err(|e| e.to_string())?;

            // Build a set of persistent IDs from Music.app for deletion detection
            let music_pids: std::collections::HashSet<String> = music_playlists.iter()
                .map(|p| p.persistent_id.clone())
                .collect();

            // Detect deleted playlists (in DB but not in Music.app)
            // Only synced playlists are eligible — sync-disabled ones are independent.
            let deleted_pids: Vec<String> = db_snapshot.iter()
                .filter(|(pid, (_name, _is_folder, _parent, _tracks, sync_enabled))| {
                    *sync_enabled && !music_pids.contains(*pid)
                })
                .map(|(pid, _)| pid.clone())
                .collect();

            if !deleted_pids.is_empty() {
                match db.remove_playlists_by_persistent_ids(&deleted_pids) {
                    Ok(names) => {
                        let count = names.len();
                        let msg = if count <= 5 {
                            format!("Removed {} deleted playlists: {}", count, names.join(", "))
                        } else {
                            format!("Removed {} deleted playlists", count)
                        };
                        println!("{}", msg);
                        app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);
                        playlist_changes += count;
                    },
                    Err(e) => {
                        let msg = format!("DB Error removing deleted playlists: {}", e);
                        app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                    }
                }
            }

            // Detect added or changed playlists
            for mp in &music_playlists {
                // Filter the track IDs from Music.app to only represent tracks we know about locally.
                // Otherwise, a single missing track causes infinite sync loops.
                // Also deduplicate: Music.app can have the same track multiple times in a playlist,
                // but our DB schema uses PRIMARY KEY (playlist_id, track_id) which prevents duplicates.
                // Without dedup, the diff sees more tracks from Music.app than the DB can store,
                // causing infinite phantom syncs.
                let mut seen = std::collections::HashSet::new();
                let filtered_track_ids: Vec<String> = mp.track_ids.iter()
                    .filter(|tid| all_track_pids.contains(*tid))
                    .filter(|tid| seen.insert((*tid).clone()))
                    .cloned()
                    .collect();

                let needs_upsert = match db_snapshot.get(&mp.persistent_id) {
                    None => true, // New playlist from Music.app
                    Some((_db_name, _db_is_folder, _db_parent_pid, _db_track_ids, sync_enabled)) => {
                        // Skip playlists whose per-playlist sync is off
                        if !sync_enabled {
                            false
                        } else {
                            let (db_name, db_is_folder, db_parent_pid, db_track_ids, _) =
                                db_snapshot.get(&mp.persistent_id).unwrap();
                            // Compare track membership using sorted lists to avoid false
                            // positives caused by Music.app returning tracks in a
                            // non-deterministic order (current UI sort, etc.).
                            let mut sorted_filtered = filtered_track_ids.clone();
                            sorted_filtered.sort();
                            let mut sorted_db = db_track_ids.clone();
                            sorted_db.sort();

                            // Check if any field changed
                            db_name != &mp.name
                                || db_is_folder != &mp.is_folder
                                || db_parent_pid != &mp.parent_persistent_id
                                || sorted_db != sorted_filtered
                        }
                    }
                };
                
                if needs_upsert {
                    // Use the filtered track IDs for the DB update too, 
                    // although DB insert logic does this via JOIN anyway.
                    // Doing it here ensures the diff logic matches the insert output.
                    let playlist = Playlist {
                        id: 0,
                        persistent_id: mp.persistent_id.clone(),
                        parent_persistent_id: mp.parent_persistent_id.clone(),
                        name: mp.name.clone(),
                        is_folder: mp.is_folder,
                        track_ids: Some(filtered_track_ids),
                        origin: "itunes".to_string(),
                        itunes_sync_enabled: false,
                        description: None,
                        color: None,
                        sort_position: 0,
                        created_at: 0,
                        updated_at: 0,
                        spotify_playlist_id: None,
                        spotify_snapshot_id: None,
                    };
                    if let Err(e) = db.insert_playlist(&playlist) {
                        let msg = format!("DB Error upserting playlist {}: {}", mp.name, e);
                        app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                    } else {
                        playlist_changes += 1;
                        if playlist_changes <= 10 {
                            let detail = format!("Playlist synced: \"{}\"", mp.name);
                            println!("{}", detail);
                            app.state::<crate::logging::LogState>().add_log("INFO", &detail, &app);
                        }
                    }
                }
            }

            let pl_msg = format!("Playlist diff found {} changes", playlist_changes);
            println!("{}", pl_msg);
            app.state::<crate::logging::LogState>().add_log("INFO", &pl_msg, &app);
        }
        Err(e) => {
            let msg = format!("Playlist snapshot diff failed (non-fatal): {}", e);
            eprintln!("{}", msg);
            app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
        }
    }

    let complete_msg = format!("Sync complete. {} tracks updated, {} added, {} unlinked, {} playlist events, {} pending removal(s), {} conflict(s) skipped.",
        total_updated - tracks_added - tracks_unlinked, tracks_added, tracks_unlinked, playlist_changes, pending_removals.len(), conflicts_skipped);
    println!("{}", complete_msg);
    app.state::<crate::logging::LogState>().add_log("INFO", &complete_msg, &app);

    // Spotify merge-on-purchase: newly-synced local tracks may complete a
    // ghost. Ids aren't threaded through the phases above, so approximate
    // "new in this pass" via date_added >= since_timestamp.
    if tracks_added > 0 {
        let new_ids = {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            db.get_local_track_ids_added_since(since_timestamp).unwrap_or_default()
        };
        if !new_ids.is_empty() {
            let _ = crate::spotify::merge::process_new_local_tracks(&state.db, &app, &new_ids);
        }
    }

    // Sum all changes so frontend triggers refresh if ANY change occurred (metadata, rating, or playlist)
    Ok(SyncResult { tracks_updated: total_updated, tracks_added, tracks_unlinked, playlists_updated: playlist_changes, pending_removals, conflicts_skipped })
}

#[tauri::command]
pub async fn get_playlists(state: State<'_, AppState>) -> Result<Vec<crate::models::Playlist>, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.get_playlists().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_playlist(
    name: String,
    parent_id: Option<i64>,
    is_folder: bool,
    state: State<'_, AppState>,
) -> Result<crate::models::Playlist, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;

    // Resolve parent persistent_id if parent_id is provided
    let parent_persistent_id = if let Some(pid) = parent_id {
        Some(db.get_playlist_persistent_id(pid).map_err(|e| e.to_string())?)
    } else {
        None
    };

    // Generate a unique persistent_id for TagDeck-native playlists
    let persistent_id = format!("TD-{}", uuid_v4_simple());

    db.create_playlist(
        &name,
        parent_persistent_id.as_deref(),
        is_folder,
        &persistent_id,
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_playlist(
    app: tauri::AppHandle,
    id: i64,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.rename_playlist(id, &name).map_err(|e| e.to_string())?;

    // If this playlist syncs with iTunes, also rename in Music.app — only when
    // the sync mode allows pushing TagDeck edits back to Music.app
    let sync_enabled = db.get_playlist_sync_enabled(id).unwrap_or(false);
    let mode = LibraryConfig::sync_mode(&db);
    if sync_enabled && mode.push_enabled() {
        let pid = db.get_playlist_persistent_id(id).map_err(|e| e.to_string())?;
        drop(db); // Release lock before AppleScript call
        if let Err(e) = crate::apple_music::rename_playlist_in_music(&pid, &name) {
            let msg = format!("Warning: Failed to rename playlist in Music.app: {}", e);
            app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_playlist(
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    // Safety: We never delete playlists from Music.app, only from TagDeck's DB
    db.delete_playlist(id).map_err(|e| e.to_string())
}

/// Toggles per-playlist iTunes sync. Disabling just flips the flag — the
/// Music.app copy is left alone, TagDeck simply stops reading from or writing
/// to it. Enabling verifies the playlist exists in Music.app and, if it
/// doesn't (TagDeck-native, or deleted from Music while unsynced), creates it
/// there, pushes the linked tracks, and adopts the new Music persistent ID.
/// Returns the playlist's (possibly new) persistent ID.
#[tauri::command]
pub async fn set_playlist_sync(
    app: tauri::AppHandle,
    playlist_id: i64,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (pid, name, is_folder) = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.get_playlist_basic(playlist_id).map_err(|e| e.to_string())?
    };

    if !enabled {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.set_playlist_sync_enabled(playlist_id, false).map_err(|e| e.to_string())?;
        let msg = format!("Stopped syncing playlist \"{}\" with iTunes", name);
        app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);
        return Ok(pid);
    }

    if is_folder {
        return Err("Folders can't be synced to iTunes yet — sync the playlists inside them individually.".to_string());
    }
    if !crate::apple_music::is_apple_music_available() {
        return Err("Music.app is not available on this system.".to_string());
    }

    let exists = crate::apple_music::playlist_exists_in_music(&pid)
        .map_err(|e| format!("Couldn't check Music.app for this playlist: {}", e))?;

    let final_pid = if exists {
        pid
    } else {
        // The playlist has no Music.app counterpart, so enabling sync means
        // creating one — that's a push, which the mode must allow.
        let mode = {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            LibraryConfig::sync_mode(&db)
        };
        if !mode.push_enabled() {
            return Err("This playlist doesn't exist in Music.app yet. Turn on Two-way sync to create it there.".to_string());
        }

        let new_pid = crate::apple_music::create_playlist_in_music(&name)
            .map_err(|e| format!("Failed to create playlist in Music.app: {}", e))?;

        let track_pids = {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            db.get_playlist_linked_track_pids(playlist_id).map_err(|e| e.to_string())?
        };
        for tpid in &track_pids {
            if let Err(e) = add_track_to_playlist(tpid, &new_pid) {
                let msg = format!("Failed to add track {} to new Music.app playlist: {}", tpid, e);
                app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
            }
        }

        {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            db.relink_playlist_persistent_id(playlist_id, &new_pid).map_err(|e| e.to_string())?;
        }

        let msg = format!(
            "Created playlist \"{}\" in Music.app with {} linked track(s)",
            name,
            track_pids.len()
        );
        app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);
        new_pid
    };

    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.set_playlist_sync_enabled(playlist_id, true).map_err(|e| e.to_string())?;
    }
    let msg = format!("Playlist \"{}\" is now syncing with iTunes", name);
    app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);

    Ok(final_pid)
}

#[tauri::command]
pub async fn move_playlist(
    id: i64,
    new_parent_id: Option<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;

    let new_parent_persistent_id = if let Some(pid) = new_parent_id {
        Some(db.get_playlist_persistent_id(pid).map_err(|e| e.to_string())?)
    } else {
        None
    };

    db.move_playlist(id, new_parent_persistent_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn duplicate_playlist(
    id: i64,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<crate::models::Playlist, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    let persistent_id = format!("TD-{}", uuid_v4_simple());
    db.duplicate_playlist(id, &new_name, &persistent_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_sibling_playlists(
    ordered_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.reorder_sibling_playlists(&ordered_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_playlist_metadata(
    id: i64,
    description: Option<String>,
    color: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.update_playlist_metadata(id, description.as_deref(), color.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_to_playlist(
    app: tauri::AppHandle,
    track_ids: Vec<i64>,
    playlist_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // 1. Get IDs
    let (playlist_pid, track_data, sync_enabled, mode) = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let pid = db.get_playlist_persistent_id(playlist_id)
            .map_err(|e| format!("Failed to get playlist: {}", e))?;

        // Spotify playlists are snapshot-owned — upsert_spotify_playlist deletes
        // and re-inserts membership on every sync, so a manual add here would
        // just be silently wiped by the next import. Reject outright instead
        // of pretending it worked.
        let origin = db.get_playlist_origin(playlist_id).unwrap_or_else(|_| "itunes".to_string());
        if origin == "spotify" {
            return Err("Spotify playlists are managed by sync — tracks can't be added manually".to_string());
        }

        let sync_enabled = db.get_playlist_sync_enabled(playlist_id).unwrap_or(false);

        let mut data = Vec::new();
        for tid in &track_ids {
            if db.get_track_persistent_id(*tid).is_ok() {
                // Ghosts (Spotify-only, no file) belong only inside Spotify
                // playlists — skip them here rather than let one join a
                // non-Spotify playlist it can never really live in.
                let is_ghost = db.get_track(*tid).ok().flatten().map(|t| t.is_ghost()).unwrap_or(false);
                if is_ghost {
                    continue;
                }
                data.push((*tid, db.get_track_itunes_pid(*tid).unwrap_or(None)));
            }
        }
        let mode = LibraryConfig::sync_mode(&db);
        (pid, data, sync_enabled, mode)
    };

    let valid_track_ids: Vec<i64> = track_data.iter().map(|(t, _)| *t).collect();

    // 2. Apple Music Sync (only for synced playlists, linked tracks, and
    // when the sync mode allows pushing TagDeck edits back to Music.app)
    if sync_enabled && mode.push_enabled() {
        for (_, itunes_pid) in &track_data {
            if let Some(pid) = itunes_pid {
                if let Err(e) = add_track_to_playlist(pid, &playlist_pid) {
                     let msg = format!("Failed to add track {} to playlist: {}", pid, e);
                     app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                }
            }
        }
    }

    // 3. Local DB Sync
    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        for tid in &valid_track_ids {
            if let Err(e) = db.add_track_to_playlist_db(playlist_id, *tid) {
                 let msg = format!("Failed to update local playlist: {}", e);
                 app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
            }
        }
    }

    // 4. Push Undo Action
    if !track_data.is_empty() {
        let undo_tracks: Vec<TrackRef> = track_data.iter().map(|(id, itunes_pid)| TrackRef {
            id: *id,
            // Undo uses this only for Music.app write-back; empty = unlinked, skipped
            persistent_id: itunes_pid.clone().unwrap_or_default(),
        }).collect();

        if let Ok(mut stack) = state.undo_stack.lock() {
            stack.push(Action::AddToPlaylist {
                playlist_id,
                playlist_persistent_id: playlist_pid.clone(),
                tracks: undo_tracks,
            });
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn remove_from_playlist(
    app: tauri::AppHandle,
    track_ids: Vec<i64>,
    playlist_id: i64,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let (playlist_pid, track_data, sync_enabled, mode) = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let pid = db.get_playlist_persistent_id(playlist_id)
            .map_err(|e| format!("Failed to get playlist: {}", e))?;
        let sync_enabled = db.get_playlist_sync_enabled(playlist_id).unwrap_or(false);
        let mut data = Vec::new();
        for tid in &track_ids {
            if db.get_track_persistent_id(*tid).is_ok() {
                data.push((*tid, db.get_track_itunes_pid(*tid).unwrap_or(None)));
            }
        }
        let mode = LibraryConfig::sync_mode(&db);
        (pid, data, sync_enabled, mode)
    };

    // Remove from Apple Music (only for synced playlists, linked tracks,
    // and when the sync mode allows pushing TagDeck edits back to Music.app)
    if sync_enabled && mode.push_enabled() {
        for (_, itunes_pid) in &track_data {
            if let Some(tpid) = itunes_pid {
                if let Err(e) = apple_remove_from_playlist(tpid, &playlist_pid) {
                    let msg = format!("Failed to remove track from playlist in Music.app: {}", e);
                    app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
                }
            }
        }
    }

    // Remove from local DB
    let removed = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let tids: Vec<i64> = track_data.iter().map(|(id, _)| *id).collect();
        db.remove_tracks_from_playlist(playlist_id, &tids)
            .map_err(|e| e.to_string())?;
        tids.len()
    };

    Ok(removed)
}

#[tauri::command]
pub async fn reorder_playlist_tracks(
    app: tauri::AppHandle,
    playlist_id: i64,
    ordered_track_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // 1. Get persistent IDs for the playlist and all tracks in order
    let (playlist_pid, track_pids, sync_enabled, mode) = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let ppid = db.get_playlist_persistent_id(playlist_id)
            .map_err(|e| format!("Failed to get playlist: {}", e))?;
        let sync_enabled = db.get_playlist_sync_enabled(playlist_id).unwrap_or(false);
        let mut pids = Vec::new();
        for tid in &ordered_track_ids {
            // Only linked tracks exist in Music.app's copy of the playlist
            if let Ok(Some(tpid)) = db.get_track_itunes_pid(*tid) {
                pids.push(tpid);
            }
        }
        (ppid, pids, sync_enabled, LibraryConfig::sync_mode(&db))
    };

    // 2. Update local DB
    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.reorder_playlist_tracks(playlist_id, &ordered_track_ids)
            .map_err(|e| e.to_string())?;
    }

    // 3. Sync to Apple Music (in background — don't block the UI), only for
    // synced playlists and when the sync mode allows pushing TagDeck edits back
    if sync_enabled && mode.push_enabled() {
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::apple_music::reorder_playlist(&playlist_pid, &track_pids) {
                let msg = format!("Failed to reorder playlist in Music.app: {}", e);
                eprintln!("{}", msg);
                app_handle.state::<crate::logging::LogState>().add_log("WARN", &msg, &app_handle);
            }
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn update_rating(
    app: tauri::AppHandle,
    track_id: i64,
    rating: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;

    // 1. Get iTunes link
    let itunes_pid = db.get_track_itunes_pid(track_id).map_err(|e| e.to_string())?;

    // 2. Update Music.app (linked tracks only, and only when the sync mode
    // allows pushing TagDeck edits back to Music.app)
    let push_enabled = LibraryConfig::sync_mode(&db).push_enabled();
    if push_enabled {
        if let Some(pid) = &itunes_pid {
            if let Err(e) = update_track_rating(pid, rating) {
                let msg = format!("Failed to update Apple Music rating: {}", e);
                app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                return Err(msg);
            }
        }
    }

    // 3. Update Local DB
    db.update_track_rating(track_id, rating).map_err(|e| e.to_string())?;

    // Push is disabled for this edit, so it diverges from Music.app - flag for later reconciliation.
    // Ghosts have no Music.app link to diverge from, so they're never dirty-marked.
    if !push_enabled {
        let is_ghost = db.get_track(track_id).ok().flatten().map(|t| t.is_ghost()).unwrap_or(false);
        if !is_ghost {
            if let Err(e) = db.mark_tracks_dirty(&[track_id]) {
                let msg = format!("Failed to mark track dirty: {}", e);
                app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
            }
        }
    }

    Ok(())
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
        // Ghost tracks (Spotify, no file) must never be marked missing — a ghost
        // play attempt fails at readFile("") and would otherwise get wrongly
        // flagged with no automatic recovery. missing:false is still allowed
        // through below so a wrongly-flagged ghost can be healed.
        let is_ghost = db.get_track(id).ok().flatten().map(|t| t.is_ghost()).unwrap_or(false);
        if is_ghost {
            return Ok(());
        }

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
    let track = db.get_track(id).map_err(|e| e.to_string())?.ok_or("Track not found")?;
    drop(db); // Release lock before doing IO

    if track.is_ghost() {
        return Ok(None);
    }

    get_artwork(&track.file_path).map_err(|e| e.to_string())
}

// Tag Group Commands

#[tauri::command]
pub async fn get_tag_groups(state: State<'_, AppState>) -> Result<Vec<crate::models::TagGroup>, String> {
    state.db.lock().map_err(|_| "Failed to lock DB".to_string())?
        .get_tag_groups().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_tag_group(name: String, state: State<'_, AppState>) -> Result<crate::models::TagGroup, String> {
    state.db.lock().map_err(|_| "Failed to lock DB".to_string())?
        .create_tag_group(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_tag_group(id: i64, name: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db.lock().map_err(|_| "Failed to lock DB".to_string())?
        .update_tag_group(id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_tag_group(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    state.db.lock().map_err(|_| "Failed to lock DB".to_string())?
        .delete_tag_group(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_tag_group(tag_id: i64, group_id: Option<i64>, state: State<'_, AppState>) -> Result<(), String> {
    state.db.lock().map_err(|_| "Failed to lock DB".to_string())?
        .set_tag_group(tag_id, group_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_tag_groups(ordered_ids: Vec<i64>, state: State<'_, AppState>) -> Result<(), String> {
    state.db.lock().map_err(|_| "Failed to lock DB".to_string())?
        .reorder_tag_groups(ordered_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_tags(state: State<'_, AppState>) -> Result<Vec<crate::models::Tag>, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.sync_tags().map_err(|e| e.to_string())?;
    db.get_all_tags().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_tag(tag_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    state.db.lock().map_err(|_| "Failed to lock DB".to_string())?
        .delete_tag(tag_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_track_info(
    app: tauri::AppHandle,
    track_id: i64,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    bpm: Option<i64>,
    comment: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    let mode = LibraryConfig::sync_mode(&db);

    // 1. Get track for persistent_id, file_path, and old values
    let track = db.get_track(track_id).map_err(|e| e.to_string())?
        .ok_or("Track not found")?;

    if track.is_ghost() {
        return Err("Spotify tracks can't be edited until the file is purchased and merged".into());
    }

    // 2. Build the new comment_raw if the user edited the comment portion.
    //    comment_raw format: "user comment && tag1; tag2; tag3"
    //    We only replace the left side; tags (right side) are preserved.
    let new_comment_raw = comment.as_ref().map(|new_user_comment| {
        let existing = track.comment_raw.as_deref().unwrap_or("");
        let tag_part = if let Some(idx) = existing.find(" && ") {
            Some(&existing[idx..]) // " && tag1; tag2"
        } else {
            None
        };
        if let Some(tags) = tag_part {
            if new_user_comment.is_empty() {
                // User cleared comment but tags remain — keep " && tags" with leading &&
                format!("{}", &tags[1..]) // "&&  tag1; tag2" -> skip the leading space
            } else {
                format!("{}{}", new_user_comment, tags)
            }
        } else {
            new_user_comment.clone()
        }
    });

    // 3. Build undo state (capture old values for fields that are being changed)
    let undo_state = crate::undo::TrackInfoState {
        id: track_id,
        // Undo uses this only for Music.app write-back; empty = unlinked, skipped
        persistent_id: track.itunes_pid.clone().unwrap_or_default(),
        file_path: track.file_path.clone(),
        old_title: if title.is_some() { track.title.clone() } else { None },
        new_title: title.clone(),
        old_artist: if artist.is_some() { track.artist.clone() } else { None },
        new_artist: artist.clone(),
        old_album: if album.is_some() { track.album.clone() } else { None },
        new_album: album.clone(),
        old_bpm: if bpm.is_some() { Some(track.bpm as i64) } else { None },
        new_bpm: bpm,
        old_comment_raw: if new_comment_raw.is_some() { track.comment_raw.clone() } else { None },
        new_comment_raw: new_comment_raw.clone(),
    };

    // 4. Update local DB
    db.update_track_info(
        track_id,
        title.as_deref(),
        artist.as_deref(),
        album.as_deref(),
        bpm,
        new_comment_raw.as_deref(),
    ).map_err(|e| e.to_string())?;

    drop(db); // Release lock before IO

    // 5. Write to file metadata (title/artist/album/bpm)
    if title.is_some() || artist.is_some() || album.is_some() || bpm.is_some() {
        if let Err(e) = write_track_info(
            &track.file_path,
            title.as_deref(),
            artist.as_deref(),
            album.as_deref(),
            bpm,
        ) {
            let msg = format!("Warning: Failed to write track info to file: {}", e);
            app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
            eprintln!("{}", msg);
        }
    }

    // 5b. Write comment to file if changed
    if let Some(ref new_cr) = new_comment_raw {
        if let Err(e) = write_tags_to_file(&track.file_path, new_cr) {
            let msg = format!("Warning: Failed to write comment to file: {}", e);
            app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
            eprintln!("{}", msg);
        }
    }

    // 6. Touch file so Finder/Rekordbox notices
    if let Err(e) = touch_file(&track.file_path) {
        eprintln!("Warning: Failed to touch file: {}", e);
    }

    // 7. Update Apple Music (linked tracks only, and only when the sync mode
    // allows pushing TagDeck edits back to Music.app)
    if mode.push_enabled() {
        if let Some(itunes_pid) = &track.itunes_pid {
            if title.is_some() || artist.is_some() || album.is_some() || bpm.is_some() {
                if let Err(e) = apple_update_track_info(
                    itunes_pid,
                    title.as_deref(),
                    artist.as_deref(),
                    album.as_deref(),
                    bpm,
                ) {
                    let msg = format!("Warning: Failed to update Apple Music: {}", e);
                    app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
                    eprintln!("{}", msg);
                }
            }

            // 7b. Update comment in Apple Music if changed
            if let Some(ref new_cr) = new_comment_raw {
                if let Err(e) = update_track_comment(itunes_pid, new_cr) {
                    let msg = format!("Warning: Failed to update Apple Music comment: {}", e);
                    app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
                    eprintln!("{}", msg);
                }
            }
        }
    } else {
        // Push is disabled, so this edit diverges from Music.app - flag for later reconciliation.
        if let Ok(db) = state.db.lock() {
            if let Err(e) = db.mark_tracks_dirty(&[track_id]) {
                let msg = format!("Warning: Failed to mark track dirty: {}", e);
                app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
                eprintln!("{}", msg);
            }
        }
    }

    // 8. Push Undo
    if let Ok(mut stack) = state.undo_stack.lock() {
        stack.push(crate::undo::Action::UpdateTrackInfo { track: undo_state });
    }

    Ok(())
}

#[derive(serde::Serialize)]
pub struct PlaylistInfo {
    pub id: i64,
    pub persistent_id: String,
    pub name: String,
}

#[tauri::command]
pub async fn get_playlists_for_track(track_id: i64, state: State<'_, AppState>) -> Result<Vec<PlaylistInfo>, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    let rows = db.get_playlists_for_track(track_id).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(id, persistent_id, name)| PlaylistInfo { id, persistent_id, name }).collect())
}

#[tauri::command]
pub async fn copy_playlist_memberships(
    app: tauri::AppHandle,
    target_track_id: i64,
    source_track_id: i64,
    playlist_ids: Vec<i64>,
    combine_play_counts: bool,
    remove_source: bool,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (target_pid, source_pid, playlist_data, mode) = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.get_track_persistent_id(target_track_id).map_err(|e| format!("Target track not found: {}", e))?;
        db.get_track_persistent_id(source_track_id).map_err(|e| format!("Source track not found: {}", e))?;
        // iTunes links — Apple Music operations are skipped for unlinked tracks
        let t_pid = db.get_track_itunes_pid(target_track_id).unwrap_or(None);
        let s_pid = db.get_track_itunes_pid(source_track_id).unwrap_or(None);

        // Same origin/ghost guards as add_to_playlist, applied per playlist in
        // this batch-over-playlists loop (one target track, many playlists):
        //   - a playlist whose origin is Spotify never accepts a manual add —
        //     its membership is snapshot-owned and the next sync would wipe it;
        //   - a ghost target track belongs only inside Spotify playlists, so it
        //     is skipped for every non-Spotify playlist in the selection.
        // Judgment call: skip-in-loop rather than hard-fail the whole request,
        // so a mixed selection (some valid targets, some not) still copies to
        // whatever IS valid — that degrades more gracefully than an all-or-
        // nothing error. The one exception is when EVERY playlist was skipped
        // for being Spotify-origin: silently returning "Added to 0 playlists"
        // would read as success while hiding the real (sync-ownership) reason,
        // so that case surfaces the same explicit rejection add_to_playlist
        // uses. A target-is-ghost-only wipeout is left to report 0 added,
        // mirroring add_to_playlist's silent skip-the-batch behavior for ghosts.
        let target_is_ghost = db.get_track(target_track_id).ok().flatten().map(|t| t.is_ghost()).unwrap_or(false);
        let mut pdata = Vec::new();
        let mut skipped_spotify_origin = false;
        for pid in &playlist_ids {
            if let Ok(ppid) = db.get_playlist_persistent_id(*pid) {
                let origin = db.get_playlist_origin(*pid).unwrap_or_else(|_| "itunes".to_string());
                if origin == "spotify" {
                    skipped_spotify_origin = true;
                    continue;
                }
                if target_is_ghost {
                    continue;
                }
                pdata.push((*pid, ppid));
            }
        }
        if pdata.is_empty() && skipped_spotify_origin {
            return Err("Spotify playlists are managed by sync — tracks can't be added manually".to_string());
        }
        (t_pid, s_pid, pdata, LibraryConfig::sync_mode(&db))
    };

    let mut added_count = 0;

    // 1. Add target track to each selected playlist (Apple Music + DB)
    for (db_id, ppid) in &playlist_data {
        // Apple Music (only when the sync mode allows pushing TagDeck edits back)
        if mode.push_enabled() {
            if let Some(tpid) = &target_pid {
                if let Err(e) = add_track_to_playlist(tpid, ppid) {
                    let msg = format!("Failed to add track to playlist in Music.app: {}", e);
                    app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                }
            }
        }

        // Local DB
        {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            if let Err(e) = db.add_track_to_playlist_db(*db_id, target_track_id) {
                let msg = format!("Failed to add track to playlist in DB: {}", e);
                app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
            }
        }
        added_count += 1;
    }

    // 2. Combine play counts if requested (needs both tracks linked to Music.app,
    // and the sync mode to allow pushing the combined count back to Music.app)
    if combine_play_counts && mode.push_enabled() {
        if let (Some(source_pid), Some(target_pid)) = (&source_pid, &target_pid) {
        match get_play_count(source_pid) {
            Ok(source_count) => {
                match get_play_count(target_pid) {
                    Ok(target_count) => {
                        let combined = source_count + target_count;
                        if let Err(e) = set_play_count(target_pid, combined) {
                            let msg = format!("Failed to set combined play count: {}", e);
                            app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
                        } else {
                            let msg = format!("Combined play counts: {} + {} = {}", source_count, target_count, combined);
                            app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);
                        }
                    }
                    Err(e) => {
                        let msg = format!("Failed to get target play count: {}", e);
                        app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
                    }
                }
            }
            Err(e) => {
                let msg = format!("Failed to get source play count: {}", e);
                app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
            }
        }
        } else {
            app.state::<crate::logging::LogState>().add_log("WARN", "Skipped play-count combine: track(s) not linked to Music.app", &app);
        }
    }

    // 3. Remove source track from selected playlists if requested
    if remove_source {
        for (db_id, ppid) in &playlist_data {
            // Apple Music (linked tracks only, and only when the sync mode allows
            // pushing TagDeck edits back to Music.app)
            if mode.push_enabled() {
                if let Some(spid) = &source_pid {
                    if let Err(e) = apple_remove_from_playlist(spid, ppid) {
                        let msg = format!("Failed to remove source from playlist in Music.app: {}", e);
                        app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                    }
                }
            }

            // Local DB
            {
                let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
                if let Err(e) = db.remove_track_from_playlist(*db_id, source_track_id) {
                    let msg = format!("Failed to remove source from playlist in DB: {}", e);
                    app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
                }
            }
        }
    }

    Ok(format!("Added to {} playlist{}", added_count, if added_count != 1 { "s" } else { "" }))
}

// ---------------------------------------------------------------------------
// File Management Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_library_config(state: State<'_, AppState>) -> Result<LibraryConfig, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    LibraryConfig::load(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_library_config(
    config: LibraryConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    config.save(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_apple_music_available() -> bool {
    crate::apple_music::is_apple_music_available()
}

#[tauri::command]
pub async fn import_files(
    app: tauri::AppHandle,
    file_paths: Vec<String>,
    target_playlist_id: Option<i64>,
    state: State<'_, AppState>,
) -> Result<ImportSummary, String> {
    // Load config once (used for standalone path)
    let config = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        LibraryConfig::load(&db).map_err(|e| e.to_string())?
    };

    // Only route through Apple Music when Two-way sync is on — in Off/Import-only
    // modes the standalone file_manager path handles imports even if Music.app
    // is installed, since we must not push newly imported files to it.
    let apple_music_available = config.sync_mode == SyncMode::TwoWay
        && crate::apple_music::is_apple_music_available();

    // Resolve target playlist info once (sync flag + persistent ID) so we can sync to Apple Music after each import
    let target_playlist_info: Option<(bool, String)> = if let Some(pid) = target_playlist_id {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let sync_enabled = db.get_playlist_sync_enabled(pid).unwrap_or(false);
        let ppid = db.get_playlist_persistent_id(pid).unwrap_or_default();
        Some((sync_enabled, ppid))
    } else {
        None
    };

    // Recursively collect all audio files from the provided paths
    let audio_files = collect_audio_files(&file_paths);

    let total = audio_files.len();
    let mut results = Vec::with_capacity(total);
    let mut imported_track_ids: Vec<i64> = Vec::new();

    for source in &audio_files {
        let source_str = source.to_string_lossy().to_string();

        // Check supported format
        if !is_supported_audio_file(source) {
            results.push(ImportResult {
                success: false,
                original_path: source_str,
                new_path: None,
                error: Some("Unsupported file format".to_string()),
            });
            continue;
        }

        // Duplicate detection: same path/original path, or same file contents
        // under a different path (hash catches re-imports of moved/copied files).
        let file_hash = crate::file_manager::hash_file(source).ok();
        {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            let existing = match db.find_track_by_path(&source_str) {
                Ok(Some(id)) => Some(id),
                _ => file_hash
                    .as_deref()
                    .and_then(|h| db.find_track_by_hash(h).ok().flatten()),
            };
            if let Some(existing_id) = existing {
                // Still add existing track to the target playlist if requested
                if target_playlist_id.is_some() {
                    imported_track_ids.push(existing_id);
                }
                results.push(ImportResult {
                    success: false,
                    original_path: source_str,
                    new_path: None,
                    error: Some("Already in library".to_string()),
                });
                continue;
            }
        }

        if apple_music_available {
            // ── Apple Music path ──────────────────────────────────────────────
            // Check if Apple Music already has this file to prevent duplicates on re-import.
            // This handles the case where the file was previously imported and moved to Apple's
            // organized folder — the DB check above only matches the source path.
            let existing_pid = crate::apple_music::find_track_in_music_by_path(&source_str)
                .unwrap_or(None);

            let apple_pid_result = if let Some(pid) = existing_pid {
                app.state::<crate::logging::LogState>().add_log(
                    "INFO",
                    &format!("File already in Apple Music library, skipping re-add: {}", source_str),
                    &app,
                );
                Ok(pid)
            } else {
                crate::apple_music::add_file_to_music_library(&source_str)
            };

            match apple_pid_result {
                Ok(apple_pid) => {
                    // Fetch the full track data back (gets Apple's final file path)
                    match crate::apple_music::get_tracks_by_persistent_ids(&[apple_pid.clone()]) {
                        Ok(apple_tracks) if !apple_tracks.is_empty() => {
                            let apple_track = &apple_tracks[0];
                            let track_id = {
                                let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
                                db.insert_track(apple_track).map_err(|e| e.to_string())?;
                                let tid = db.get_track_id_by_persistent_id(&apple_pid)
                                    .map_err(|e| e.to_string())?
                                    .unwrap_or(0);
                                if tid > 0 {
                                    if let Some(h) = file_hash.as_deref() {
                                        let _ = db.set_file_hash(tid, h);
                                    }
                                }
                                tid
                            };
                            // Add to Apple Music playlist if the target playlist syncs with iTunes
                            if let Some((sync_enabled, ref ppid)) = target_playlist_info {
                                if sync_enabled && !ppid.is_empty() {
                                    if let Err(e) = crate::apple_music::add_track_to_playlist(&apple_pid, ppid) {
                                        let msg = format!("Failed to add track to Apple Music playlist: {}", e);
                                        app.state::<crate::logging::LogState>().add_log("WARN", &msg, &app);
                                    }
                                }
                            }
                            if track_id > 0 {
                                imported_track_ids.push(track_id);
                            }
                            results.push(ImportResult {
                                success: true,
                                original_path: source_str.clone(),
                                new_path: Some(apple_track.file_path.clone()),
                                error: None,
                            });
                            app.state::<crate::logging::LogState>().add_log(
                                "INFO",
                                &format!("Imported via Apple Music: {}", source_str),
                                &app,
                            );
                        }
                        Ok(_) => {
                            results.push(ImportResult {
                                success: false,
                                original_path: source_str,
                                new_path: None,
                                error: Some("Added to Apple Music but could not retrieve track data".to_string()),
                            });
                        }
                        Err(e) => {
                            results.push(ImportResult {
                                success: false,
                                original_path: source_str,
                                new_path: None,
                                error: Some(format!("Failed to fetch track from Apple Music: {}", e)),
                            });
                        }
                    }
                }
                Err(e) => {
                    results.push(ImportResult {
                        success: false,
                        original_path: source_str,
                        new_path: None,
                        error: Some(format!("Failed to add to Apple Music: {}", e)),
                    });
                }
            }
        } else {
            // ── Standalone path ───────────────────────────────────────────────
            // Apple Music is not present. TagDeck manages the file itself.

            // Read metadata
            let meta = match crate::metadata::read_full_metadata(source) {
                Ok(m) => m,
                Err(e) => {
                    results.push(ImportResult {
                        success: false,
                        original_path: source_str,
                        new_path: None,
                        error: Some(format!("Failed to read metadata: {}", e)),
                    });
                    continue;
                }
            };

            // Copy / move / in-place based on LibraryConfig
            let dest = match import_file(source, &config, &meta) {
                Ok(p) => p,
                Err(e) => {
                    results.push(ImportResult {
                        success: false,
                        original_path: source_str,
                        new_path: None,
                        error: Some(format!("Import failed: {}", e)),
                    });
                    continue;
                }
            };

            let dest_str = dest.to_string_lossy().to_string();
            let size_bytes = std::fs::metadata(&dest)
                .map(|m| m.len() as i64)
                .unwrap_or(0);
            let file_format = dest
                .extension()
                .and_then(|ext: &std::ffi::OsStr| ext.to_str())
                .unwrap_or("unknown")
                .to_uppercase();

            let persistent_id = format!("TD-{}", uuid_v4_simple());

            let track = crate::models::Track {
                id: 0,
                persistent_id: persistent_id.clone(),
                file_path: dest_str.clone(),
                artist: meta.artist.clone(),
                title: meta.title.clone(),
                album: meta.album.clone(),
                comment_raw: meta.comment.clone(),
                grouping_raw: meta.grouping.clone(),
                duration_secs: meta.duration_secs,
                format: file_format,
                size_bytes,
                bit_rate: meta.bit_rate,
                modified_date: 0,
                rating: 0,
                date_added: 0,
                bpm: meta.bpm.unwrap_or(0),
                missing: false,
                itunes_pid: None,
                unlinked_at: None,
                source: "local".to_string(),
                spotify_id: None,
            };

            let track_id = {
                let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
                db.insert_imported_track(&track, Some(&source_str), file_hash.as_deref())
                    .map_err(|e| e.to_string())?
            };

            imported_track_ids.push(track_id);

            results.push(ImportResult {
                success: true,
                original_path: source_str.clone(),
                new_path: Some(dest_str),
                error: None,
            });

            app.state::<crate::logging::LogState>().add_log(
                "INFO",
                &format!("Imported (standalone): {}", source_str),
                &app,
            );
        }
    }

    // Add to playlist if requested
    if let Some(playlist_id) = target_playlist_id {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        for tid in &imported_track_ids {
            let _ = db.add_track_to_playlist_db(playlist_id, *tid);
        }
    }

    // Sync tag index
    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let _ = db.sync_tags();
    }

    let imported = results.iter().filter(|r| r.success).count();
    let failed = results
        .iter()
        .filter(|r| {
            !r.success
                && r.error
                    .as_ref()
                    .map(|e: &String| !e.contains("Already in library"))
                    .unwrap_or(false)
        })
        .count();
    let skipped = results.len() - imported - failed;

    let summary_msg = format!(
        "Import complete: {} imported, {} skipped, {} failed (of {} total)",
        imported, skipped, failed, total
    );
    app.state::<crate::logging::LogState>().add_log("INFO", &summary_msg, &app);

    // Spotify merge-on-purchase: match new files against ghost tracks.
    if !imported_track_ids.is_empty() {
        let _ = crate::spotify::merge::process_new_local_tracks(&state.db, &app, &imported_track_ids);
    }

    Ok(ImportSummary {
        total,
        imported,
        skipped,
        failed,
        results,
        imported_track_ids: imported_track_ids.clone(),
    })
}

#[derive(serde::Serialize, Default)]
pub struct LibraryVerification {
    pub checked: usize,
    pub relocated: usize,
    pub marked_missing: usize,
    pub restored: usize,
}

/// Re-checks that every track's file still exists on disk. Files that moved
/// within the library root are relocated by filename (+ size when known),
/// vanished files are marked missing, and previously-missing tracks whose
/// files are back are restored. Triggered by the TagDeck-root watcher and
/// safe to run any time.
#[tauri::command]
pub async fn verify_library_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<LibraryVerification, String> {
    let (index, root_path) = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let index = db.get_track_file_index().map_err(|e| e.to_string())?;
        let root = LibraryConfig::load(&db).map_err(|e| e.to_string())?.root_path;
        (index, root)
    };

    let mut report = LibraryVerification { checked: index.len(), ..Default::default() };
    let mut to_restore: Vec<i64> = Vec::new();
    let mut gone: Vec<(i64, String, i64)> = Vec::new(); // (id, old_path, size)

    for (id, file_path, missing, _linked, size) in &index {
        // Ghost tracks (Spotify, no file yet) have no path to verify — skip,
        // or every ghost would be flagged missing.
        if file_path.is_empty() { continue; }
        let exists = std::path::Path::new(file_path).is_file();
        match (exists, missing) {
            (true, true) => to_restore.push(*id),
            (false, false) => gone.push((*id, file_path.clone(), *size)),
            _ => {}
        }
    }

    // Try to relocate vanished files: index the library root by filename once,
    // then match uniquely (disambiguating by stored size when available).
    let mut relocations: Vec<(i64, String)> = Vec::new();
    let mut newly_missing: Vec<i64> = Vec::new();
    if !gone.is_empty() {
        let mut by_name: std::collections::HashMap<String, Vec<std::path::PathBuf>> =
            std::collections::HashMap::new();
        for f in crate::file_manager::collect_audio_files(&[root_path.clone()]) {
            if let Some(name) = f.file_name().and_then(|n| n.to_str()) {
                by_name.entry(name.to_string()).or_default().push(f);
            }
        }

        for (id, old_path, size) in &gone {
            let name = std::path::Path::new(old_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            let candidates: Vec<&std::path::PathBuf> = by_name
                .get(name)
                .map(|v| {
                    v.iter()
                        .filter(|p| {
                            *size <= 0
                                || std::fs::metadata(p).map(|m| m.len() as i64 == *size).unwrap_or(false)
                        })
                        .collect()
                })
                .unwrap_or_default();

            if candidates.len() == 1 {
                relocations.push((*id, candidates[0].to_string_lossy().to_string()));
            } else {
                newly_missing.push(*id);
            }
        }
    }

    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        for id in &to_restore {
            if db.set_track_missing(*id, false).is_ok() {
                report.restored += 1;
            }
        }
        for (id, new_path) in &relocations {
            if db.update_track_path(*id, new_path).is_ok() {
                report.relocated += 1;
            }
        }
        for id in &newly_missing {
            if db.set_track_missing(*id, true).is_ok() {
                report.marked_missing += 1;
            }
        }
    }

    if report.relocated + report.marked_missing + report.restored > 0 {
        let msg = format!(
            "Library verification: {} relocated, {} marked missing, {} restored (of {} tracks)",
            report.relocated, report.marked_missing, report.restored, report.checked
        );
        app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);
    }

    Ok(report)
}

#[derive(serde::Serialize, Default)]
pub struct ConsolidationReport {
    pub total_candidates: usize,
    pub consolidated: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

/// Copies every TagDeck-managed track stored outside the library root into it
/// (organized by artist/album when that setting is on) and repoints the DB.
/// Originals are never deleted, and iTunes-linked tracks are left where
/// Music.app manages them.
#[tauri::command]
pub async fn consolidate_library(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ConsolidationReport, String> {
    let (index, config) = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let index = db.get_track_file_index().map_err(|e| e.to_string())?;
        let config = LibraryConfig::load(&db).map_err(|e| e.to_string())?;
        (index, config)
    };

    let root = std::path::PathBuf::from(&config.root_path);
    let candidates: Vec<(i64, String)> = index
        .into_iter()
        .filter(|(_id, path, missing, linked, _size)| {
            !missing && !linked && !std::path::Path::new(path).starts_with(&root)
        })
        .map(|(id, path, _, _, _)| (id, path))
        .collect();

    let mut report = ConsolidationReport { total_candidates: candidates.len(), ..Default::default() };
    const ERROR_CAP: usize = 10;

    for (id, source_str) in &candidates {
        // Ghost tracks (Spotify, no file yet) have nothing to consolidate.
        if source_str.is_empty() { continue; }
        let source = std::path::Path::new(source_str);
        if !source.is_file() {
            report.failed += 1;
            if report.errors.len() < ERROR_CAP {
                report.errors.push(format!("File not found: {}", source_str));
            }
            continue;
        }

        let filename = source.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        let dest = if config.organize_files {
            // Read tags from the file for organizing; fall back to Unknowns
            let meta = crate::metadata::read_full_metadata(source).ok();
            let m = meta.as_ref();
            crate::file_manager::generate_organized_path(
                &root,
                m.and_then(|m| m.artist.as_deref()),
                m.and_then(|m| m.album.as_deref()),
                m.and_then(|m| m.title.as_deref()),
                m.and_then(|m| m.track_number),
                filename,
                m.map(|m| m.is_compilation).unwrap_or(false),
            )
        } else {
            // Flat layout with collision counter
            let mut path = root.join(filename);
            let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
            let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("mp3");
            let mut counter: u32 = 2;
            while path.exists() {
                path = root.join(format!("{} {}.{}", stem, counter, ext));
                counter += 1;
                if counter > 1000 {
                    break;
                }
            }
            Ok(path)
        };

        let copy_result = dest.and_then(|dest| {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(source, &dest)?;
            Ok(dest)
        });

        match copy_result {
            Ok(dest) => {
                let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
                match db.consolidate_track_path(*id, &dest.to_string_lossy(), source_str) {
                    Ok(()) => report.consolidated += 1,
                    Err(e) => {
                        report.failed += 1;
                        if report.errors.len() < ERROR_CAP {
                            report.errors.push(format!("DB update failed for {}: {}", source_str, e));
                        }
                    }
                }
            }
            Err(e) => {
                report.failed += 1;
                if report.errors.len() < ERROR_CAP {
                    report.errors.push(format!("Copy failed for {}: {}", source_str, e));
                }
            }
        }
    }

    let msg = format!(
        "Consolidate Library: {} of {} external track(s) copied into {}, {} failed",
        report.consolidated, report.total_candidates, config.root_path, report.failed
    );
    app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);

    Ok(report)
}

#[derive(serde::Serialize, Default)]
pub struct MusicExportReport {
    pub total_candidates: usize,
    pub exported: usize,
    pub relinked: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

/// Exit path: adds every TagDeck-only (unlinked) track's file to Music.app
/// and stores the returned persistent ID as the link. Files Music.app
/// already has are linked without re-adding. Files are never moved by
/// TagDeck — Music.app applies its own copy/organize settings on add.
#[tauri::command]
pub async fn export_tracks_to_music(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<MusicExportReport, String> {
    if !crate::apple_music::is_apple_music_available() {
        return Err("Music.app not detected on this Mac.".to_string());
    }

    let candidates: Vec<(i64, String)> = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.get_unlinked_tracks().map_err(|e| e.to_string())?
    }
    .into_iter()
    .filter(|(_, _, missing)| !missing)
    .map(|(id, path, _)| (id, path))
    .collect();

    let mut report = MusicExportReport { total_candidates: candidates.len(), ..Default::default() };
    const ERROR_CAP: usize = 10;
    let fail = |report: &mut MusicExportReport, msg: String| {
        report.failed += 1;
        if report.errors.len() < ERROR_CAP {
            report.errors.push(msg);
        }
    };

    for (id, path) in &candidates {
        // Ghost tracks (Spotify, no file yet) have nothing to add to Music.app.
        if path.is_empty() { continue; }
        if !std::path::Path::new(path).is_file() {
            fail(&mut report, format!("File not found: {}", path));
            continue;
        }

        // Reuse an existing Music.app copy of this exact file rather than
        // adding a duplicate.
        let (pid, newly_added) = match crate::apple_music::find_track_in_music_by_path(path) {
            Ok(Some(existing_pid)) => (existing_pid, false),
            Ok(None) => match crate::apple_music::add_file_to_music_library(path) {
                Ok(new_pid) => (new_pid, true),
                Err(e) => {
                    fail(&mut report, format!("Music.app add failed for {}: {}", path, e));
                    continue;
                }
            },
            Err(e) => {
                fail(&mut report, format!("Music.app lookup failed for {}: {}", path, e));
                continue;
            }
        };

        let link_result = {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            db.link_track_itunes_pid(*id, &pid)
        };
        match link_result {
            Ok(()) => {
                if newly_added {
                    report.exported += 1;
                } else {
                    report.relinked += 1;
                }
            }
            Err(e) => fail(
                &mut report,
                format!("Link failed for {} (Music PID may belong to another track): {}", path, e),
            ),
        }
    }

    let msg = format!(
        "Export to Music.app: {} added, {} relinked, {} failed of {} candidate(s)",
        report.exported, report.relinked, report.failed, report.total_candidates
    );
    app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);

    Ok(report)
}

#[derive(serde::Serialize, Default)]
pub struct M3u8ExportReport {
    pub written: usize,
    pub skipped_missing: usize,
}

/// Writes an extended M3U8 (UTF-8, absolute paths) for a playlist.
#[tauri::command]
pub async fn export_playlist_m3u8(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    playlist_id: i64,
    dest_path: String,
) -> Result<M3u8ExportReport, String> {
    let (name, rows) = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let (_pid, name, is_folder) = db.get_playlist_basic(playlist_id).map_err(|e| e.to_string())?;
        if is_folder {
            return Err("Folders can't be exported as a playlist file.".to_string());
        }
        let rows = db.get_playlist_tracks_for_export(playlist_id).map_err(|e| e.to_string())?;
        (name, rows)
    };

    let mut report = M3u8ExportReport::default();
    let mut out = String::from("#EXTM3U\n");
    for (path, duration, artist, title, missing) in rows {
        // Ghost tracks (Spotify, no file yet) have nothing to export.
        if path.is_empty() { continue; }
        if missing {
            report.skipped_missing += 1;
            continue;
        }
        let display = match (artist, title) {
            (Some(a), Some(t)) => format!("{} - {}", a, t),
            (_, Some(t)) => t,
            _ => std::path::Path::new(&path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&path)
                .to_string(),
        };
        out.push_str(&format!("#EXTINF:{},{}\n{}\n", duration.round() as i64, display, path));
        report.written += 1;
    }

    std::fs::write(&dest_path, out)
        .map_err(|e| format!("Failed to write {}: {}", dest_path, e))?;

    let msg = format!(
        "Exported playlist '{}' to {} ({} track(s), {} missing skipped)",
        name, dest_path, report.written, report.skipped_missing
    );
    app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);

    Ok(report)
}

#[derive(serde::Serialize, Default)]
pub struct RekordboxExportReport {
    pub tracks: usize,
    pub playlists: usize,
    pub folders: usize,
    pub skipped_missing: usize,
}

/// Writes the full library (collection + playlist tree) as rekordbox.xml.
/// The destination is remembered so re-exports default to the same file —
/// Rekordbox is pointed at a fixed path in its preferences.
#[tauri::command]
pub async fn export_rekordbox_xml(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    dest_path: String,
) -> Result<RekordboxExportReport, String> {
    let (tracks, playlists) = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        // Ghost tracks (Spotify, no file yet) have nothing to export; drop them
        // before build_rekordbox_xml so they're excluded from both the
        // collection and any playlist membership (same as `missing` tracks).
        let tracks: Vec<Track> = db.get_all_tracks().map_err(|e| e.to_string())?
            .into_iter()
            .filter(|t| !t.is_ghost())
            .collect();
        let playlists = db
            .get_playlists()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|p| {
                let ids = db.get_playlist_track_ids(p.id).unwrap_or_default();
                (p, ids)
            })
            .collect::<Vec<_>>();
        (tracks, playlists)
    };

    let (xml, stats) =
        crate::rekordbox::build_rekordbox_xml(&tracks, &playlists, env!("CARGO_PKG_VERSION"));

    std::fs::write(&dest_path, xml)
        .map_err(|e| format!("Failed to write {}: {}", dest_path, e))?;

    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        if let Err(e) = db.set_config("rekordbox_xml_path", &dest_path) {
            eprintln!("Failed to remember rekordbox export path: {}", e);
        }
    }

    let msg = format!(
        "Rekordbox export: {} track(s), {} playlist(s) in {} folder(s) written to {} ({} missing skipped)",
        stats.tracks, stats.playlists, stats.folders, dest_path, stats.skipped_missing
    );
    app.state::<crate::logging::LogState>().add_log("INFO", &msg, &app);

    Ok(RekordboxExportReport {
        tracks: stats.tracks,
        playlists: stats.playlists,
        folders: stats.folders,
        skipped_missing: stats.skipped_missing,
    })
}

/// Last rekordbox.xml destination, used to default the save dialog.
#[tauri::command]
pub async fn get_rekordbox_export_path(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.get_config("rekordbox_xml_path").map_err(|e| e.to_string())
}

/// Simple pseudo-UUID v4 generator (no external crate needed).
fn uuid_v4_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // Mix nanos with a counter for uniqueness within the same nanosecond
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{:016x}{:08x}", nanos as u64, count as u32)
}

// ─── Playlist Backup / Restore ──────────────────────────────────────────────

/// Backup format written to disk
#[derive(serde::Serialize, serde::Deserialize)]
struct PlaylistBackupFile {
    version: u32,
    created_at: String,
    app_version: String,
    playlists: Vec<crate::db::PlaylistBackupEntry>,
}

#[tauri::command]
pub async fn export_playlist_backup(
    path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    let entries = db.export_playlist_backup().map_err(|e| e.to_string())?;
    let count = entries.iter().filter(|e| !e.is_folder).count();

    let backup = PlaylistBackupFile {
        version: 1,
        created_at: chrono::Local::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        playlists: entries,
    };

    let json = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write backup file: {}", e))?;

    Ok(count)
}

#[tauri::command]
pub async fn read_playlist_backup(
    path: String,
) -> Result<Vec<crate::db::PlaylistBackupEntry>, String> {
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read backup file: {}", e))?;
    let backup: PlaylistBackupFile = serde_json::from_str(&data)
        .map_err(|e| format!("Invalid backup file: {}", e))?;
    Ok(backup.playlists)
}

#[tauri::command]
pub async fn restore_playlist_backup(
    entries: Vec<crate::db::PlaylistBackupEntry>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.restore_playlists_from_backup(&entries).map_err(|e| e.to_string())
}

// ─── Ghost-aware guard tests ────────────────────────────────────────────────
//
// The `#[tauri::command]` functions above take `State<'_, AppState>`, which
// has no public constructor (tauri::State's inner field is private, and this
// crate doesn't enable tauri's `test` feature) — consistent with there being
// no command-level tests anywhere else in this file. These tests instead
// exercise the DB-level contract each ghost guard relies on: (1) ghost tag
// edits update comment_raw/tags vocabulary without ever touching file_path,
// (2) file_path.is_empty() is a safe stand-in for Track::is_ghost() in
// the commands whose track loop only has a raw `(id, file_path, ...)` tuple
// (no `Track`) to work with — verify_library_files, consolidate_library,
// export_tracks_to_music, export_playlist_m3u8 — and (3) for
// mark_track_missing, that `set_track_missing` itself has no ghost
// awareness, so the command's early-return guard is the only thing standing
// between a ghost and a wrongly-set `missing` flag; and (4) for
// add_to_playlist/copy_playlist_memberships, that `get_playlist_origin`
// and `Track::is_ghost()` — the two primitives their playlist-membership
// guards read — report Spotify-origin playlists and ghost tracks correctly.
// The guards' control flow itself (early `return`/`continue`/`skip` placed
// before any DB write or Music.app call) is structural and reviewed by
// inspection.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn ghost(spotify_id: &str) -> Track {
        Track {
            id: 0,
            persistent_id: format!("SP-{}", spotify_id),
            file_path: String::new(),
            artist: Some("Artist".into()),
            title: Some("Title".into()),
            album: Some("Album".into()),
            comment_raw: None,
            grouping_raw: None,
            duration_secs: 200.0,
            format: "SPOTIFY".into(),
            size_bytes: 0,
            bit_rate: 0,
            modified_date: 0,
            rating: 0,
            date_added: 0,
            bpm: 0,
            missing: false,
            itunes_pid: None,
            unlinked_at: None,
            source: "spotify".into(),
            spotify_id: Some(spotify_id.to_string()),
        }
    }

    fn local_track(persistent_id: &str, path: &str) -> Track {
        Track {
            id: 0,
            persistent_id: persistent_id.to_string(),
            file_path: path.to_string(),
            artist: Some("Artist".into()),
            title: Some("Title".into()),
            album: Some("Album".into()),
            comment_raw: None,
            grouping_raw: None,
            duration_secs: 200.0,
            format: "MP3".into(),
            size_bytes: 1000,
            bit_rate: 320,
            modified_date: 0,
            rating: 0,
            date_added: 0,
            bpm: 0,
            missing: false,
            itunes_pid: None,
            unlinked_at: None,
            source: "local".into(),
            spotify_id: None,
        }
    }

    /// DB-level equivalent of write_tags's (and batch_add_tag's/
    /// batch_remove_tag's) ghost branch: tag-editing a ghost updates
    /// comment_raw and the tags vocabulary, and never touches file_path
    /// (there is no file write call in this path at all).
    #[test]
    fn ghost_tag_edit_is_db_only() {
        let db = Database::new(":memory:").unwrap();
        let id = db.insert_imported_track(&ghost("xyz789"), None, None).unwrap();

        let mut track = db.get_track(id).unwrap().unwrap();
        assert!(track.is_ghost());

        // Exactly what write_tags's ghost branch does.
        track.comment_raw = Some(" && House; Peak Time".to_string());
        db.update_track(&track).unwrap();
        let _ = db.sync_tags();

        let reloaded = db.get_track(id).unwrap().unwrap();
        assert_eq!(reloaded.comment_raw.as_deref(), Some(" && House; Peak Time"));
        // Never touched — proves the DB-only path never reaches a file write.
        assert_eq!(reloaded.file_path, "");

        let tags = db.get_all_tags().unwrap();
        assert!(tags.iter().any(|t| t.name == "House"));
        assert!(tags.iter().any(|t| t.name == "Peak Time"));
    }

    /// Batch variant: each ghost in a multi-track batch is updated
    /// independently (mirrors batch_add_tag's/batch_remove_tag's per-track
    /// ghost branch), still DB-only.
    #[test]
    fn ghost_batch_tag_edit_updates_each_track_independently() {
        let db = Database::new(":memory:").unwrap();
        let id1 = db.insert_imported_track(&ghost("g1"), None, None).unwrap();
        let id2 = db.insert_imported_track(&ghost("g2"), None, None).unwrap();

        for id in [id1, id2] {
            let mut track = db.get_track(id).unwrap().unwrap();
            assert!(track.is_ghost());
            track.comment_raw = Some(" && Techno".to_string());
            db.update_track(&track).unwrap();
        }

        assert_eq!(db.get_track(id1).unwrap().unwrap().comment_raw.as_deref(), Some(" && Techno"));
        assert_eq!(db.get_track(id2).unwrap().unwrap().comment_raw.as_deref(), Some(" && Techno"));
        assert_eq!(db.get_track(id1).unwrap().unwrap().file_path, "");
        assert_eq!(db.get_track(id2).unwrap().unwrap().file_path, "");
    }

    /// verify_library_files/consolidate_library/export_tracks_to_music/
    /// export_playlist_m3u8 only have a raw `(id, file_path, ...)` tuple in
    /// their loop (no `Track`, so no `.is_ghost()` available) — they use
    /// `file_path.is_empty()` as the ghost check instead. This proves that
    /// proxy is sound: every ghost row has an empty path and every local
    /// row does not, across a real DB round trip.
    #[test]
    fn ghost_file_path_empty_invariant_holds_through_db_round_trip() {
        let db = Database::new(":memory:").unwrap();
        let ghost_id = db.insert_imported_track(&ghost("abc123"), None, None).unwrap();
        db.insert_track(&local_track("LOC-1", "/Users/me/Music/song.mp3")).unwrap();

        let index = db.get_track_file_index().unwrap();
        assert_eq!(index.len(), 2);
        for (id, file_path, _missing, _linked, _size) in &index {
            let is_ghost_row = db.get_track(*id).unwrap().unwrap().is_ghost();
            assert_eq!(*id == ghost_id, is_ghost_row);
            assert_eq!(file_path.is_empty(), is_ghost_row);
        }
    }

    /// mark_track_missing's ghost guard checks `track.is_ghost()` and, when
    /// `missing` is true, returns early *before* ever calling
    /// `db.set_track_missing`. That control flow lives in the
    /// `#[tauri::command]` fn and can't be exercised here (no public `State`
    /// constructor) — reviewed by inspection, like the other guards in this
    /// file. What IS testable at the DB level is the precondition the guard
    /// exists to compensate for: `set_track_missing` itself is a blind
    /// UPDATE with no ghost awareness, so calling it directly on a ghost
    /// (bypassing the command, as this test does) happily flips `missing`
    /// to true. That's exactly the outcome the command-layer early-return
    /// prevents in production.
    #[test]
    fn ghost_set_track_missing_has_no_db_level_guard_of_its_own() {
        let db = Database::new(":memory:").unwrap();
        let id = db.insert_imported_track(&ghost("missing-guard"), None, None).unwrap();

        let track = db.get_track(id).unwrap().unwrap();
        assert!(track.is_ghost());
        assert!(!track.missing);

        // The exact DB call mark_track_missing makes after its ghost guard —
        // shown here to have no ghost exception baked into the DB layer.
        db.set_track_missing(id, true).unwrap();
        assert!(db.get_track(id).unwrap().unwrap().missing);
    }

    /// add_to_playlist's and copy_playlist_memberships's playlist-membership
    /// guards (Finding 1) key off exactly these two primitives — a ghost
    /// track's `Track::is_ghost()` and a playlist's `get_playlist_origin()` —
    /// to decide "skip this ghost, it doesn't belong in a non-Spotify
    /// playlist" and "reject outright, this playlist's membership is
    /// sync-owned", respectively. As with the other guards in this file, the
    /// commands' own control flow (skip-in-loop / early `return Err`) can't
    /// be exercised here (no public `State` constructor) and is reviewed by
    /// inspection; this proves the primitives it reads report correctly.
    #[test]
    fn playlist_guard_primitives_report_ghost_and_spotify_origin_correctly() {
        let db = Database::new(":memory:").unwrap();
        let ghost_id = db.insert_imported_track(&ghost("guard-check"), None, None).unwrap();
        assert!(db.get_track(ghost_id).unwrap().unwrap().is_ghost());

        let spotify_pl = db.upsert_spotify_playlist("pl-guard", "Synced Crate", "snap1", &[ghost_id]).unwrap();
        assert_eq!(db.get_playlist_origin(spotify_pl).unwrap(), "spotify");

        let native_pl = db.create_playlist("My Crate", None, false, "TD-guard").unwrap();
        assert_eq!(db.get_playlist_origin(native_pl.id).unwrap(), "tagdeck");
    }
}
