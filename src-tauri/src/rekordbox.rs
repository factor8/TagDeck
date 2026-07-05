//! rekordbox.xml (DJ_PLAYLISTS) export.
//!
//! One-way bridge: Rekordbox is pointed at the generated file via
//! Preferences → Advanced → Database → "rekordbox xml", and the collection
//! and playlist tree appear under "rekordbox xml" in its browser. We never
//! touch Rekordbox's own master.db. Tags ride along in the Comments field.

use crate::models::{Playlist, Track};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
pub struct RekordboxStats {
    pub tracks: usize,
    pub playlists: usize,
    pub folders: usize,
    pub skipped_missing: usize,
}

/// Builds the full rekordbox.xml document. `playlists` pairs each playlist
/// with its ordered track DB ids. Missing tracks are excluded from the
/// collection and from playlist entries.
pub fn build_rekordbox_xml(
    tracks: &[Track],
    playlists: &[(Playlist, Vec<i64>)],
    app_version: &str,
) -> (String, RekordboxStats) {
    let mut stats = RekordboxStats::default();

    let included: Vec<&Track> = tracks.iter().filter(|t| !t.missing).collect();
    stats.skipped_missing = tracks.len() - included.len();
    stats.tracks = included.len();
    let included_ids: HashSet<i64> = included.iter().map(|t| t.id).collect();

    let mut xml = String::with_capacity(included.len() * 256 + 4096);
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    xml.push_str("<DJ_PLAYLISTS Version=\"1.0.0\">\n");
    xml.push_str(&format!(
        "  <PRODUCT Name=\"TagDeck\" Version=\"{}\" Company=\"TagDeck\"/>\n",
        xml_escape(app_version)
    ));

    // COLLECTION
    xml.push_str(&format!("  <COLLECTION Entries=\"{}\">\n", included.len()));
    for t in &included {
        xml.push_str("    <TRACK");
        push_attr(&mut xml, "TrackID", &t.id.to_string());
        let name = t.title.clone().unwrap_or_else(|| {
            std::path::Path::new(&t.file_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown")
                .to_string()
        });
        push_attr(&mut xml, "Name", &name);
        push_attr(&mut xml, "Artist", t.artist.as_deref().unwrap_or(""));
        push_attr(&mut xml, "Album", t.album.as_deref().unwrap_or(""));
        push_attr(&mut xml, "Kind", &kind_for_format(&t.format));
        push_attr(&mut xml, "Size", &t.size_bytes.max(0).to_string());
        push_attr(&mut xml, "TotalTime", &(t.duration_secs.round().max(0.0) as i64).to_string());
        if t.bpm > 0 {
            push_attr(&mut xml, "AverageBpm", &format!("{:.2}", t.bpm as f64));
        }
        if t.date_added > 0 {
            if let Some(dt) = chrono::DateTime::from_timestamp(t.date_added, 0) {
                push_attr(&mut xml, "DateAdded", &dt.format("%Y-%m-%d").to_string());
            }
        }
        push_attr(&mut xml, "Rating", &rating_to_rekordbox(t.rating).to_string());
        // Tags live in the comment field — this is what carries them across.
        push_attr(&mut xml, "Comments", t.comment_raw.as_deref().unwrap_or(""));
        push_attr(&mut xml, "Location", &encode_location(&t.file_path));
        xml.push_str("/>\n");
    }
    xml.push_str("  </COLLECTION>\n");

    // PLAYLISTS tree
    let known: HashSet<&str> = playlists.iter().map(|(p, _)| p.persistent_id.as_str()).collect();
    let mut children: HashMap<Option<String>, Vec<&(Playlist, Vec<i64>)>> = HashMap::new();
    for entry in playlists {
        // Orphaned parent references fall back to the root
        let parent = entry
            .0
            .parent_persistent_id
            .clone()
            .filter(|p| known.contains(p.as_str()));
        children.entry(parent).or_default().push(entry);
    }

    let roots = children.remove(&None).unwrap_or_default();
    xml.push_str("  <PLAYLISTS>\n");
    xml.push_str(&format!(
        "    <NODE Type=\"0\" Name=\"ROOT\" Count=\"{}\">\n",
        roots.len()
    ));
    for entry in &roots {
        emit_node(&mut xml, entry, &children, &included_ids, 3, &mut stats);
    }
    xml.push_str("    </NODE>\n");
    xml.push_str("  </PLAYLISTS>\n");
    xml.push_str("</DJ_PLAYLISTS>\n");

    (xml, stats)
}

fn emit_node(
    xml: &mut String,
    entry: &(Playlist, Vec<i64>),
    children: &HashMap<Option<String>, Vec<&(Playlist, Vec<i64>)>>,
    included_ids: &HashSet<i64>,
    depth: usize,
    stats: &mut RekordboxStats,
) {
    let (playlist, track_ids) = entry;
    let indent = "  ".repeat(depth);
    if playlist.is_folder {
        stats.folders += 1;
        let kids = children
            .get(&Some(playlist.persistent_id.clone()))
            .map(|v| v.as_slice())
            .unwrap_or(&[]);
        xml.push_str(&format!(
            "{}<NODE Type=\"0\" Name=\"{}\" Count=\"{}\">\n",
            indent,
            xml_escape(&playlist.name),
            kids.len()
        ));
        for kid in kids {
            emit_node(xml, kid, children, included_ids, depth + 1, stats);
        }
        xml.push_str(&format!("{}</NODE>\n", indent));
    } else {
        stats.playlists += 1;
        let keys: Vec<i64> = track_ids
            .iter()
            .copied()
            .filter(|id| included_ids.contains(id))
            .collect();
        xml.push_str(&format!(
            "{}<NODE Type=\"1\" Name=\"{}\" KeyType=\"0\" Entries=\"{}\">\n",
            indent,
            xml_escape(&playlist.name),
            keys.len()
        ));
        for id in keys {
            xml.push_str(&format!("{}  <TRACK Key=\"{}\"/>\n", indent, id));
        }
        xml.push_str(&format!("{}</NODE>\n", indent));
    }
}

fn push_attr(xml: &mut String, name: &str, value: &str) {
    xml.push(' ');
    xml.push_str(name);
    xml.push_str("=\"");
    xml.push_str(&xml_escape(value));
    xml.push('"');
}

/// Escapes a string for use in an XML attribute; control characters
/// (invalid in XML 1.0) are dropped.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

/// Rekordbox expects `file://localhost` + a percent-encoded absolute path.
fn encode_location(path: &str) -> String {
    let mut out = String::from("file://localhost");
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// TagDeck ratings are iTunes-style 0–100 (20 per star); Rekordbox uses
/// 0–255 in steps of 51 per star.
fn rating_to_rekordbox(rating: i64) -> i64 {
    (rating.clamp(0, 100) / 20) * 51
}

fn kind_for_format(format: &str) -> String {
    match format.to_ascii_lowercase().as_str() {
        "mp3" => "MP3 File".to_string(),
        "m4a" | "aac" | "alac" => "M4A File".to_string(),
        "wav" => "WAV File".to_string(),
        "aiff" | "aif" => "AIFF File".to_string(),
        "flac" => "FLAC File".to_string(),
        other if !other.is_empty() => format!("{} File", other.to_ascii_uppercase()),
        _ => "Unknown File".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: i64, title: &str, path: &str) -> Track {
        Track {
            id,
            persistent_id: format!("TD-{}", id),
            file_path: path.to_string(),
            artist: Some("Artist & Co".to_string()),
            title: Some(title.to_string()),
            album: None,
            comment_raw: Some("#house #\"peak\"".to_string()),
            grouping_raw: None,
            duration_secs: 245.6,
            format: "mp3".to_string(),
            size_bytes: 1000,
            bit_rate: 320,
            modified_date: 0,
            rating: 80,
            date_added: 1_700_000_000,
            bpm: 128,
            missing: false,
            itunes_pid: None,
            unlinked_at: None,
            source: "local".to_string(),
            spotify_id: None,
        }
    }

    fn playlist(id: i64, pid: &str, name: &str, is_folder: bool, parent: Option<&str>) -> Playlist {
        Playlist {
            id,
            persistent_id: pid.to_string(),
            parent_persistent_id: parent.map(|s| s.to_string()),
            name: name.to_string(),
            is_folder,
            track_ids: None,
            origin: "tagdeck".to_string(),
            itunes_sync_enabled: false,
            description: None,
            color: None,
            sort_position: 0,
            created_at: 0,
            updated_at: 0,
            spotify_playlist_id: None,
            spotify_snapshot_id: None,
        }
    }

    #[test]
    fn escapes_and_encodes() {
        assert_eq!(xml_escape("a & \"b\" <c>"), "a &amp; &quot;b&quot; &lt;c&gt;");
        assert_eq!(
            encode_location("/Users/dj/My Música/tück.mp3"),
            "file://localhost/Users/dj/My%20M%C3%BAsica/t%C3%BCck.mp3"
        );
        assert_eq!(rating_to_rekordbox(100), 255);
        assert_eq!(rating_to_rekordbox(80), 204);
        assert_eq!(rating_to_rekordbox(0), 0);
        assert_eq!(rating_to_rekordbox(110), 255);
    }

    #[test]
    fn builds_document_with_tree_and_skips_missing() {
        let mut missing = track(3, "Gone", "/x/gone.mp3");
        missing.missing = true;
        let tracks = vec![
            track(1, "One", "/x/one.mp3"),
            track(2, "Two", "/x/two.mp3"),
            missing,
        ];
        let playlists = vec![
            (playlist(10, "F1", "Crates", true, None), vec![]),
            (playlist(11, "P1", "Warm Up", false, Some("F1")), vec![1, 3]),
            (playlist(12, "P2", "Orphan", false, Some("NOPE")), vec![2]),
        ];
        let (xml, stats) = build_rekordbox_xml(&tracks, &playlists, "0.0.0");

        assert_eq!(stats.tracks, 2);
        assert_eq!(stats.skipped_missing, 1);
        assert_eq!(stats.playlists, 2);
        assert_eq!(stats.folders, 1);

        assert!(xml.contains("<COLLECTION Entries=\"2\">"));
        // Missing track excluded from collection and playlist entries
        assert!(!xml.contains("TrackID=\"3\""));
        assert!(xml.contains("Name=\"Warm Up\" KeyType=\"0\" Entries=\"1\""));
        // Orphaned parent falls back to root (2 root children)
        assert!(xml.contains("<NODE Type=\"0\" Name=\"ROOT\" Count=\"2\">"));
        // Nested playlist sits inside the folder node
        assert!(xml.contains("<NODE Type=\"0\" Name=\"Crates\" Count=\"1\">"));
        assert!(xml.contains("AverageBpm=\"128.00\""));
        assert!(xml.contains("Rating=\"204\""));
        assert!(xml.contains("Comments=\"#house #&quot;peak&quot;\""));
        assert!(xml.contains("Location=\"file://localhost/x/one.mp3\""));
        assert!(xml.contains("DateAdded=\"2023-11-14\""));
    }
}
