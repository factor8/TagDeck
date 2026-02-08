use std::process::Command;
use anyhow::Result;
use serde::{Serialize, Deserialize};
use serde_json;
use crate::models::Track;

#[derive(Deserialize, Debug)]
struct JxaTrack {
    id: String,
    name: String,
    artist: String,
    album: String,
    comment: String,
    grouping: String,
    duration: f64,
    kind: String,
    size: i64,
    #[serde(rename = "bitRate")]
    bit_rate: i64,
    rating: i64,
    bpm: i64,
    location: Option<String>,
}

pub fn get_changes_since(since_epoch_seconds: i64) -> Result<Vec<Track>> {
    #[cfg(target_os = "macos")]
    {
        // Switch to AppleScript for reliable Date comparison
        // JXA's `whose` filtering with Dates is notoriously flaky due to bridging issues.
        // Pure AppleScript handles `date "String"` comparisons natively and correctly.
        
        // We construct a localized date string or just use raw seconds calculation inside AppleScript if possible? 
        // actually passing date string is standard.
        // Let's rely on standard applescript date construction from parts to be safe against locale.

        let script = format!(
            r#"
            use framework "Foundation"
            use scripting additions
            
            -- Helper to parse unix timestamp to AS Date
            on getASDateFromTimestamp(unixTimestamp)
                set ca to current application
                set d to ca's NSDate's dateWithTimeIntervalSince1970:unixTimestamp
                -- Convert NSDate to AS Date (hacky but reliable)
                set dCal to ca's NSCalendar's currentCalendar()
                set comps to dCal's components:(508) fromDate:d -- 508 = year+month+day+hour+min+sec
                set newDate to (current date)
                set year of newDate to comps's |year|()
                set month of newDate to comps's |month|()
                set day of newDate to comps's |day|()
                set hours of newDate to comps's |hour|()
                set minutes of newDate to comps's |minute|()
                set seconds of newDate to comps's |second|()
                return newDate
            end getASDateFromTimestamp

            set sinceDate to getASDateFromTimestamp({})
            
            log "Querying changes since: " & (sinceDate as string)

            tell application "Music"
                set recentTracks to (every track whose modification date >= sinceDate)
                
                -- Construct JSON manually to avoid slow object bridges
                set jsonList to {{}}
                
                repeat with t in recentTracks
                   try
                       set tId to persistent ID of t
                       set tName to name of t
                       set tArtist to artist of t
                       set tAlbum to album of t
                       set tComment to comment of t
                       set tGrouping to grouping of t
                       set tDuration to duration of t
                       set tKind to kind of t
                       set tSize to size of t
                       set tBitRate to bit rate of t
                       set tRating to rating of t
                       set tBpm to bpm of t
                       
                       -- Handle Location safely (might be missing)
                       try
                           set tLoc to POSIX path of (location of t)
                       on error
                           set tLoc to ""
                       end try
                       
                       set entry to {{ |id|:tId, |name|:tName, |artist|:tArtist, |album|:tAlbum, |comment|:tComment, |grouping|:tGrouping, |duration|:tDuration, |kind|:tKind, |size|:tSize, |bitRate|:tBitRate, |rating|:tRating, |bpm|:tBpm, |location|:tLoc }}
                       copy entry to end of jsonList
                   end try
                end repeat
            end tell
            
            -- JSON Stringify using ObjC bridge
            set ca to current application
            set jsonData to ca's NSJSONSerialization's dataWithJSONObject:jsonList options:0 |error|:missing value
            set jsonString to (ca's NSString's alloc()'s initWithData:jsonData encoding:4) as string
            return jsonString
            "#,
            since_epoch_seconds
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;

        if !output.status.success() {
             let err = String::from_utf8_lossy(&output.stderr);
             eprintln!("AppleScript Error: {}", err);
             return Err(anyhow::anyhow!("AppleScript Get Changes Failed: {}", err));
        }

        // Log stderr (AppleScript logs) for debugging
        if !output.stderr.is_empty() {
            eprintln!("AppleScript Logs: {}", String::from_utf8_lossy(&output.stderr));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        
        let as_tracks: Vec<JxaTrack> = serde_json::from_str(&stdout)?;

        let tracks: Vec<Track> = as_tracks.into_iter().filter_map(|jt| {
            if jt.location.is_none() || jt.location.as_deref() == Some("") {
                return None;
            }
            let path = jt.location.unwrap();
            
            // Note: Determining timestamps from localized string is hard, defaulting to 0 for now.
            // In a future update we should make AS return unix timestamps directly.
            let mod_time = 0;
            let added_time = 0;

            Some(Track {
                id: 0, 
                persistent_id: jt.id,
                file_path: path,
                artist: Some(jt.artist),
                title: Some(jt.name),
                album: Some(jt.album),
                comment_raw: Some(jt.comment),
                grouping_raw: Some(jt.grouping),
                duration_secs: jt.duration,
                format: jt.kind,
                size_bytes: jt.size,
                bit_rate: jt.bit_rate,
                modified_date: mod_time,
                rating: jt.rating,
                date_added: added_time,
                bpm: jt.bpm,
                missing: false,
            })
        }).collect();

        return Ok(tracks);
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(vec![])
    }
}

/// Updates a track's rating in Apple Music (iTunes) by its Persistent ID.
/// Rating is an integer between 0 and 100.
pub fn update_track_rating(persistent_id: &str, rating: u32) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"
            if application "Music" is running then
                tell application "Music"
                    try
                        -- Find track by persistent ID
                        set myTracks to (every track whose persistent ID is "{}")
                        if (count of myTracks) > 0 then
                            set myTrack to item 1 of myTracks
                            set rating of myTrack to {}
                        end if
                    end try
                end tell
            end if
            "#,
            persistent_id, rating
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

/// Adds a track to a playlist in Apple Music (iTunes) by their Persistent IDs.
pub fn add_track_to_playlist(track_pid: &str, playlist_pid: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"
            if application "Music" is running then
                tell application "Music"
                    try
                        set theTrack to (first track whose persistent ID is "{}")
                        set thePlaylist to (first playlist whose persistent ID is "{}")
                        duplicate theTrack to thePlaylist
                    on error errMsg
                         -- ignore errors
                    end try
                end tell
            end if
            "#,
            track_pid, playlist_pid
        );

        Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;
    }
    Ok(())
}
