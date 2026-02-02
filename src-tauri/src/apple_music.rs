use std::process::Command;
use anyhow::Result;
use serde::Serialize;
use serde_json;

/// Updates a track's comment in Apple Music (iTunes) by its Persistent ID.
/// Uses AppleScript to directly set the comment property.
/// Only runs if Music is already running.
pub fn update_track_comment(persistent_id: &str, comment: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // Simple escaping for AppleScript string
        let escaped_comment = comment.replace('\\', "\\\\").replace('"', "\\\"");
        
        let script = format!(
            r#"
            if application "Music" is running then
                tell application "Music"
                    try
                        -- Find track by persistent ID
                        set myTracks to (every track whose persistent ID is "{}")
                        if (count of myTracks) > 0 then
                            set myTrack to item 1 of myTracks
                            set comment of myTrack to "{}"
                        end if
                    end try
                end tell
            end if
            "#,
            persistent_id, escaped_comment
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;
            
        if !output.status.success() {
             eprintln!("AppleScript error: {}", String::from_utf8_lossy(&output.stderr));
        }
    }
    Ok(())
}

/// Batch updates comments for multiple tracks using a single JXA (JavaScript for Automation) call.
/// This acts as a massive performance optimization over calling `osascript` per track.
pub fn batch_update_track_comments(updates: Vec<(String, String)>) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        if updates.is_empty() {
            return Ok(());
        }

        // Temporary struct for JSON serialization
        #[derive(Serialize)]
        struct TrackUpdate {
            id: String, // Persistent ID
            comment: String,
        }

        let payload: Vec<TrackUpdate> = updates
            .into_iter()
            .map(|(id, comment)| TrackUpdate { id, comment })
            .collect();

        // Serialize data to pass to JXA
        let json_arg = serde_json::to_string(&payload)?;

        // JXA Script
        // Logic: Checks if Music is running, interprets JSON, and loops internally.
        // `whose({ persistentID: ... })` is the most efficient native selector for this.
        let script = r#"
        function run(argv) {
            const app = Application('Music');
            
            // Exit early to avoid launching Music if it's closed
            if (!app.running()) return;

            const updates = JSON.parse(argv[0]);
            
            updates.forEach(function(item) {
                try {
                    // 'whose' returns a live reference collection. 
                    const tracks = app.tracks.whose({ persistentID: item.id });
                    
                    if (tracks.length > 0) {
                        // Update the first match
                        tracks[0].comment = item.comment;
                    }
                } catch (e) {
                    // Swallow errors for individual tracks so the batch continues
                }
            });
        }
        "#;

        let output = Command::new("osascript")
            .arg("-l")
            .arg("JavaScript")
            .arg("-e")
            .arg(script)
            .arg(json_arg) // Pass JSON as argument 0
            .output()?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("JXA Batch Update Failed: {}", err));
        }
    }
    
    Ok(())
}

/// Helper to "touch" a file, updating its modification time.
/// This helps Rekordbox and Finder notice that the file has changed.
pub fn touch_file(path: &str) -> Result<()> {
   #[cfg(target_os = "macos")]
   {
        Command::new("touch")
            .arg(path)
            .output()?;
   }
   Ok(())
}
