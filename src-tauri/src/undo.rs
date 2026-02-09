use crate::db::Database;
use crate::apple_music::{batch_update_track_comments, update_track_info as apple_update_track_info, update_track_comment, touch_file};
use crate::metadata::{write_metadata as write_tags_to_file, write_track_info};
use anyhow::Result;
use std::process::Command;

#[derive(Debug, Clone)]
pub enum Action {
    UpdateTrackComments {
        // Supports single or batch updates
        tracks: Vec<TrackState>, 
    },
    AddToPlaylist {
        playlist_id: i64,
        playlist_persistent_id: String,
        // List of track IDs added
        tracks: Vec<TrackRef>,
    },
    UpdateTrackInfo {
        track: TrackInfoState,
    },
}

/// Stores old and new values for a track info edit (title, artist, album, bpm, comment).
/// Only fields that changed will have Some values.
#[derive(Debug, Clone)]
pub struct TrackInfoState {
    pub id: i64,
    pub persistent_id: String,
    pub file_path: String,
    pub old_title: Option<String>,
    pub new_title: Option<String>,
    pub old_artist: Option<String>,
    pub new_artist: Option<String>,
    pub old_album: Option<String>,
    pub new_album: Option<String>,
    pub old_bpm: Option<i64>,
    pub new_bpm: Option<i64>,
    pub old_comment_raw: Option<String>,
    pub new_comment_raw: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TrackState {
    pub id: i64,
    pub persistent_id: String,
    pub file_path: String,
    pub old_comment: String,
    pub new_comment: String,
}

#[derive(Debug, Clone)]
pub struct TrackRef {
    pub id: i64,
    pub persistent_id: String,
}

pub struct UndoStack {
    undo_stack: Vec<Action>,
    redo_stack: Vec<Action>,
}

impl UndoStack {
    pub fn new() -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    pub fn push(&mut self, action: Action) {
        self.undo_stack.push(action);
        self.redo_stack.clear(); // Clear redo stack on new action
    }

    pub fn undo(&mut self, db: &Database) -> Result<Option<String>> {
        if let Some(action) = self.undo_stack.pop() {
            let message = match &action {
                Action::UpdateTrackComments { tracks } => {
                    let mut updates = Vec::new();
                    for track in tracks {
                        // Revert to old comment
                        
                        // 1. File
                        if let Err(e) = write_tags_to_file(&track.file_path, &track.old_comment) {
                            eprintln!("Undo Write File Error: {}", e);
                            continue;
                        }
                        
                        // 2. DB
                        if let Err(e) = db.update_track_metadata(track.id, &track.old_comment) {
                            eprintln!("Undo DB Error: {}", e);
                        }

                        // 3. Queue AM Update
                        if !track.persistent_id.is_empty() {
                            updates.push((track.persistent_id.clone(), track.old_comment.clone()));
                        }
                    }

                    // Flush AM
                    if !updates.is_empty() {
                         let _ = batch_update_track_comments(updates);
                    }
                    
                    if tracks.len() == 1 {
                        "Undo Tag Change".to_string()
                    } else {
                        format!("Undo Tag Change ({} tracks)", tracks.len())
                    }
                },
                Action::AddToPlaylist { playlist_id, playlist_persistent_id, tracks } => {
                     // Reverse: Remove tracks from playlist
                     
                     // 1. Apple Music
                     #[cfg(target_os = "macos")]
                     {
                        // Generate AppleScript to remove these tracks from this playlist
                         for track in tracks {
                             let script = format!(
                                r#"
                                tell application "Music"
                                    try
                                        set thePlaylist to (first playlist whose persistent ID is "{}")
                                        delete (every track of thePlaylist whose persistent ID is "{}")
                                    end try
                                end tell
                                "#,
                                playlist_persistent_id, track.persistent_id
                             );
                             let _ = Command::new("osascript").arg("-e").arg(&script).output();
                         }
                     }

                     // 2. DB
                     for track in tracks {
                         // This is a naive delete: removes all instances of this track in this playlist
                         // A more robust undo would track the specific 'position' or 'id' in the join table
                         let _ = db.remove_track_from_playlist(*playlist_id, track.id);
                     }
                     
                     "Undo Add to Playlist".to_string()
                },
                Action::UpdateTrackInfo { track } => {
                    // Revert track info to old values
                    apply_track_info(db, track, true);
                    "Undo Edit Track Info".to_string()
                }
            };
            
            self.redo_stack.push(action);
            Ok(Some(message))
        } else {
            Ok(None)
        }
    }

    pub fn redo(&mut self, db: &Database) -> Result<Option<String>> {
        if let Some(action) = self.redo_stack.pop() {
             let message = match &action {
                Action::UpdateTrackComments { tracks } => {
                    let mut updates = Vec::new();
                    for track in tracks {
                        // Re-apply new comment
                        
                        // 1. File
                        let _ = write_tags_to_file(&track.file_path, &track.new_comment);
                        
                        // 2. DB
                        let _ = db.update_track_metadata(track.id, &track.new_comment);

                        // 3. Queue AM Update
                        if !track.persistent_id.is_empty() {
                            updates.push((track.persistent_id.clone(), track.new_comment.clone()));
                        }
                    }
                    if !updates.is_empty() {
                         let _ = batch_update_track_comments(updates);
                    }
                    if tracks.len() == 1 {
                        "Redo Tag Change".to_string()
                    } else {
                         format!("Redo Tag Change ({} tracks)", tracks.len())
                    }
                },
                Action::AddToPlaylist { playlist_id, playlist_persistent_id, tracks } => {
                     // Re-apply Add

                     // 1. Apple Music
                     #[cfg(target_os = "macos")]
                     {
                         for track in tracks {
                            let _ = crate::apple_music::add_track_to_playlist(&track.persistent_id, playlist_persistent_id);
                         }
                     }
                     
                     // 2. DB
                     for track in tracks {
                         let _ = db.add_track_to_playlist_db(*playlist_id, track.id);
                     }

                     "Redo Add to Playlist".to_string()
                },
                Action::UpdateTrackInfo { track } => {
                    // Re-apply new track info values
                    apply_track_info(db, track, false);
                    "Redo Edit Track Info".to_string()
                }
             };
             
             self.undo_stack.push(action);
             Ok(Some(message))
        } else {
            Ok(None)
        }
    }
}

/// Applies track info changes for undo/redo.
/// If `revert` is true, applies old values (undo); otherwise applies new values (redo).
fn apply_track_info(db: &Database, track: &TrackInfoState, revert: bool) {
    let (title, artist, album, bpm, comment_raw) = if revert {
        (
            track.old_title.as_deref(),
            track.old_artist.as_deref(),
            track.old_album.as_deref(),
            track.old_bpm,
            track.old_comment_raw.as_deref(),
        )
    } else {
        (
            track.new_title.as_deref(),
            track.new_artist.as_deref(),
            track.new_album.as_deref(),
            track.new_bpm,
            track.new_comment_raw.as_deref(),
        )
    };

    // 1. DB
    if let Err(e) = db.update_track_info(track.id, title, artist, album, bpm, comment_raw) {
        eprintln!("Undo/Redo DB Error: {}", e);
    }

    // 2. File metadata (title/artist/album/bpm)
    if title.is_some() || artist.is_some() || album.is_some() || bpm.is_some() {
        if let Err(e) = write_track_info(&track.file_path, title, artist, album, bpm) {
            eprintln!("Undo/Redo File Write Error: {}", e);
        }
    }

    // 3. Comment in file (uses write_metadata which writes the full comment_raw)
    if let Some(c) = comment_raw {
        let _ = write_tags_to_file(&track.file_path, c);
    }

    // 4. Touch file
    let _ = touch_file(&track.file_path);

    // 5. Apple Music sync
    if !track.persistent_id.is_empty() {
        // Sync title/artist/album/bpm
        if title.is_some() || artist.is_some() || album.is_some() || bpm.is_some() {
            let _ = apple_update_track_info(&track.persistent_id, title, artist, album, bpm);
        }
        // Sync comment
        if let Some(c) = comment_raw {
            let _ = update_track_comment(&track.persistent_id, c);
        }
    }
}
