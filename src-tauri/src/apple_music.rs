use std::process::Command;
use anyhow::Result;

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
