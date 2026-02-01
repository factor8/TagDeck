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
        modified_date INTEGER,
        rating INTEGER,
        date_added INTEGER,
        bpm INTEGER
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
        
        // Migration: Attempt to add columns for existing databases
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN bit_rate INTEGER DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN rating INTEGER DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN date_added INTEGER DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN bpm INTEGER DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN is_folder BOOLEAN DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN parent_persistent_id TEXT", []);
        
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

    pub fn insert_playlist(&self, playlist: &crate::models::Playlist) -> Result<()> {
        // Use a transaction for atomicity
        let mut conn = &self.conn;
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
             comment_raw, grouping_raw, duration_secs, format, size_bytes, bit_rate, modified_date,
             rating, date_added, bpm
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
            })
        })?;

        let mut tracks = Vec::new();
        for track in track_iter {
            tracks.push(track?);
        }
        Ok(tracks)
    }
}
