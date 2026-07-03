use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::Path;
use crate::models::{Track};

const DB_SCHEMA: &str = r#"
    CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persistent_id TEXT UNIQUE,
        file_path TEXT NOT NULL,
        artist TEXT,
        title TEXT,
        album TEXT,
        comment_raw TEXT,
        grouping_raw TEXT,
        duration_secs REAL,
        format TEXT,
        size_bytes INTEGER,
        bit_rate INTEGER,
        modified_date INTEGER,
        rating INTEGER,
        date_added INTEGER,
        bpm INTEGER,
        missing BOOLEAN DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persistent_id TEXT UNIQUE,
        parent_persistent_id TEXT,
        name TEXT,
        is_folder BOOLEAN DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id INTEGER,
        track_id INTEGER,
        position INTEGER,
        FOREIGN KEY(playlist_id) REFERENCES playlists(id),
        FOREIGN KEY(track_id) REFERENCES tracks(id),
        PRIMARY KEY (playlist_id, track_id)
    );

    CREATE TABLE IF NOT EXISTS tag_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        position INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE COLLATE NOCASE,
        usage_count INTEGER DEFAULT 0,
        group_id INTEGER REFERENCES tag_groups(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS library_config (
        key TEXT PRIMARY KEY,
        value TEXT
    );
"#;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(DB_SCHEMA)?;
        
        // Explicitly ensure tag_groups exists because execute_batch might not create it if it stops early (though it shouldn't)
        // or if DB_SCHEMA was only partially applied in previous versions.
        let _ = conn.execute("CREATE TABLE IF NOT EXISTS tag_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            position INTEGER DEFAULT 0
        )", []);

        // Migration: Attempt to add columns for existing databases
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN bit_rate INTEGER DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN rating INTEGER DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN date_added INTEGER DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN bpm INTEGER DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN is_folder BOOLEAN DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN parent_persistent_id TEXT", []);
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN missing BOOLEAN DEFAULT 0", []);
        
        // Add columns to existing tags table
        let _ = conn.execute("ALTER TABLE tags ADD COLUMN group_id INTEGER REFERENCES tag_groups(id) ON DELETE SET NULL", []);

        // File management columns
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN original_path TEXT", []);
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN import_date INTEGER", []);
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN file_hash TEXT", []);

        // Playlist management columns (Phase 1)
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN origin TEXT DEFAULT 'itunes'", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN itunes_sync_enabled BOOLEAN DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN description TEXT", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN color TEXT", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN sort_position INTEGER DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN created_at INTEGER DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN updated_at INTEGER DEFAULT 0", []);

        // Identity decoupling: persistent_id is TagDeck's internal ID; itunes_pid is
        // the optional link to Music.app. Backfill assumes existing non-TD tracks
        // came from iTunes; the unlinked_at guard keeps unlinked tracks unlinked.
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN itunes_pid TEXT", []);
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN unlinked_at INTEGER", []);
        let _ = conn.execute(
            "UPDATE tracks SET itunes_pid = persistent_id
             WHERE itunes_pid IS NULL AND unlinked_at IS NULL AND persistent_id NOT LIKE 'TD-%'",
            [],
        );
        let _ = conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_itunes_pid ON tracks(itunes_pid)", []);

        Ok(Self { conn })
    }

    /// Returns a HashSet of all linked iTunes persistent IDs in the DB.
    /// Tracks that are TagDeck-native or unlinked are excluded — sync only
    /// concerns itself with tracks that have a Music.app counterpart.
    pub fn get_all_itunes_pids(&self) -> Result<std::collections::HashSet<String>> {
        let mut stmt = self.conn.prepare("SELECT itunes_pid FROM tracks WHERE itunes_pid IS NOT NULL")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut set = std::collections::HashSet::new();
        for row in rows {
            set.insert(row?);
        }
        Ok(set)
    }

    /// Returns a HashMap of itunes_pid -> (rating, bpm) for all linked tracks.
    /// Used for efficient snapshot-based diffing against Music.app.
    pub fn get_rating_bpm_snapshot(&self) -> Result<std::collections::HashMap<String, (i64, i64)>> {
        let mut stmt = self.conn.prepare("SELECT itunes_pid, rating, bpm FROM tracks WHERE itunes_pid IS NOT NULL")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        let mut map = std::collections::HashMap::new();
        for row in rows {
            let (pid, rating, bpm) = row?;
            map.insert(pid, (rating, bpm));
        }
        Ok(map)
    }

    /// Updates only the rating and BPM for a track identified by its iTunes link.
    pub fn update_rating_bpm(&self, itunes_pid: &str, rating: i64, bpm: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET rating = ?1, bpm = ?2 WHERE itunes_pid = ?3",
            params![rating, bpm, itunes_pid],
        )?;
        Ok(())
    }

    pub fn insert_track(&self, track: &crate::models::Track) -> Result<()> {
        self.conn.execute(
            "INSERT INTO tracks (
                persistent_id, file_path, artist, title, album,
                comment_raw, grouping_raw, duration_secs, format,
                size_bytes, bit_rate, modified_date, rating, date_added, bpm, itunes_pid
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
            ON CONFLICT(persistent_id) DO UPDATE SET
                file_path=CASE WHEN excluded.file_path = '' THEN tracks.file_path ELSE excluded.file_path END,
                artist=excluded.artist,
                title=excluded.title,
                album=excluded.album,
                comment_raw=excluded.comment_raw,
                grouping_raw=excluded.grouping_raw,
                duration_secs=excluded.duration_secs,
                format=excluded.format,
                size_bytes=excluded.size_bytes,
                bit_rate=excluded.bit_rate,
                modified_date=CASE WHEN excluded.modified_date = 0 THEN tracks.modified_date ELSE excluded.modified_date END,
                rating=excluded.rating,
                date_added=CASE WHEN excluded.date_added = 0 THEN tracks.date_added ELSE excluded.date_added END,
                bpm=excluded.bpm,
                itunes_pid=excluded.itunes_pid,
                unlinked_at=NULL
            ",
            params![
                track.persistent_id,
                track.file_path,
                track.artist,
                track.title,
                track.album,
                track.comment_raw,
                track.grouping_raw,
                track.duration_secs,
                track.format,
                track.size_bytes,
                track.bit_rate,
                track.modified_date,
                track.rating,
                track.date_added,
                track.bpm,
                track.itunes_pid
            ],
        )?;
        Ok(())
    }

    pub fn get_track(&self, id: i64) -> Result<Option<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, persistent_id, file_path, artist, title, album,
             comment_raw, grouping_raw, duration_secs, format, size_bytes, bit_rate, modified_date,
             rating, date_added, bpm, missing, itunes_pid, unlinked_at
             FROM tracks WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;

        if let Some(row) = rows.next()? {
            Ok(Some(Track {
                id: row.get(0)?,
                persistent_id: row.get(1)?,
                file_path: row.get(2)?,
                artist: row.get(3)?,
                title: row.get(4)?,
                album: row.get(5)?,
                comment_raw: row.get(6)?,
                grouping_raw: row.get(7)?,
                duration_secs: row.get(8)?,
                format: row.get(9)?,
                size_bytes: row.get(10)?,
                bit_rate: row.get(11)?,
                modified_date: row.get(12)?,
                rating: row.get(13)?,
                date_added: row.get(14)?,
                bpm: row.get(15)?,
                missing: row.get(16).unwrap_or(false),
                itunes_pid: row.get(17).unwrap_or(None),
                unlinked_at: row.get(18).unwrap_or(None),
            }))
        } else {
            Ok(None)
        }
    }

    pub fn update_track(&self, track: &Track) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET
                comment_raw = ?1,
                grouping_raw = ?2,
                modified_date = ?3
             WHERE id = ?4",
             params![
                 track.comment_raw,
                 track.grouping_raw,
                 // update modified time? Maybe let's keep it as file modify time.
                 // Actually passing current time is better to signal change?
                 // But wait, modified_date in struct usually reflects file mtime.
                 // Let's create a new time?
                 // For now, re-use what's in the track, assuming caller updated it or we don't care.
                 // Actually, if we write to file, mtime changes. We should probably update it.
                 // But let's just stick with what we have.
                 track.modified_date,
                 track.id
             ]
        )?;
        Ok(())
    }

    /// Returns a snapshot of all playlists in the DB for diffing.
    /// Maps persistent_id → (name, is_folder, parent_persistent_id, vec of track persistent_ids, origin)
    pub fn get_playlist_snapshot(&self) -> Result<std::collections::HashMap<String, (String, bool, Option<String>, Vec<String>, String)>> {
        use std::collections::HashMap;

        let mut map: HashMap<String, (String, bool, Option<String>, Vec<String>, String)> = HashMap::new();

        let mut stmt = self.conn.prepare(
            "SELECT id, persistent_id, parent_persistent_id, name, is_folder, COALESCE(origin, 'itunes') FROM playlists"
        )?;
        let rows = stmt.query_map([], |row| {
            let id: i64 = row.get(0)?;
            let pid: String = row.get(1)?;
            let parent_pid: Option<String> = row.get(2)?;
            let name: String = row.get(3)?;
            let is_folder: bool = row.get(4)?;
            let origin: String = row.get(5)?;
            Ok((id, pid, parent_pid, name, is_folder, origin))
        })?.collect::<Result<Vec<_>, rusqlite::Error>>()?;

        for (db_id, pid, parent_pid, name, is_folder, origin) in &rows {
            // Get iTunes track IDs for this playlist. Only linked tracks are
            // compared against Music.app — TagDeck-native and unlinked tracks
            // are local-only members and must not produce phantom diffs.
            let mut track_stmt = self.conn.prepare(
                "SELECT t.itunes_pid FROM playlist_tracks pt
                 JOIN tracks t ON t.id = pt.track_id
                 WHERE pt.playlist_id = ?1 AND t.itunes_pid IS NOT NULL
                 ORDER BY pt.position ASC"
            )?;
            let track_pids = track_stmt.query_map(params![db_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, rusqlite::Error>>()?;

            map.insert(pid.clone(), (name.clone(), *is_folder, parent_pid.clone(), track_pids, origin.clone()));
        }

        Ok(map)
    }

    /// Removes playlists from the DB that are no longer present in Music.app.
    /// Also removes associated playlist_tracks entries.
    /// Returns a list of names of the deleted playlists for logging.
    pub fn remove_playlists_by_persistent_ids(&self, pids: &[String]) -> Result<Vec<String>> {
        let mut deleted_names = Vec::new();
        for pid in pids {
            // Get name and ID before deletion
            let (db_id, name): (Option<i64>, Option<String>) = self.conn.query_row(
                "SELECT id, name FROM playlists WHERE persistent_id = ?1",
                params![pid],
                |row| Ok((row.get(0).ok(), row.get(1).ok()))
            ).unwrap_or((None, None));

            if let Some(n) = name {
                deleted_names.push(n);
            }

            if let Some(id) = db_id {
                self.conn.execute(
                    "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
                    params![id],
                )?;
            }

            self.conn.execute(
                "DELETE FROM playlists WHERE persistent_id = ?1",
                params![pid],
            )?;
        }
        Ok(deleted_names)
    }

    pub fn get_playlists(&self) -> Result<Vec<crate::models::Playlist>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, persistent_id, parent_persistent_id, name, is_folder,
                    COALESCE(origin, 'itunes'), COALESCE(itunes_sync_enabled, 0),
                    description, color, COALESCE(sort_position, 0),
                    COALESCE(created_at, 0), COALESCE(updated_at, 0)
             FROM playlists WHERE name != 'Music' ORDER BY is_folder DESC, sort_position ASC, name ASC"
        )?;
        let playlists = stmt.query_map([], |row| {
            Ok(crate::models::Playlist {
                id: row.get(0)?,
                persistent_id: row.get(1)?,
                parent_persistent_id: row.get(2)?,
                name: row.get(3)?,
                is_folder: row.get(4)?,
                track_ids: None,
                origin: row.get(5)?,
                itunes_sync_enabled: row.get(6)?,
                description: row.get(7)?,
                color: row.get(8)?,
                sort_position: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?.collect::<Result<Vec<_>, rusqlite::Error>>()?;
        Ok(playlists)
    }

    pub fn get_playlist_track_ids(&self, playlist_id: i64) -> Result<Vec<i64>> {
        let mut stmt = self.conn.prepare(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position ASC"
        )?;
        let ids = stmt.query_map(params![playlist_id], |row| row.get(0))?
            .collect::<Result<Vec<i64>, rusqlite::Error>>()?;
        Ok(ids)
    }

    pub fn add_track_to_playlist_db(&self, playlist_id: i64, track_id: i64) -> Result<()> {
        // Get max position
        let max_pos: Option<i64> = self.conn.query_row(
            "SELECT MAX(position) FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
            |row| row.get(0)
        ).unwrap_or(None);

        let new_pos = max_pos.map(|p| p + 1).unwrap_or(0);

        // Attempt insert, ignoring if already exists (due to PK constraint)
        self.conn.execute(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
            params![playlist_id, track_id, new_pos]
        )?;
        Ok(())
    }

    pub fn insert_playlist(&self, playlist: &crate::models::Playlist) -> Result<()> {
        // Use a transaction for atomicity
        // Note: For simple methods we don't strictly need a transaction object if we handle it carefully, 
        // but rusqlite transaction is safer. Since `&self.conn` is immutable here, we use internal mutability of DB or simple execute.
        // For simplicity:
        
        self.conn.execute(
            "INSERT INTO playlists (persistent_id, parent_persistent_id, name, is_folder) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(persistent_id) DO UPDATE SET name=excluded.name, is_folder=excluded.is_folder, parent_persistent_id=excluded.parent_persistent_id",
            params![playlist.persistent_id, playlist.parent_persistent_id, playlist.name, playlist.is_folder],
        )?;

        let playlist_db_id: i64 = self.conn.query_row(
            "SELECT id FROM playlists WHERE persistent_id = ?1",
            params![playlist.persistent_id],
            |row| row.get(0),
        )?;

        if let Some(track_pids) = &playlist.track_ids {
            // Collect local-only track IDs (in DB but not in incoming iTunes list)
            // so we can preserve manually-added tracks across syncs.
            let itunes_pid_set: std::collections::HashSet<&str> =
                track_pids.iter().map(|s| s.as_str()).collect();
            let mut local_only_stmt = self.conn.prepare(
                "SELECT pt.track_id FROM playlist_tracks pt
                 JOIN tracks t ON t.id = pt.track_id
                 WHERE pt.playlist_id = ?1"
            )?;
            let local_only_ids: Vec<i64> = local_only_stmt
                .query_map(params![playlist_db_id], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .filter(|tid: &i64| {
                    // Keep if not in the incoming iTunes list (unlinked/native
                    // tracks match by their TagDeck ID, which never appears there)
                    self.conn.query_row(
                        "SELECT COALESCE(itunes_pid, persistent_id) FROM tracks WHERE id = ?1",
                        params![tid],
                        |r| r.get::<_, String>(0),
                    ).ok().map_or(false, |pid| !itunes_pid_set.contains(pid.as_str()))
                })
                .collect();

            self.conn.execute(
                "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
                params![playlist_db_id],
            )?;

            let mut stmt = self.conn.prepare(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position)
                 SELECT ?1, id, ?3 FROM tracks WHERE COALESCE(itunes_pid, persistent_id) = ?2"
            )?;
            for (index, pid) in track_pids.iter().enumerate() {
                let _ = stmt.execute(params![playlist_db_id, pid, index as i64]);
            }

            // Re-append locally-added tracks after the iTunes tracks
            let base_pos = track_pids.len() as i64;
            for (i, tid) in local_only_ids.iter().enumerate() {
                let _ = self.conn.execute(
                    "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
                    params![playlist_db_id, tid, base_pos + i as i64],
                );
            }
        } else {
            self.conn.execute(
                "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
                params![playlist_db_id],
            )?;
        }

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Playlist CRUD methods (Phase 1 — TagDeck-native playlists)
    // -----------------------------------------------------------------------

    /// Creates a new TagDeck-native playlist or folder.
    /// Returns the newly created Playlist with its database ID.
    pub fn create_playlist(
        &self,
        name: &str,
        parent_persistent_id: Option<&str>,
        is_folder: bool,
        persistent_id: &str,
    ) -> Result<crate::models::Playlist> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;

        // Get next sort_position for siblings at this level
        let max_pos: Option<i64> = if let Some(ppid) = parent_persistent_id {
            self.conn.query_row(
                "SELECT MAX(sort_position) FROM playlists WHERE parent_persistent_id = ?1",
                params![ppid],
                |row| row.get(0),
            ).unwrap_or(None)
        } else {
            self.conn.query_row(
                "SELECT MAX(sort_position) FROM playlists WHERE parent_persistent_id IS NULL",
                [],
                |row| row.get(0),
            ).unwrap_or(None)
        };
        let sort_position = max_pos.map(|p| p + 1).unwrap_or(0);

        self.conn.execute(
            "INSERT INTO playlists (persistent_id, parent_persistent_id, name, is_folder, origin, itunes_sync_enabled, sort_position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'tagdeck', 0, ?5, ?6, ?7)",
            params![persistent_id, parent_persistent_id, name, is_folder, sort_position, now, now],
        )?;

        let id = self.conn.last_insert_rowid();

        Ok(crate::models::Playlist {
            id,
            persistent_id: persistent_id.to_string(),
            parent_persistent_id: parent_persistent_id.map(|s| s.to_string()),
            name: name.to_string(),
            is_folder,
            track_ids: None,
            origin: "tagdeck".to_string(),
            itunes_sync_enabled: false,
            description: None,
            color: None,
            sort_position,
            created_at: now,
            updated_at: now,
        })
    }

    /// Renames a playlist by its database ID.
    pub fn rename_playlist(&self, id: i64, name: &str) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;
        self.conn.execute(
            "UPDATE playlists SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now, id],
        )?;
        Ok(())
    }

    /// Deletes a playlist and its track associations by database ID.
    pub fn delete_playlist(&self, id: i64) -> Result<()> {
        // First remove child playlists if this is a folder
        let persistent_id: String = self.conn.query_row(
            "SELECT persistent_id FROM playlists WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;

        // Get all children (recursive would be ideal but 2-level max is fine)
        let child_ids: Vec<i64> = {
            let mut stmt = self.conn.prepare(
                "SELECT id FROM playlists WHERE parent_persistent_id = ?1"
            )?;
            let rows = stmt.query_map(params![persistent_id], |row| row.get(0))?
                .collect::<Result<Vec<i64>, rusqlite::Error>>()?;
            rows
        };

        // Delete children's playlist_tracks and the children themselves
        for child_id in &child_ids {
            self.conn.execute(
                "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
                params![child_id],
            )?;
            self.conn.execute(
                "DELETE FROM playlists WHERE id = ?1",
                params![child_id],
            )?;
        }

        // Delete this playlist's tracks and the playlist itself
        self.conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            params![id],
        )?;
        self.conn.execute(
            "DELETE FROM playlists WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Moves a playlist to a new parent folder (or root if parent_persistent_id is None).
    pub fn move_playlist(&self, id: i64, new_parent_persistent_id: Option<&str>) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;
        self.conn.execute(
            "UPDATE playlists SET parent_persistent_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_parent_persistent_id, now, id],
        )?;
        Ok(())
    }

    /// Duplicates a playlist (tracks only, not folders) with a new name.
    /// Returns the new playlist.
    pub fn duplicate_playlist(&self, id: i64, new_name: &str, new_persistent_id: &str) -> Result<crate::models::Playlist> {
        // Get the source playlist details
        let (parent_pid, _origin): (Option<String>, String) = self.conn.query_row(
            "SELECT parent_persistent_id, COALESCE(origin, 'itunes') FROM playlists WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        // Create the new playlist
        let new_playlist = self.create_playlist(
            new_name,
            parent_pid.as_deref(),
            false,
            new_persistent_id,
        )?;

        // Copy track associations
        let track_ids = self.get_playlist_track_ids(id)?;
        for (pos, tid) in track_ids.iter().enumerate() {
            self.conn.execute(
                "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
                params![new_playlist.id, tid, pos as i64],
            )?;
        }

        Ok(new_playlist)
    }

    /// Reorders playlists within a parent level by updating sort_position.
    pub fn reorder_sibling_playlists(&self, ordered_ids: &[i64]) -> Result<()> {
        for (i, id) in ordered_ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE playlists SET sort_position = ?1 WHERE id = ?2",
                params![i as i64, id],
            )?;
        }
        Ok(())
    }

    /// Updates optional metadata fields on a playlist.
    pub fn update_playlist_metadata(
        &self,
        id: i64,
        description: Option<&str>,
        color: Option<&str>,
    ) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;
        self.conn.execute(
            "UPDATE playlists SET description = ?1, color = ?2, updated_at = ?3 WHERE id = ?4",
            params![description, color, now, id],
        )?;
        Ok(())
    }

    /// Returns the origin of a playlist by its database ID.
    pub fn get_playlist_origin(&self, id: i64) -> Result<String> {
        let origin: String = self.conn.query_row(
            "SELECT COALESCE(origin, 'itunes') FROM playlists WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        Ok(origin)
    }

    /// Returns the track count for a playlist.
    pub fn get_playlist_track_count(&self, playlist_id: i64) -> Result<i64> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    pub fn get_track_persistent_id(&self, id: i64) -> Result<String> {
        let pid: String = self.conn.query_row(
            "SELECT persistent_id FROM tracks WHERE id = ?1",
            params![id],
            |row| row.get(0)
        )?;
        Ok(pid)
    }

    /// Returns the track's Music.app link, or None for TagDeck-native /
    /// unlinked tracks (callers must skip AppleScript write-back for those).
    pub fn get_track_itunes_pid(&self, id: i64) -> Result<Option<String>> {
        let pid: Option<String> = self.conn.query_row(
            "SELECT itunes_pid FROM tracks WHERE id = ?1",
            params![id],
            |row| row.get(0)
        )?;
        Ok(pid)
    }

    pub fn get_playlist_persistent_id(&self, id: i64) -> Result<String> {
        let pid: String = self.conn.query_row(
            "SELECT persistent_id FROM playlists WHERE id = ?1",
            params![id],
            |row| row.get(0)
        )?;
        Ok(pid)
    }

    pub fn update_track_metadata(&self, id: i64, comment: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET comment_raw = ?1 WHERE id = ?2",
            params![comment, id],
        )?;
        Ok(())
    }

    pub fn update_track_rating(&self, id: i64, rating: u32) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET rating = ?1 WHERE id = ?2",
            params![rating, id],
        )?;
        Ok(())
    }

    /// Updates track info fields (title, artist, album, bpm, comment_raw) in the database.
    /// Only updates fields that are Some; leaves existing values for None fields.
    pub fn update_track_info(
        &self,
        id: i64,
        title: Option<&str>,
        artist: Option<&str>,
        album: Option<&str>,
        bpm: Option<i64>,
        comment_raw: Option<&str>,
    ) -> Result<()> {
        let mut sets = Vec::new();
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(t) = title {
            sets.push("title = ?");
            params_vec.push(Box::new(t.to_string()));
        }
        if let Some(a) = artist {
            sets.push("artist = ?");
            params_vec.push(Box::new(a.to_string()));
        }
        if let Some(al) = album {
            sets.push("album = ?");
            params_vec.push(Box::new(al.to_string()));
        }
        if let Some(b) = bpm {
            sets.push("bpm = ?");
            params_vec.push(Box::new(b));
        }
        if let Some(c) = comment_raw {
            sets.push("comment_raw = ?");
            params_vec.push(Box::new(c.to_string()));
        }

        if sets.is_empty() {
            return Ok(());
        }

        params_vec.push(Box::new(id));

        // Build parameterized query with correct numbered placeholders
        let mut numbered_sets = Vec::new();
        for (i, s) in sets.iter().enumerate() {
            numbered_sets.push(s.replace('?', &format!("?{}", i + 1)));
        }
        let id_param = format!("?{}", params_vec.len());
        let sql = format!("UPDATE tracks SET {} WHERE id = {}", numbered_sets.join(", "), id_param);

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        self.conn.execute(&sql, param_refs.as_slice())?;
        Ok(())
    }

    pub fn get_all_tracks(&self) -> Result<Vec<crate::models::Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, persistent_id, file_path, artist, title, album,
             comment_raw, grouping_raw, duration_secs, format, size_bytes, bit_rate, modified_date,
             rating, date_added, bpm, missing, itunes_pid, unlinked_at
             FROM tracks",
        )?;

        let track_iter = stmt.query_map([], |row| {
            Ok(crate::models::Track {
                id: row.get(0)?,
                persistent_id: row.get(1)?,
                file_path: row.get(2)?,
                artist: row.get(3)?,
                title: row.get(4)?,
                album: row.get(5)?,
                comment_raw: row.get(6)?,
                grouping_raw: row.get(7)?,
                duration_secs: row.get(8)?,
                format: row.get(9)?,
                size_bytes: row.get(10)?,
                bit_rate: row.get(11)?,
                modified_date: row.get(12)?,
                rating: row.get(13)?,
                date_added: row.get(14)?,
                bpm: row.get(15)?,
                missing: row.get(16).unwrap_or(false),
                itunes_pid: row.get(17).unwrap_or(None),
                unlinked_at: row.get(18).unwrap_or(None),
            })
        })?;

        let mut tracks = Vec::new();
        for track in track_iter {
            tracks.push(track?);
        }
        Ok(tracks)
    }

    pub fn remove_track_from_playlist(&self, playlist_id: i64, track_id: i64) -> Result<()> {
        self.conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
            params![playlist_id, track_id],
        )?;
        Ok(())
    }

    /// Removes multiple tracks from a playlist and re-numbers positions.
    pub fn remove_tracks_from_playlist(&self, playlist_id: i64, track_ids: &[i64]) -> Result<()> {
        for tid in track_ids {
            self.conn.execute(
                "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
                params![playlist_id, tid],
            )?;
        }
        // Re-number positions to keep them contiguous
        let remaining = self.get_playlist_track_ids(playlist_id)?;
        for (i, tid) in remaining.iter().enumerate() {
            self.conn.execute(
                "UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
                params![i as i64, playlist_id, tid],
            )?;
        }
        Ok(())
    }

    /// Reorders tracks within a playlist by rewriting position values.
    /// `ordered_track_ids` must contain the full list of track IDs in the desired order.
    pub fn reorder_playlist_tracks(&self, playlist_id: i64, ordered_track_ids: &[i64]) -> Result<()> {
        for (i, tid) in ordered_track_ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
                params![i as i64, playlist_id, tid],
            )?;
        }
        Ok(())
    }

    /// Returns all playlists that contain the given track, with playlist id, persistent_id, and name.
    pub fn get_playlists_for_track(&self, track_id: i64) -> Result<Vec<(i64, String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.persistent_id, p.name 
             FROM playlist_tracks pt
             JOIN playlists p ON p.id = pt.playlist_id
             WHERE pt.track_id = ?1 AND p.name != 'Music'
             ORDER BY p.name ASC"
        )?;
        let rows = stmt.query_map(params![track_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?.collect::<Result<Vec<_>, rusqlite::Error>>()?;
        Ok(rows)
    }

    pub fn get_track_path(&self, id: i64) -> Result<String> {
        self.conn.query_row(
            "SELECT file_path FROM tracks WHERE id = ?1",
            params![id],
            |row| row.get(0),
        ).map_err(|e| e.into())
    }

    pub fn update_track_path(&self, id: i64, path: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET file_path = ?1 WHERE id = ?2",
            params![path, id],
        )?;
        Ok(())
    }

    pub fn set_track_missing(&self, id: i64, missing: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET missing = ?1 WHERE id = ?2",
            params![missing, id],
        )?;
        Ok(())
    }

    /// Marks tracks that disappeared from Music.app as unlinked instead of
    /// deleting them. All TagDeck data (playlist membership, tags via the file)
    /// stays intact; deletion is only ever user-initiated.
    /// Returns the count of unlinked tracks.
    pub fn unlink_tracks_by_itunes_pids(&self, pids: &[String]) -> Result<usize> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;
        let mut unlinked = 0;
        for pid in pids {
            unlinked += self.conn.execute(
                "UPDATE tracks SET itunes_pid = NULL, unlinked_at = ?1 WHERE itunes_pid = ?2",
                params![now, pid],
            )?;
        }
        Ok(unlinked)
    }

    // TAG GROUP METHODS

    pub fn get_tag_groups(&self) -> Result<Vec<crate::models::TagGroup>> {
        let mut stmt = self.conn.prepare("SELECT id, name, position FROM tag_groups ORDER BY position ASC")?;
        let group_iter = stmt.query_map([], |row| {
            Ok(crate::models::TagGroup {
                id: row.get(0)?,
                name: row.get(1)?,
                position: row.get(2)?,
            })
        })?;

        let mut groups = Vec::new();
        for group in group_iter {
            groups.push(group?);
        }
        Ok(groups)
    }

    pub fn create_tag_group(&self, name: &str) -> Result<crate::models::TagGroup> {
        self.conn.execute(
            "INSERT INTO tag_groups (name, position) VALUES (?1, (SELECT COALESCE(MAX(position), 0) + 1 FROM tag_groups))",
            params![name],
        )?;
        let id = self.conn.last_insert_rowid();
        let position: i64 = self.conn.query_row("SELECT position FROM tag_groups WHERE id = ?1", params![id], |row| row.get(0))?;
        
        Ok(crate::models::TagGroup {
            id,
            name: name.to_string(),
            position,
        })
    }
    
    pub fn update_tag_group(&self, id: i64, name: &str) -> Result<()> {
        self.conn.execute("UPDATE tag_groups SET name = ?1 WHERE id = ?2", params![name, id])?;
        Ok(())
    }

    pub fn delete_tag_group(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM tag_groups WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn reorder_tag_groups(&self, ordered_ids: Vec<i64>) -> Result<()> {
        for (index, id) in ordered_ids.iter().enumerate() {
            self.conn.execute("UPDATE tag_groups SET position = ?1 WHERE id = ?2", params![index as i64, id])?;
        }
        Ok(())
    }

    // TAG METHODS

    pub fn get_all_tags(&self) -> Result<Vec<crate::models::Tag>> {
        let mut stmt = self.conn.prepare("SELECT id, name, usage_count, group_id FROM tags ORDER BY name ASC")?;
        let tag_iter = stmt.query_map([], |row| {
            Ok(crate::models::Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                usage_count: row.get(2)?,
                group_id: row.get(3)?,
            })
        })?;

        let mut tags = Vec::new();
        for tag in tag_iter {
            tags.push(tag?);
        }
        Ok(tags)
    }

    pub fn set_tag_group(&self, tag_id: i64, group_id: Option<i64>) -> Result<()> {
        self.conn.execute("UPDATE tags SET group_id = ?1 WHERE id = ?2", params![group_id, tag_id])?;
        Ok(())
    }
    
    pub fn delete_tag(&self, tag_id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM tags WHERE id = ?1", params![tag_id])?;
        Ok(())
    }
    
    pub fn sync_tags(&self) -> Result<()> {
         // First, reset all usage counts to 0
         self.conn.execute("UPDATE tags SET usage_count = 0", [])?;
         
         let tracks = self.get_all_tracks()?;
         let mut tag_counts = std::collections::HashMap::new();
         
         for track in tracks {
            if let Some(raw) = track.comment_raw {
                if let Some(idx) = raw.find(" && ") {
                    let tag_part = &raw[idx + 4..];
                    for tag in tag_part.split(';') {
                        let trimmed = tag.trim();
                        if !trimmed.is_empty() {
                           *tag_counts.entry(trimmed.to_string()).or_insert(0) += 1;
                        }
                    }
                }
            }
         }
         
         for (name, count) in tag_counts {
             self.conn.execute(
                 "INSERT INTO tags (name, usage_count) VALUES (?1, ?2) 
                  ON CONFLICT(name) DO UPDATE SET usage_count = ?3",
                 params![name, count, count],
             )?;
         }
         
         Ok(())
    }

    // -----------------------------------------------------------------------
    // Library configuration helpers
    // -----------------------------------------------------------------------

    /// Read a single config value by key.
    pub fn get_config(&self, key: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        let result: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM library_config WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(result)
    }

    /// Write (insert or update) a config key/value pair.
    pub fn set_config(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO library_config (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // File-management import helpers
    // -----------------------------------------------------------------------

    /// Insert a track that was imported via drag-and-drop (no persistent_id from
    /// iTunes). Returns the new database row id.
    pub fn insert_imported_track(&self, track: &crate::models::Track, original_path: Option<&str>) -> Result<i64> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;

        self.conn.execute(
            "INSERT INTO tracks (
                persistent_id, file_path, artist, title, album,
                comment_raw, grouping_raw, duration_secs, format,
                size_bytes, bit_rate, modified_date, rating, date_added, bpm,
                original_path, import_date
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                track.persistent_id,
                track.file_path,
                track.artist,
                track.title,
                track.album,
                track.comment_raw,
                track.grouping_raw,
                track.duration_secs,
                track.format,
                track.size_bytes,
                track.bit_rate,
                track.modified_date,
                track.rating,
                now,
                track.bpm,
                original_path,
                now,
            ],
        )?;

        Ok(self.conn.last_insert_rowid())
    }

    /// Check whether a file is already in the library (by its current *or*
    /// original path).
    pub fn find_track_by_path(&self, file_path: &str) -> Result<Option<i64>> {
        use rusqlite::OptionalExtension;
        let id: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM tracks WHERE file_path = ?1 OR original_path = ?1 LIMIT 1",
                params![file_path],
                |row| row.get(0),
            )
            .optional()?;
        Ok(id)
    }

    /// Returns the DB row id for a track by its persistent_id.
    pub fn get_track_id_by_persistent_id(&self, persistent_id: &str) -> Result<Option<i64>> {
        use rusqlite::OptionalExtension;
        let id: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM tracks WHERE persistent_id = ?1 LIMIT 1",
                params![persistent_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(id)
    }
}
