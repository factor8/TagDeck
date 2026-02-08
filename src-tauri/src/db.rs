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
        
        Ok(Self { conn })
    }

    pub fn insert_track(&self, track: &crate::models::Track) -> Result<()> {
        self.conn.execute(
            "INSERT INTO tracks (
                persistent_id, file_path, artist, title, album, 
                comment_raw, grouping_raw, duration_secs, format, 
                size_bytes, bit_rate, modified_date, rating, date_added, bpm
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(persistent_id) DO UPDATE SET
                file_path=excluded.file_path,
                artist=excluded.artist,
                title=excluded.title,
                album=excluded.album,
                comment_raw=excluded.comment_raw,
                grouping_raw=excluded.grouping_raw,
                duration_secs=excluded.duration_secs,
                format=excluded.format,
                size_bytes=excluded.size_bytes,
                bit_rate=excluded.bit_rate,
                modified_date=excluded.modified_date,
                rating=excluded.rating,
                date_added=excluded.date_added,
                bpm=excluded.bpm
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
                track.bpm
            ],
        )?;
        Ok(())
    }

    pub fn get_track(&self, id: i64) -> Result<Option<Track>> {
        let mut stmt = self.conn.prepare("SELECT * FROM tracks WHERE id = ?1")?;
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

    pub fn get_playlists(&self) -> Result<Vec<crate::models::Playlist>> {
        let mut stmt = self.conn.prepare("SELECT id, persistent_id, parent_persistent_id, name, is_folder FROM playlists ORDER BY is_folder DESC, name ASC")?;
        let playlists = stmt.query_map([], |row| {
            Ok(crate::models::Playlist {
                id: row.get(0)?,
                persistent_id: row.get(1)?,
                parent_persistent_id: row.get(2)?,
                name: row.get(3)?,
                is_folder: row.get(4)?,
                track_ids: None, // Not loaded by default
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

        self.conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_db_id],
        )?;

        if let Some(track_pids) = &playlist.track_ids {
            // Prepared statement for performance
            let mut stmt = self.conn.prepare(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position) 
                 SELECT ?1, id, ?3 FROM tracks WHERE persistent_id = ?2"
            )?;
            
            for (index, pid) in track_pids.iter().enumerate() {
                // Ignore errors
                let _ = stmt.execute(params![playlist_db_id, pid, index as i64]);
            }
        }
        
        Ok(())
    }

    pub fn get_track_persistent_id(&self, id: i64) -> Result<String> {
        let pid: String = self.conn.query_row(
            "SELECT persistent_id FROM tracks WHERE id = ?1",
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

    pub fn get_all_tracks(&self) -> Result<Vec<crate::models::Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, persistent_id, file_path, artist, title, album, 
             comment_raw, grouping_raw, duration_secs, format, size_bytes, bit_rate, modified_date,
             rating, date_added, bpm, missing
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
    
    pub fn sync_tags(&self) -> Result<()> {
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
}
