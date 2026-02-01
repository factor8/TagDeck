use anyhow::{Context, Result};
use lofty::config::WriteOptions;
use lofty::file::FileType;
use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::ItemKey;
use lofty::tag::{Tag, TagType};
use std::path::Path;

const DELIMITER: &str = " && ";

/// Overwrites the comment field with exactly the provided string.
/// Also mirrors to Grouping if that's the desired behavior (or we can separate them).
/// For the UI editor, we probably want to write exactly what the user typed.
pub fn write_metadata<P: AsRef<Path>>(path: P, comment: &str) -> Result<()> {
    let mut tagged_file = read_from_path(path.as_ref()).context("Failed to read file")?;

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

/// Writes tags to a file path using the "Left-Side" preservation strategy
pub fn write_tags<P: AsRef<Path>>(path: P, new_tags_string: &str) -> Result<()> {
    let path = path.as_ref();
    let mut tagged_file = read_from_path(path).context("Failed to read file for writing")?;

    // 1. Clean ID3v1 to avoid iTunes conflicts (as proven in verify_tags.rs)
    if tagged_file.tag(TagType::Id3v1).is_some() {
        tagged_file.remove(TagType::Id3v1);
    }

    // 2. Get proper ID3v2 tag
    let mut tag = match tagged_file.primary_tag() {
        Some(t) => t.clone(),
        None => {
            if let Some(t) = tagged_file.first_tag() {
                t.clone()
            } else {
                Tag::new(tagged_file.primary_tag_type())
            }
        }
    };

    // Force ID3v2 for MP3/AIFF
    if (tagged_file.file_type() == FileType::Mpeg || tagged_file.file_type() == FileType::Aiff)
        && tag.tag_type() != TagType::Id3v2
    {
        tag = Tag::new(TagType::Id3v2);
    }

    // 3. Logic: Preserve Left Side
    let existing_comment = tag.get_string(&ItemKey::Comment).unwrap_or("").to_string();

    let user_part = if let Some((user, _)) = existing_comment.split_once(DELIMITER) {
        user
    } else {
        &existing_comment
    };

    let final_comment = if user_part.trim().is_empty() {
        if new_tags_string.is_empty() {
            String::new()
        } else {
            format!("{}{}", DELIMITER.trim(), new_tags_string)
        }
    } else {
        if new_tags_string.is_empty() {
            user_part.to_string()
        } else {
            format!("{}{}{}", user_part, DELIMITER, new_tags_string)
        }
    };

    // Update Comment
    tag.remove_key(&ItemKey::Comment);
    if !final_comment.is_empty() {
        tag.insert_text(ItemKey::Comment, final_comment);
    }

    // Update Grouping Mirror (Secondary)
    tag.insert_text(ItemKey::ContentGroup, new_tags_string.to_string());

    // 4. Save
    // Note: We use save_to_path on the *tag* to overwrite just that chunk ideally,
    // or we can use tagged_file.save_to_path if we put the tag back in.
    // In verify_tags we used tag.save_to_path.
    tag.save_to_path(path, WriteOptions::default())
        .context("Failed to save tags to disk")?;

    Ok(())
}
