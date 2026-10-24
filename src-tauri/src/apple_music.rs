use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
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

/// Epoch seconds of the last time TagDeck wrote to Music.app via AppleScript.
/// The library watcher uses this to recognise Music.app's follow-up database
/// save as an echo of our own change rather than a user edit (see
/// `secs_since_last_music_write`).
static LAST_MUSIC_WRITE: AtomicI64 = AtomicI64::new(0);

fn now_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Record that TagDeck just mutated Music.app. Every mutating helper in this
/// module calls it; callers that script Music.app directly must too.
pub fn note_music_write() {
    LAST_MUSIC_WRITE.store(now_epoch_secs(), Ordering::Relaxed);
}

/// Seconds since TagDeck last wrote to Music.app, or `None` if it never has
/// in this process.
pub fn secs_since_last_music_write() -> Option<u64> {
    let t = LAST_MUSIC_WRITE.load(Ordering::Relaxed);
    if t == 0 { None } else { Some((now_epoch_secs() - t).max(0) as u64) }
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
                itunes_pid: Some(jt.id.clone()),
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
                unlinked_at: None,
                source: "local".to_string(),
                spotify_id: None,
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
        note_music_write();
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
        note_music_write();
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

/// The tag-block portion of a TagDeck comment (`"user && tag1; tag2"`) — i.e.
/// everything after the first `" && "`. Empty when the comment has no tag block.
/// TagDeck owns this portion; the free-text before `" && "` belongs to the user.
pub fn tag_block_of(full_comment: &str) -> &str {
    full_comment.splitn(2, " && ").nth(1).unwrap_or("")
}

/// Batch updates the tag block for multiple tracks using a single JXA
/// (JavaScript for Automation) call. Read-merge: each track's *live* Music.app
/// comment is read first, its user free-text (everything before the first
/// `" && "`) is preserved, and only the tag block is replaced. This prevents a
/// stale DB copy of the user's note from overwriting whatever is currently in
/// iTunes. `updates` carries the full TagDeck comment (`"user && tags"`); only
/// its tag block is used — the user portion always comes from the live track.
pub fn batch_update_track_comments(updates: Vec<(String, String)>) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        note_music_write();
        if updates.is_empty() {
            return Ok(());
        }

        // Temporary struct for JSON serialization. We send only the tag block;
        // the user free-text is re-read live inside the JXA per track.
        #[derive(Serialize)]
        struct TrackUpdate {
            id: String, // Persistent ID
            #[serde(rename = "tagBlock")]
            tag_block: String,
        }

        let payload: Vec<TrackUpdate> = updates
            .iter()
            .map(|(id, comment)| TrackUpdate {
                id: id.clone(),
                tag_block: tag_block_of(comment).to_string(),
            })
            .collect();

        // Serialize data to pass to JXA
        let json_arg = serde_json::to_string(&payload)?;

        // JXA Script
        // Logic: Checks if Music is running, interprets JSON, and loops internally.
        // `whose({ persistentID: ... })` is the most efficient native selector for this.
        // Read-merge: preserve the live user note, replace only the tag block.
        let script = r#"
        function run(argv) {
            const app = Application('Music');

            // Exit early to avoid launching Music if it's closed
            if (!app.running()) return;

            const updates = JSON.parse(argv[0]);
            const SEP = " && ";

            updates.forEach(function(item) {
                try {
                    // 'whose' returns a live reference collection.
                    const tracks = app.tracks.whose({ persistentID: item.id });

                    if (tracks.length > 0) {
                        // Preserve the live user note (text before the first SEP);
                        // TagDeck only owns the tag block after it.
                        const live = tracks[0].comment() || "";
                        const idx = live.indexOf(SEP);
                        const user = idx === -1 ? live : live.substring(0, idx);
                        let next;
                        if (!item.tagBlock) {
                            next = user;
                        } else if (user === "") {
                            next = SEP + item.tagBlock;
                        } else {
                            next = user + SEP + item.tagBlock;
                        }
                        tracks[0].comment = next;
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
    /// Smart playlist: Music.app computes membership; TagDeck mirrors it read-only.
    pub is_smart: bool,
    pub track_ids: Vec<String>,
}

/// Cheap per-playlist header: everything Music.app can hand back as batch
/// property lists (one Apple event per property for all playlists), plus a
/// `fingerprint()` that changes whenever the name, folder, parent, smart flag,
/// total duration or total size changes — i.e. on any membership change that
/// matters. Fetching this for ~650 playlists takes well under a second, versus
/// minutes for `persistent ID of every track of p` across every playlist.
#[derive(Debug, Clone, Deserialize)]
pub struct PlaylistHeader {
    #[serde(rename = "id")]
    pub persistent_id: String,
    pub name: String,
    #[serde(rename = "parent_id", default)]
    pub parent_persistent_id: Option<String>,
    pub is_folder: bool,
    pub is_smart: bool,
    /// Music.app `special kind` as text: "none" for ordinary/smart user
    /// playlists, "folder", or a system list ("Music", "Genius", "Movies", …).
    pub special_kind: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub size: f64,
}

impl PlaylistHeader {
    /// True for the lists TagDeck mirrors: ordinary and smart user playlists and
    /// folders. System lists ("Music" = the whole library, Genius, Movies, …)
    /// are excluded — the "Music" one alone is 20k+ tracks per fetch.
    pub fn is_mirrored(&self) -> bool {
        self.special_kind == "none" || self.special_kind == "folder" || self.is_folder
    }

    pub fn fingerprint(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.name.hash(&mut h);
        self.parent_persistent_id.hash(&mut h);
        self.is_folder.hash(&mut h);
        self.is_smart.hash(&mut h);
        self.special_kind.hash(&mut h);
        self.duration.to_bits().hash(&mut h);
        self.size.to_bits().hash(&mut h);
        h.finish()
    }
}

/// Fetches headers for every user playlist and every folder playlist (smart
/// lists included, the library playlist excluded) without touching track
/// membership.
pub fn get_playlist_headers() -> Result<Vec<PlaylistHeader>> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"
            use framework "Foundation"
            use scripting additions

            tell application "Music"
                set pls to every user playlist
                set ids to persistent ID of every user playlist
                set nms to name of every user playlist
                set sms to smart of every user playlist
                set sks to special kind of every user playlist
                set dus to duration of every user playlist
                set szs to size of every user playlist
                set cls to class of every user playlist
                set resultList to {}
                set n to count of ids
                repeat with i from 1 to n
                    set parentId to missing value
                    try
                        set parentId to persistent ID of parent of (item i of pls)
                    end try
                    set du to 0
                    try
                        set du to (item i of dus) as real
                    end try
                    set sz to 0
                    try
                        set sz to (item i of szs) as real
                    end try
                    set entry to {|id|:(item i of ids), |name|:(item i of nms), |parent_id|:parentId, |is_folder|:((item i of cls) is folder playlist), |is_smart|:(item i of sms), |special_kind|:((item i of sks) as text), |duration|:du, |size|:sz}
                    copy entry to end of resultList
                end repeat
                -- Folders are NOT part of `every user playlist`; fetch them separately.
                set fpls to every folder playlist
                set fids to persistent ID of every folder playlist
                set fnms to name of every folder playlist
                repeat with i from 1 to count of fids
                    set parentId to missing value
                    try
                        set parentId to persistent ID of parent of (item i of fpls)
                    end try
                    set entry to {|id|:(item i of fids), |name|:(item i of fnms), |parent_id|:parentId, |is_folder|:true, |is_smart|:false, |special_kind|:"folder", |duration|:0, |size|:0}
                    copy entry to end of resultList
                end repeat
            end tell

            set ca to current application
            set jsonData to ca's NSJSONSerialization's dataWithJSONObject:resultList options:0 |error|:missing value
            set jsonString to (ca's NSString's alloc()'s initWithData:jsonData encoding:4) as string
            return jsonString
        "#;
        let output = Command::new("osascript").arg("-e").arg(script).output()?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("AppleScript Playlist Headers Failed: {}", err.trim()));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let headers: Vec<PlaylistHeader> = serde_json::from_str(stdout.trim())?;
        return Ok(headers);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(vec![])
    }
}

/// Fetches track membership (persistent IDs, in playlist order) for just the
/// given playlists. One osascript spawn per 100 playlists.
pub fn get_playlist_members(pids: &[String]) -> Result<std::collections::HashMap<String, Vec<String>>> {
    let mut out = std::collections::HashMap::new();
    if pids.is_empty() {
        return Ok(out);
    }
    #[cfg(target_os = "macos")]
    {
        for chunk in pids.chunks(100) {
            let pid_list: Vec<String> = chunk.iter().map(|p| format!("\"{}\"", p)).collect();
            let script = format!(
                r#"
                use framework "Foundation"
                use scripting additions

                set pidList to {{{}}}
                set resultList to {{}}
                tell application "Music"
                    repeat with pid in pidList
                        try
                            set p to (first user playlist whose persistent ID is pid)
                            set tIds to {{}}
                            try
                                set tIds to persistent ID of every track of p
                            end try
                            copy {{|id|:(pid as text), |track_ids|:tIds}} to end of resultList
                        end try
                    end repeat
                end tell
                set ca to current application
                set jsonData to ca's NSJSONSerialization's dataWithJSONObject:resultList options:0 |error|:missing value
                set jsonString to (ca's NSString's alloc()'s initWithData:jsonData encoding:4) as string
                return jsonString
                "#,
                pid_list.join(", ")
            );
            let output = Command::new("osascript").arg("-e").arg(&script).output()?;
            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr);
                return Err(anyhow::anyhow!("AppleScript Playlist Members Failed: {}", err.trim()));
            }
            #[derive(Deserialize)]
            struct RawMembers { id: String, track_ids: Vec<String> }
            let stdout = String::from_utf8_lossy(&output.stdout);
            let raw: Vec<RawMembers> = serde_json::from_str(stdout.trim())?;
            for r in raw {
                out.insert(r.id, r.track_ids);
            }
        }
    }
    Ok(out)
}

/// Full snapshot of every mirrored playlist (see `PlaylistHeader::is_mirrored`)
/// with track membership — headers plus one members fetch for all of them.
/// Used by Sync Review; the live sync's Phase 3 fetches members only for
/// playlists whose header fingerprint changed.
pub fn get_playlist_snapshot() -> Result<Vec<PlaylistSnapshotEntry>> {
    let headers: Vec<PlaylistHeader> = get_playlist_headers()?
        .into_iter()
        .filter(|h| h.is_mirrored())
        .collect();
    let pids: Vec<String> = headers
        .iter()
        .filter(|h| !h.is_folder)
        .map(|h| h.persistent_id.clone())
        .collect();
    let mut members = get_playlist_members(&pids)?;
    Ok(headers
        .into_iter()
        .map(|h| PlaylistSnapshotEntry {
            track_ids: members.remove(&h.persistent_id).unwrap_or_default(),
            persistent_id: h.persistent_id,
            parent_persistent_id: h.parent_persistent_id,
            name: h.name,
            is_folder: h.is_folder,
            is_smart: h.is_smart,
        })
        .collect())
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
        note_music_write();
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
        note_music_write();
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
    // Never run the destructive delete-then-re-add against an empty target set — that would
    // wipe the Music.app playlist. Nothing to push if no linked tracks were resolved.
    if track_pids.is_empty() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        note_music_write();
        // Build a comma-separated list of quoted PIDs for the AppleScript list literal.
        let pid_list: Vec<String> = track_pids.iter().map(|p| format!("\"{}\"", p)).collect();
        let pid_array = pid_list.join(", ");

        // Built via placeholder replacement (not format!) so AppleScript's many literal
        // list braces `{}` don't need escaping. Safety properties:
        //   * target must be a user playlist (never the library or a folder);
        //   * every desired track is resolved BEFORE any deletion — a missing PID aborts
        //     with the playlist untouched (no silent shrink);
        //   * the destructive rebuild is wrapped so ANY failure (bad duplicate, or a final
        //     count mismatch) restores the original membership before erroring;
        //   * success returns "OK"; failure raises an AppleScript error → osascript exits
        //     non-zero → surfaced to the caller instead of being swallowed.
        const TEMPLATE: &str = r#"
            if application "Music" is running then
                tell application "Music"
                    set thePlaylist to (first playlist whose persistent ID is "__PLAYLIST_PID__")
                    if class of thePlaylist is not user playlist then
                        error "reorder target is not a user playlist"
                    end if

                    -- Snapshot current membership so we can restore on failure.
                    set originalPIDs to (get persistent ID of every track of thePlaylist)

                    set desiredPIDs to {__PID_ARRAY__}

                    -- Resolve every desired track BEFORE deleting anything. No swallowing
                    -- try here: an unresolvable PID aborts with the playlist intact.
                    set trackRefs to {}
                    repeat with pid in desiredPIDs
                        set end of trackRefs to (first track whose persistent ID is pid)
                    end repeat
                    if (count of trackRefs) is not (count of desiredPIDs) then
                        error "could not resolve all tracks for reorder"
                    end if

                    -- Destructive section: any failure restores the original membership.
                    delete every track of thePlaylist
                    try
                        repeat with aTrack in trackRefs
                            duplicate aTrack to thePlaylist
                        end repeat
                        if (count of tracks of thePlaylist) is not (count of desiredPIDs) then
                            error "playlist count mismatch after reorder"
                        end if
                    on error rebuildErr
                        try
                            delete every track of thePlaylist
                        end try
                        repeat with opid in originalPIDs
                            try
                                duplicate (first track whose persistent ID is opid) to thePlaylist
                            end try
                        end repeat
                        error "reorder failed (" & rebuildErr & "); restored original playlist"
                    end try

                    return "OK"
                end tell
            end if
        "#;

        let script = TEMPLATE
            .replace("__PLAYLIST_PID__", playlist_pid)
            .replace("__PID_ARRAY__", &pid_array);

        let output = Command::new("osascript").arg("-e").arg(&script).output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Music.app reorder failed: {}", stderr.trim());
        }
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
        note_music_write();
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
                    itunes_pid: Some(jt.id.clone()),
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
                    unlinked_at: None,
                    source: "local".to_string(),
                    spotify_id: None,
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
        note_music_write();
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

/// Renames a playlist in Apple Music by its Persistent ID.
pub fn rename_playlist_in_music(persistent_id: &str, new_name: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        note_music_write();
        let escaped_name = new_name.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"
            if application "Music" is running then
                tell application "Music"
                    try
                        set thePlaylist to (first playlist whose persistent ID is "{}")
                        set name of thePlaylist to "{}"
                    end try
                end tell
            end if
            "#,
            persistent_id, escaped_name
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;

        if !output.status.success() {
            eprintln!("AppleScript error (rename_playlist): {}", String::from_utf8_lossy(&output.stderr));
        }
    }
    Ok(())
}

/// Checks whether a playlist with the given persistent ID exists in Music.app.
pub fn playlist_exists_in_music(persistent_id: &str) -> Result<bool> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"
            tell application "Music"
                if exists (some playlist whose persistent ID is "{}") then
                    return "yes"
                else
                    return "no"
                end if
            end tell
            "#,
            persistent_id
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;

        if !output.status.success() {
            return Err(anyhow::anyhow!(
                "AppleScript error (playlist_exists): {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        return Ok(String::from_utf8_lossy(&output.stdout).trim() == "yes");
    }
    #[cfg(not(target_os = "macos"))]
    Ok(false)
}

/// Creates a new user playlist in Music.app and returns its persistent ID.
pub fn create_playlist_in_music(name: &str) -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        note_music_write();
        let escaped_name = name.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"
            tell application "Music"
                set thePlaylist to (make new user playlist with properties {{name:"{}"}})
                return persistent ID of thePlaylist
            end tell
            "#,
            escaped_name
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;

        if !output.status.success() {
            return Err(anyhow::anyhow!(
                "AppleScript error (create_playlist): {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        let pid = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if pid.is_empty() {
            return Err(anyhow::anyhow!("Music.app did not return a persistent ID for the new playlist"));
        }
        return Ok(pid);
    }
    #[cfg(not(target_os = "macos"))]
    Err(anyhow::anyhow!("Music.app playlists are only supported on macOS"))
}

/// Builds the AppleScript that creates a user playlist named `name` inside the
/// folder whose persistent ID is `folder_pid` (or at the root when `None`).
/// Pure (no osascript) so escaping and folder targeting are unit-testable.
fn build_create_in_folder_script(name: &str, folder_pid: Option<&str>) -> String {
    let escaped_name = name.replace('\\', "\\\\").replace('"', "\\\"");
    match folder_pid {
        None => format!(
            r#"
            tell application "Music"
                set thePlaylist to (make new user playlist with properties {{name:"{}"}})
                return persistent ID of thePlaylist
            end tell
            "#,
            escaped_name
        ),
        Some(pid) => {
            let escaped_pid = pid.replace('\\', "\\\\").replace('"', "\\\"");
            format!(
                r#"
                tell application "Music"
                    set theFolder to (first user playlist whose persistent ID is "{}")
                    set thePlaylist to (make new user playlist at theFolder with properties {{name:"{}"}})
                    return persistent ID of thePlaylist
                end tell
                "#,
                escaped_pid, escaped_name
            )
        }
    }
}

/// Creates a playlist in Music.app inside `folder_pid` (root when `None`) and
/// returns the new playlist's persistent ID.
pub fn create_playlist_in_folder(name: &str, folder_pid: Option<&str>) -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        note_music_write();
        let script = build_create_in_folder_script(name, folder_pid);
        let output = Command::new("osascript").arg("-e").arg(&script).output()?;
        if !output.status.success() {
            return Err(anyhow::anyhow!(
                "AppleScript error (create_playlist_in_folder): {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let pid = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if pid.is_empty() {
            return Err(anyhow::anyhow!(
                "Music.app did not return a persistent ID for the new playlist"
            ));
        }
        return Ok(pid);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (name, folder_pid);
        Err(anyhow::anyhow!("Music.app playlists are only supported on macOS"))
    }
}

/// Searches Music.app library for a track whose file location matches the given path.
/// Returns the persistent ID if found, or None if no match.
/// Used to prevent duplicate imports when re-adding a file already in the library.
pub fn find_track_in_music_by_path(file_path: &str) -> Result<Option<String>> {
    #[cfg(target_os = "macos")]
    {
        let escaped = file_path.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"
            tell application "Music"
                try
                    set posixFile to POSIX file "{}"
                    set matchedTracks to (every track whose location is posixFile)
                    if (count of matchedTracks) > 0 then
                        return persistent ID of item 1 of matchedTracks
                    end if
                end try
            end tell
            return ""
            "#,
            escaped
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;

        let pid = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if pid.is_empty() {
            return Ok(None);
        }
        return Ok(Some(pid));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

/// Adds a file to the Music.app library and returns the resulting track in ONE
/// AppleScript round-trip: `add` (Music applies its own copy/organize setting),
/// optionally `duplicate` into the target playlist, then read every field back
/// from the returned reference. Replaces the old add → `whose persistent ID`
/// fetch → playlist-add trio (three osascript spawns + two indexed lookups).
///
/// Note: `add` returns the existing track when Music already has that exact
/// file (copy-to-library off); with copying on, re-adding a source file would
/// create a duplicate — the caller's DB path/hash dedupe is what prevents that.
pub fn add_file_to_music_library_full(file_path: &str, playlist_pid: Option<&str>) -> Result<Track> {
    #[cfg(target_os = "macos")]
    {
        note_music_write();
        let escaped = file_path.replace('\\', "\\\\").replace('"', "\\\"");
        let playlist_block = match playlist_pid {
            Some(ppid) if !ppid.is_empty() => format!(
                r#"try
                        duplicate t to (first playlist whose persistent ID is "{}")
                    end try"#,
                ppid
            ),
            _ => String::new(),
        };
        let script = format!(
            r#"
            use framework "Foundation"
            use scripting additions

            tell application "Music"
                set t to add POSIX file "{}"
                {}
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
            end tell

            set ca to current application
            set jsonData to ca's NSJSONSerialization's dataWithJSONObject:entry options:0 |error|:missing value
            set jsonString to (ca's NSString's alloc()'s initWithData:jsonData encoding:4) as string
            return jsonString
            "#,
            escaped, playlist_block
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("AppleScript error (add_file_to_music_library_full): {}", err.trim()));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let jt: JxaTrack = serde_json::from_str(stdout.trim())
            .map_err(|e| anyhow::anyhow!("Music.app returned unparseable track data for {}: {}", file_path, e))?;
        if jt.id.is_empty() {
            return Err(anyhow::anyhow!("Music.app returned empty persistent ID for file: {}", file_path));
        }
        Ok(Track {
            id: 0,
            itunes_pid: Some(jt.id.clone()),
            persistent_id: jt.id,
            file_path: jt.location.unwrap_or_default(),
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
            unlinked_at: None,
            source: "local".to_string(),
            spotify_id: None,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (file_path, playlist_pid);
        Err(anyhow::anyhow!("Apple Music is only available on macOS"))
    }
}

/// Returns true if Music.app is installed on this machine.
pub fn is_apple_music_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript")
            .arg("-e")
            .arg(r#"id of application "Music""#)
            .output();
        matches!(output, Ok(o) if o.status.success())
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Adds a file to the Music.app library and returns the Apple-assigned persistent ID.
/// Music.app handles file organization based on its own "Copy files to library" setting.
pub fn add_file_to_music_library(file_path: &str) -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        note_music_write();
        let escaped = file_path.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"
            tell application "Music"
                set theTrack to add POSIX file "{}"
                set pid to persistent ID of theTrack
                return pid
            end tell
            "#,
            escaped
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("AppleScript error (add_file_to_music_library): {}", err));
        }

        let pid = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if pid.is_empty() {
            return Err(anyhow::anyhow!("Music.app returned empty persistent ID for file: {}", file_path));
        }
        Ok(pid)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(anyhow::anyhow!("Apple Music is only available on macOS"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_block_of_extracts_tags_after_delimiter() {
        assert_eq!(tag_block_of("my note && house; deep"), "house; deep");
    }

    #[test]
    fn tag_block_of_empty_when_no_delimiter() {
        // Whole comment is user free-text; no tag block to push.
        assert_eq!(tag_block_of("just a note"), "");
        assert_eq!(tag_block_of(""), "");
    }

    #[test]
    fn tag_block_of_handles_empty_user_prefix() {
        // TagDeck's empty-user format: leading " && tags".
        assert_eq!(tag_block_of(" && house; deep"), "house; deep");
    }

    #[test]
    fn tag_block_of_splits_on_first_delimiter_only() {
        // A literal " && " inside the tag block stays in the tag block.
        assert_eq!(tag_block_of("note && a && b"), "a && b");
    }

    #[test]
    fn reorder_playlist_noops_on_empty_set() {
        // An empty desired set must never run the destructive delete-then-re-add
        // (which would wipe the Music.app playlist) — it returns Ok without touching anything.
        assert!(reorder_playlist("SOMEPID", &[]).is_ok());
    }

    #[test]
    fn create_in_folder_script_targets_folder_and_escapes() {
        // Root form: no folder lookup, name escaped.
        let root = build_create_in_folder_script(r#"My "Best" Set"#, None);
        assert!(!root.contains("whose persistent ID"));
        assert!(root.contains(r#"name:"My \"Best\" Set""#));

        // Folder form: resolves the folder by persistent ID, creates inside it.
        let nested = build_create_in_folder_script("Summer", Some("ABC123"));
        assert!(nested.contains(r#"first user playlist whose persistent ID is "ABC123""#));
        assert!(nested.contains("make new user playlist at theFolder"));
        assert!(nested.contains(r#"name:"Summer""#));
    }
}
