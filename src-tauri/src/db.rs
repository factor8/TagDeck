use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::Path;

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
        modified_date INTEGER
    );

    CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persistent_id TEXT UNIQUE,
        name TEXT
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id INTEGER,
        track_id INTEGER,
        position INTEGER,
        FOREIGN KEY(playlist_id) REFERENCES playlists(id),
        FOREIGN KEY(track_id) REFERENCES tracks(id),
        PRIMARY KEY (playlist_id, track_id)
    );

    CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE COLLATE NOCASE,
        usage_count INTEGER DEFAULT 0
    );
"#;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(DB_SCHEMA)?;
        
        // Migration: Attempt to add bit_rate column for existing databases
        // Valid for SQLite to ignore if column exists via check or we suppress error, 
        // but rusqlite execute will return error if column exists. 
        // We'll just suppress it for this prototype stage.
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN bit_rate INTEGER DEFAULT 0", []);
        
        Ok(Self { conn })
    }

    pub fn insert_track(&self, track: &crate::models::Track) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO tracks (
                persistent_id, file_path, artist, title, album, 
                comment_raw, grouping_raw, duration_secs, format, 
                size_bytes, bit_rate, modified_date
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
                track.modified_date
            ],
        )?;
        Ok(())
    }

    pub fn update_track_metadata(&self, id: i64, comment: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET comment_raw = ?1 WHERE id = ?2",
            params![comment, id],
        )?;
        Ok(())
    }

    pub fn get_all_tracks(&self) -> Result<Vec<crate::models::Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, persistent_id, file_path, artist, title, album, 
             comment_raw, grouping_raw, duration_secs, format, size_bytes, bit_rate, modified_date 
             FROM tracks LIMIT 100", // Limit for safety during dev
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
            })
        })?;

        let mut tracks = Vec::new();
        for track in track_iter {
            tracks.push(track?);
        }
        Ok(tracks)
    }
}
