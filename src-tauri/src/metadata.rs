use anyhow::{Context, Result};
use lofty::config::WriteOptions;
use lofty::file::FileType;
use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::ItemKey;
use lofty::tag::{Tag, TagType};
use std::path::Path;

use crate::file_manager::TrackImportMeta;

/// Decode a 4-byte ID3v2 synchsafe integer (7 significant bits per byte).
fn synchsafe(b: &[u8]) -> usize {
    ((b[0] as usize) << 21) | ((b[1] as usize) << 14) | ((b[2] as usize) << 7) | (b[3] as usize)
}

/// Some MP3s (notably certain iTunes/older-encoder files) leave a run of junk
/// padding between the end of the ID3v2 tag and the first MPEG audio frame.
///
/// lofty's tag writer re-detects the file format from *content* (ignoring the
/// extension) and only searches 1024 bytes past the ID3 tag for a frame sync
/// (`ParseOptions::DEFAULT_MAX_JUNK_BYTES`). When the gap is larger, every tag
/// write fails with "No format could be determined from the provided file",
/// even though reads succeed (reads use the `.mp3` extension). The same gap can
/// also defeat stricter decoders (e.g. the browser's Web Audio decoder, which
/// then forces the player's native-decoder "fallback").
///
/// This strips the non-audio gap so the first frame immediately follows the
/// tag, which both unblocks tag writes and cleans the file up for playback.
/// The audio frames themselves are untouched. Returns `Ok(true)` if the file
/// was rewritten.
pub fn normalize_mpeg_junk_gap<P: AsRef<Path>>(path: P) -> Result<bool> {
    let path = path.as_ref();
    let data = std::fs::read(path)?;
    // Only touch files that actually start with an ID3v2 tag. AIFF ("FORM"),
    // FLAC ("fLaC"), etc. are left alone.
    if data.len() < 10 || &data[..3] != b"ID3" {
        return Ok(false);
    }
    let flags = data[5];
    let tag_size = synchsafe(&data[6..10]);
    let footer = if flags & 0x10 != 0 { 10 } else { 0 };
    let id3_end = 10 + tag_size + footer;
    if id3_end >= data.len() {
        return Ok(false);
    }

    // Find the first plausible MPEG frame sync at or after the tag boundary.
    let mut frame_pos = None;
    let mut i = id3_end;
    while i + 1 < data.len() {
        if data[i] == 0xFF && (data[i + 1] & 0xE0) == 0xE0 {
            let version = (data[i + 1] >> 3) & 0x3; // 0b01 = reserved
            let layer = (data[i + 1] >> 1) & 0x3; // 0b00 = reserved
            if version != 0b01 && layer != 0b00 {
                frame_pos = Some(i);
                break;
            }
        }
        i += 1;
    }
    let frame_pos = match frame_pos {
        Some(p) if p > id3_end => p,
        // No gap, or no frame found at all — nothing safe to strip.
        _ => return Ok(false),
    };

    // Splice out the junk gap: [ID3 tag][audio ...].
    let mut out = Vec::with_capacity(data.len() - (frame_pos - id3_end));
    out.extend_from_slice(&data[..id3_end]);
    out.extend_from_slice(&data[frame_pos..]);

    // Write via temp file + rename for atomicity; preserve permissions.
    let tmp = path.with_extension("tagdeck-tmp");
    std::fs::write(&tmp, &out).context("Failed to write normalized MP3")?;
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path).context("Failed to replace file with normalized MP3")?;
    eprintln!(
        "[metadata] stripped {}-byte junk gap before first MPEG frame: {:?}",
        frame_pos - id3_end,
        path
    );
    Ok(true)
}

/// Saves `tag` to `path`. If lofty rejects the write because it can't determine
/// the format (the ID3v2-to-audio junk-gap failure mode above), normalize the
/// file once and retry. Any other failure is returned unchanged.
fn save_tag_repairing(path: &Path, tag: &Tag, ctx: &'static str) -> Result<()> {
    match tag.save_to_path(path, WriteOptions::default()) {
        Ok(()) => Ok(()),
        Err(first_err) => match normalize_mpeg_junk_gap(path) {
            Ok(true) => tag.save_to_path(path, WriteOptions::default()).context(ctx),
            _ => Err(first_err).context(ctx),
        },
    }
}

/// Overwrites the comment field with exactly the provided string.
/// Also mirrors to Grouping if that's the desired behavior (or we can separate them).
/// For the UI editor, we probably want to write exactly what the user typed.
pub fn write_metadata<P: AsRef<Path>>(path: P, comment: &str) -> Result<()> {
    let path_ref = path.as_ref();
    let mut tagged_file = read_from_path(path_ref).context(format!("Failed to read file: {:?}", path_ref))?;

    // Safety: Remove ID3v1 to prevent iTunes conflicts
    if tagged_file.tag(TagType::Id3v1).is_some() {
        tagged_file.remove(TagType::Id3v1);
    }

    // 1. Get or Create Tag
    let mut tag = match tagged_file.primary_tag_mut() {
        Some(t) => t.clone(), // Clone to modify, then we will save it back.
        // Actually lofty save_to_path takes &Tag.
        // But we need to update the specific TagType that was found.
        None => Tag::new(TagType::Id3v2),
    };

    // If it was some other random tag type (like APE on MP3), consider switching to ID3v2?
    // For now, let's just work with what we found or default to ID3v2.
    if (tagged_file.file_type() == FileType::Mpeg || tagged_file.file_type() == FileType::Aiff)
        && tag.tag_type() != TagType::Id3v2
    {
        tag = Tag::new(TagType::Id3v2);
    }

    // 2. Set Comment
    tag.remove_key(&ItemKey::Comment);
    if !comment.is_empty() {
        tag.insert_text(ItemKey::Comment, comment.to_string());
    }

    // 3. Mirror logic?
    // User requested to STOP writing to Grouping.
    // So we just leave ContentGroup alone or do nothing.
    // Logic: Comment Field holds the source of truth "User && Tags".

    // tag.remove_key(&ItemKey::ContentGroup);
    // if !grouping_val.is_empty() {
    //     tag.insert_text(ItemKey::ContentGroup, grouping_val);
    // }

    // 4. Save
    save_tag_repairing(path_ref, &tag, "Failed to save tags to disk")?;

    Ok(())
}

/// Reads tags from a file path
pub fn read_metadata<P: AsRef<Path>>(path: P) -> Result<(String, String)> {
    let tagged_file = read_from_path(path.as_ref()).context("Failed to read file")?;
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    let comment = tag
        .and_then(|t| t.get_string(&ItemKey::Comment))
        .unwrap_or("")
        .to_string();
    let grouping = tag
        .and_then(|t| t.get_string(&ItemKey::ContentGroup))
        .unwrap_or("")
        .to_string();

    Ok((comment, grouping))
}

pub fn get_artwork<P: AsRef<Path>>(path: P) -> Result<Option<Vec<u8>>> {
    let tagged_file = read_from_path(path.as_ref()).context("Failed to read file")?;
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    if let Some(tag) = tag {
        if let Some(picture) = tag.pictures().first() {
            return Ok(Some(picture.data().to_vec()));
        }
    }
    
    Ok(None)
}

/// Writes track info fields (title, artist, album, BPM) to the audio file's metadata tags.
/// Only updates fields that are Some; leaves existing values for None fields.
pub fn write_track_info<P: AsRef<Path>>(
    path: P,
    title: Option<&str>,
    artist: Option<&str>,
    album: Option<&str>,
    bpm: Option<i64>,
) -> Result<()> {
    let path_ref = path.as_ref();
    let mut tagged_file = read_from_path(path_ref)
        .context(format!("Failed to read file: {:?}", path_ref))?;

    // Safety: Remove ID3v1 to prevent iTunes conflicts
    if tagged_file.tag(TagType::Id3v1).is_some() {
        tagged_file.remove(TagType::Id3v1);
    }

    let mut tag = match tagged_file.primary_tag_mut() {
        Some(t) => t.clone(),
        None => Tag::new(TagType::Id3v2),
    };

    // Force ID3v2 for MP3/AIFF
    if (tagged_file.file_type() == FileType::Mpeg || tagged_file.file_type() == FileType::Aiff)
        && tag.tag_type() != TagType::Id3v2
    {
        tag = Tag::new(TagType::Id3v2);
    }

    if let Some(t) = title {
        tag.remove_key(&ItemKey::TrackTitle);
        if !t.is_empty() {
            tag.insert_text(ItemKey::TrackTitle, t.to_string());
        }
    }

    if let Some(a) = artist {
        tag.remove_key(&ItemKey::TrackArtist);
        if !a.is_empty() {
            tag.insert_text(ItemKey::TrackArtist, a.to_string());
        }
    }

    if let Some(al) = album {
        tag.remove_key(&ItemKey::AlbumTitle);
        if !al.is_empty() {
            tag.insert_text(ItemKey::AlbumTitle, al.to_string());
        }
    }

    if let Some(b) = bpm {
        tag.remove_key(&ItemKey::Bpm);
        if b > 0 {
            tag.insert_text(ItemKey::Bpm, b.to_string());
        }
    }

    save_tag_repairing(path_ref, &tag, "Failed to save track info to disk")?;

    Ok(())
}

/// Read comprehensive metadata from an audio file for the import flow.
///
/// This extracts everything needed by the file-manager to organise the file
/// and populate the database row.
pub fn read_full_metadata<P: AsRef<Path>>(path: P) -> Result<TrackImportMeta> {
    let path_ref = path.as_ref();
    let tagged_file =
        read_from_path(path_ref).context(format!("Failed to read file: {:?}", path_ref))?;

    let properties = tagged_file.properties();
    let duration_secs = properties.duration().as_secs_f64();
    let bit_rate = properties
        .audio_bitrate()
        .map(|b| b as i64)
        .unwrap_or(0);

    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    let get = |key: &ItemKey| -> Option<String> {
        tag.and_then(|t| t.get_string(key)).map(|s| s.to_string())
    };

    let artist = get(&ItemKey::TrackArtist);
    let title = get(&ItemKey::TrackTitle);
    let album = get(&ItemKey::AlbumTitle);
    let comment = get(&ItemKey::Comment);
    let grouping = get(&ItemKey::ContentGroup);
    let bpm = get(&ItemKey::Bpm).and_then(|s| s.trim().parse::<i64>().ok());

    let track_number = tag
        .and_then(|t| t.get_string(&ItemKey::TrackNumber))
        .and_then(|s| {
            // Handle "3/12" style track numbers
            let s = s.split('/').next().unwrap_or(s);
            s.trim().parse::<u32>().ok()
        });

    // Detect compilation flag (iTunes sets a specific flag)
    let is_compilation = tag
        .and_then(|t| t.get_string(&ItemKey::FlagCompilation))
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    Ok(TrackImportMeta {
        artist,
        title,
        album,
        track_number,
        duration_secs,
        bpm,
        comment,
        grouping,
        is_compilation,
        bit_rate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a synthetic ID3v2.4 header declaring `body_len` bytes of tag body.
    fn id3_header(body_len: usize) -> Vec<u8> {
        let ss = |n: usize| -> [u8; 4] {
            [
                ((n >> 21) & 0x7f) as u8,
                ((n >> 14) & 0x7f) as u8,
                ((n >> 7) & 0x7f) as u8,
                (n & 0x7f) as u8,
            ]
        };
        let mut h = vec![b'I', b'D', b'3', 4, 0, 0];
        h.extend_from_slice(&ss(body_len));
        h
    }

    #[test]
    fn strips_junk_gap_between_tag_and_first_frame() {
        // [ID3 header][32-byte body][1044 zero junk][MPEG frame 0xFF 0xFB ...]
        let body = vec![0u8; 32];
        let mut data = id3_header(body.len());
        data.extend_from_slice(&body);
        let id3_end = data.len();
        data.extend_from_slice(&vec![0u8; 1044]); // the offending gap (> lofty's 1024)
        let frame = [0xFFu8, 0xFB, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44];
        data.extend_from_slice(&frame);

        let dir = std::env::temp_dir();
        let path = dir.join("tagdeck_junkgap_test.mp3");
        std::fs::File::create(&path).unwrap().write_all(&data).unwrap();

        let stripped = normalize_mpeg_junk_gap(&path).unwrap();
        assert!(stripped, "expected the junk gap to be stripped");

        let out = std::fs::read(&path).unwrap();
        // Frame must now sit immediately after the tag, gap removed.
        assert_eq!(&out[id3_end..id3_end + frame.len()], &frame);
        assert_eq!(out.len(), id3_end + frame.len());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn leaves_contiguous_file_untouched() {
        // No gap: frame immediately follows the tag.
        let body = vec![0u8; 16];
        let mut data = id3_header(body.len());
        data.extend_from_slice(&body);
        data.extend_from_slice(&[0xFFu8, 0xFB, 0x90, 0x00]);
        let before = data.clone();

        let dir = std::env::temp_dir();
        let path = dir.join("tagdeck_nogap_test.mp3");
        std::fs::File::create(&path).unwrap().write_all(&data).unwrap();

        let stripped = normalize_mpeg_junk_gap(&path).unwrap();
        assert!(!stripped, "contiguous file should not be rewritten");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn ignores_non_id3_files() {
        let data = b"FORM....AIFF and whatnot".to_vec();
        let dir = std::env::temp_dir();
        let path = dir.join("tagdeck_notid3_test.aiff");
        std::fs::File::create(&path).unwrap().write_all(&data).unwrap();
        assert!(!normalize_mpeg_junk_gap(&path).unwrap());
        std::fs::remove_file(&path).ok();
    }
}
