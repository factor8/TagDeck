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
                       
                       -- Handle Location safely
                       -- NOTE: `use framework "Foundation"` breaks `POSIX path of` on file refs.
                       -- We must coerce to alias first, or use NSURL as a fallback.
                       set tLoc to ""
                       try
                           set tLoc to POSIX path of (location of t as alias)
                       on error
                           try
                               -- Fallback: use NSURL via ObjC bridge
                               set fileRef to location of t
                               set fileURL to current application's NSURL's fileURLWithPath:(POSIX path of (fileRef as text))
                               set tLoc to (fileURL's |path|()) as text
                           on error
                               set tLoc to ""
                           end try
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

        let tracks: Vec<Track> = as_tracks.into_iter().map(|jt| {
            let path = jt.location.unwrap_or_default();
            
            Track {
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
                modified_date: 0,
                rating: jt.rating,
                date_added: 0,
                bpm: jt.bpm,
                missing: false,
            }
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

/// Lightweight struct for snapshot-based diffing of fields that Music.app
/// does NOT include in `modification date` (e.g. rating, BPM).
#[derive(Debug, Deserialize)]
pub struct SnapshotEntry {
    pub persistent_id: String,
    pub rating: i64,
    pub bpm: i64,
}

/// Fetches persistent_id, rating, and BPM for ALL tracks from Music.app
/// using efficient batch property access (parallel list fetching).
/// Returns ~20k entries in ~2 seconds for large libraries.
pub fn get_snapshot_fields() -> Result<Vec<SnapshotEntry>> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"
            use framework "Foundation"
            use scripting additions

            tell application "Music"
                set allIds to persistent ID of every track
                set allRatings to rating of every track
                set allBpms to bpm of every track
            end tell

            -- Build a single JSON object with parallel arrays (instant serialization)
            set ca to current application
            set payload to {|ids|:allIds, |ratings|:allRatings, |bpms|:allBpms}
            set jsonData to ca's NSJSONSerialization's dataWithJSONObject:payload options:0 |error|:missing value
            set jsonString to (ca's NSString's alloc()'s initWithData:jsonData encoding:4) as string
            return jsonString
        "#;

        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("AppleScript Snapshot Fetch Failed: {}", err));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        #[derive(Deserialize)]
        struct ParallelArrays {
            ids: Vec<String>,
            ratings: Vec<i64>,
            bpms: Vec<i64>,
        }

        let arrays: ParallelArrays = serde_json::from_str(&stdout)?;

        let entries: Vec<SnapshotEntry> = arrays.ids.into_iter()
            .zip(arrays.ratings.into_iter())
            .zip(arrays.bpms.into_iter())
            .map(|((id, rating), bpm)| SnapshotEntry {
                persistent_id: id,
                rating,
                bpm,
            })
            .collect();

        return Ok(entries);
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(vec![])
    }
}

/// Struct representing a playlist snapshot entry from Music.app.
#[derive(Debug, Deserialize)]
pub struct PlaylistSnapshotEntry {
    pub persistent_id: String,
    pub parent_persistent_id: Option<String>,
    pub name: String,
    pub is_folder: bool,
    pub track_ids: Vec<String>,
}

/// Fetches a snapshot of ALL playlists from Music.app with their track lists.
/// Used for Phase 3 of sync to detect playlist additions, renames, reordering, etc.
pub fn get_playlist_snapshot() -> Result<Vec<PlaylistSnapshotEntry>> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"
            use framework "Foundation"
            use scripting additions

            tell application "Music"
                set allPlaylists to every playlist
                set resultList to {}

                repeat with p in allPlaylists
                    try
                        -- Skip the master Library playlist (special class)
                        if class of p is library playlist then
                            -- skip
                        else
                            set pName to name of p
                            set pId to persistent ID of p
                            set isFldr to false
                            if class of p is folder playlist then
                                set isFldr to true
                            end if

                            -- Parent persistent ID (if nested)
                            set parentId to missing value
                            try
                                set parentPlaylist to parent of p
                                if parentPlaylist is not missing value then
                                    set parentId to persistent ID of parentPlaylist
                                end if
                            end try

                            -- Track persistent IDs (folders have no tracks)
                            set tIds to {}
                            if not isFldr then
                                try
                                    set tIds to persistent ID of every track of p
                                end try
                            end if

                            set entry to {|id|:pId, |name|:pName, |parent_id|:parentId, |is_folder|:isFldr, |track_ids|:tIds}
                            copy entry to end of resultList
                        end if
                    end try
                end repeat
            end tell

            -- JSON Stringify using ObjC bridge
            set ca to current application
            set jsonData to ca's NSJSONSerialization's dataWithJSONObject:resultList options:0 |error|:missing value
            set jsonString to (ca's NSString's alloc()'s initWithData:jsonData encoding:4) as string
            return jsonString
        "#;

        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("AppleScript Playlist Snapshot Failed: {}", err));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        #[derive(Deserialize)]
        struct RawPlaylist {
            id: String,
            name: String,
            parent_id: Option<String>,
            is_folder: bool,
            track_ids: Vec<String>,
        }

        let raw: Vec<RawPlaylist> = serde_json::from_str(&stdout)?;

        let entries: Vec<PlaylistSnapshotEntry> = raw.into_iter()
            .map(|p| PlaylistSnapshotEntry {
                persistent_id: p.id,
                parent_persistent_id: p.parent_id,
                name: p.name,
                is_folder: p.is_folder,
                track_ids: p.track_ids,
            })
            .collect();

        return Ok(entries);
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(vec![])
    }
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

/// Removes a track from a playlist in Apple Music by their Persistent IDs.
pub fn remove_track_from_playlist(track_pid: &str, playlist_pid: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"
            if application "Music" is running then
                tell application "Music"
                    try
                        set thePlaylist to (first playlist whose persistent ID is "{}")
                        delete (every track of thePlaylist whose persistent ID is "{}")
                    end try
                end tell
            end if
            "#,
            playlist_pid, track_pid
        );

        Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;
    }
    Ok(())
}

/// Reorders tracks in an Apple Music playlist by removing all tracks and re-adding them in order.
/// This is the only reliable way to reorder via AppleScript since Music.app doesn't expose
/// a direct "move track to position" API.
pub fn reorder_playlist(playlist_pid: &str, track_pids: &[String]) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // Build a comma-separated list of quoted PIDs for the AppleScript
        let pid_list: Vec<String> = track_pids.iter().map(|p| format!("\"{}\"" , p)).collect();
        let pid_array = pid_list.join(", ");

        let script = format!(
            r##"
            if application "Music" is running then
                tell application "Music"
                    try
                        set thePlaylist to (first playlist whose persistent ID is "{}")
                        set trackPIDs to {{{}}}
                        
                        -- Collect references to the tracks before deleting
                        set trackRefs to {{}}
                        repeat with pid in trackPIDs
                            try
                                set end of trackRefs to (first track whose persistent ID is pid)
                            end try
                        end repeat
                        
                        -- Delete all tracks from the playlist
                        delete every track of thePlaylist
                        
                        -- Re-add in the desired order
                        repeat with aTrack in trackRefs
                            try
                                duplicate aTrack to thePlaylist
                            end try
                        end repeat
                    on error errMsg
                        -- log but don't fail
                    end try
                end tell
            end if
            "##,
            playlist_pid, pid_array
        );

        Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;
    }
    Ok(())
}

/// Gets the played count for a track in Apple Music by its Persistent ID.
pub fn get_play_count(track_pid: &str) -> Result<i64> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"
            tell application "Music"
                try
                    set theTrack to (first track whose persistent ID is "{}")
                    return played count of theTrack
                on error
                    return 0
                end try
            end tell
            "#,
            track_pid
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Ok(stdout.parse::<i64>().unwrap_or(0));
        }
        return Ok(0);
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(0)
    }
}

/// Sets the played count for a track in Apple Music by its Persistent ID.
pub fn set_play_count(track_pid: &str, count: i64) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"
            if application "Music" is running then
                tell application "Music"
                    try
                        set theTrack to (first track whose persistent ID is "{}")
                        set played count of theTrack to {}
                    end try
                end tell
            end if
            "#,
            track_pid, count
        );

        Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;
    }
    Ok(())
}

/// Fetches all persistent IDs from Music.app efficiently using batch property access.
/// Returns a HashSet of persistent IDs for fast lookup.
pub fn get_all_music_app_pids() -> Result<std::collections::HashSet<String>> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"
            use framework "Foundation"
            use scripting additions

            tell application "Music"
                set allIds to persistent ID of every track
            end tell

            set ca to current application
            set jsonData to ca's NSJSONSerialization's dataWithJSONObject:allIds options:0 |error|:missing value
            set jsonString to (ca's NSString's alloc()'s initWithData:jsonData encoding:4) as string
            return jsonString
        "#;

        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("AppleScript Get All PIDs Failed: {}", err));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let ids: Vec<String> = serde_json::from_str(&stdout)?;
        return Ok(ids.into_iter().collect());
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(std::collections::HashSet::new())
    }
}

/// Fetches full track data from Music.app for a set of persistent IDs.
/// Used to import newly added tracks detected during sync.
/// Processes in batches to avoid AppleScript timeouts on large sets.
pub fn get_tracks_by_persistent_ids(pids: &[String]) -> Result<Vec<Track>> {
    #[cfg(target_os = "macos")]
    {
        if pids.is_empty() {
            return Ok(vec![]);
        }

        let mut all_tracks = Vec::new();

        // Process in batches of 50 to avoid AppleScript timeout
        for chunk in pids.chunks(50) {
            let pid_list: Vec<String> = chunk.iter()
                .map(|pid| format!("\"{}\"" , pid))
                .collect();
            let pid_array = pid_list.join(", ");

            let script = format!(
                r#"
                use framework "Foundation"
                use scripting additions

                set pidList to {{{}}}
                set resultList to {{}}

                tell application "Music"
                    repeat with pid in pidList
                        try
                            set t to (first track whose persistent ID is pid)
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

                            set tLoc to ""
                            try
                                set tLoc to POSIX path of (location of t as alias)
                            on error
                                try
                                    set fileRef to location of t
                                    set fileURL to current application's NSURL's fileURLWithPath:(POSIX path of (fileRef as text))
                                    set tLoc to (fileURL's |path|()) as text
                                on error
                                    set tLoc to ""
                                end try
                            end try

                            set entry to {{|id|:tId, |name|:tName, |artist|:tArtist, |album|:tAlbum, |comment|:tComment, |grouping|:tGrouping, |duration|:tDuration, |kind|:tKind, |size|:tSize, |bitRate|:tBitRate, |rating|:tRating, |bpm|:tBpm, |location|:tLoc}}
                            copy entry to end of resultList
                        end try
                    end repeat
                end tell

                set ca to current application
                set jsonData to ca's NSJSONSerialization's dataWithJSONObject:resultList options:0 |error|:missing value
                set jsonString to (ca's NSString's alloc()'s initWithData:jsonData encoding:4) as string
                return jsonString
                "#,
                pid_array
            );

            let output = Command::new("osascript")
                .arg("-e")
                .arg(&script)
                .output()?;

            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr);
                eprintln!("AppleScript error fetching tracks by PID: {}", err);
                continue; // Skip this batch but keep going
            }

            let stdout = String::from_utf8_lossy(&output.stdout);
            let jxa_tracks: Vec<JxaTrack> = match serde_json::from_str(&stdout) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("JSON parse error for track batch: {}", e);
                    continue;
                }
            };

            for jt in jxa_tracks {
                let path = jt.location.unwrap_or_default();
                all_tracks.push(Track {
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
                    modified_date: 0,
                    rating: jt.rating,
                    date_added: 0,
                    bpm: jt.bpm,
                    missing: false,
                });
            }
        }

        return Ok(all_tracks);
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(vec![])
    }
}

/// Updates a track's metadata fields (name, artist, album, BPM) in Apple Music via a single AppleScript call.
/// Only sets fields that are provided (Some). Skips None fields.
pub fn update_track_info(persistent_id: &str, name: Option<&str>, artist: Option<&str>, album: Option<&str>, bpm: Option<i64>) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let mut set_lines = Vec::new();
        if let Some(n) = name {
            let escaped = n.replace('\\', "\\\\").replace('"', "\\\"");
            set_lines.push(format!("set name of myTrack to \"{}\"", escaped));
        }
        if let Some(a) = artist {
            let escaped = a.replace('\\', "\\\\").replace('"', "\\\"");
            set_lines.push(format!("set artist of myTrack to \"{}\"", escaped));
        }
        if let Some(al) = album {
            let escaped = al.replace('\\', "\\\\").replace('"', "\\\"");
            set_lines.push(format!("set album of myTrack to \"{}\"", escaped));
        }
        if let Some(b) = bpm {
            set_lines.push(format!("set bpm of myTrack to {}", b));
        }

        if set_lines.is_empty() {
            return Ok(());
        }

        let set_block = set_lines.join("\n                            ");

        let script = format!(
            r#"
            if application "Music" is running then
                tell application "Music"
                    try
                        set myTracks to (every track whose persistent ID is "{}")
                        if (count of myTracks) > 0 then
                            set myTrack to item 1 of myTracks
                            {}
                        end if
                    end try
                end tell
            end if
            "#,
            persistent_id, set_block
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;

        if !output.status.success() {
            eprintln!("AppleScript error (update_track_info): {}", String::from_utf8_lossy(&output.stderr));
        }
    }
    Ok(())
}
