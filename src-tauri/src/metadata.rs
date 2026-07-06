use anyhow::{Context, Result};
use lofty::config::WriteOptions;
use lofty::file::FileType;
use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::ItemKey;
use lofty::tag::{Tag, TagType};
use std::path::Path;

use crate::file_manager::TrackImportMeta;

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
    tag.save_to_path(path, WriteOptions::default())
        .context("Failed to save tags to disk")?;

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

    tag.save_to_path(path, WriteOptions::default())
        .context("Failed to save track info to disk")?;

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
