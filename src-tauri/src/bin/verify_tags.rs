use lofty::config::WriteOptions;
use lofty::file::FileType;
use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::{Tag, TagType};
use std::env;
use std::path::Path;

const DELIMITER: &str = " && ";

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        println!("Usage: verify_tags <file_path> <tags_to_append>");
        return;
    }

    let path_str = &args[1];
    let new_tags = &args[2];
    let path = Path::new(path_str);

    // DEBUG: Print file metadata before any changes
    println!("--- BEFORE ---");
    let output = std::process::Command::new("mdls")
        .arg(path_str)
        .output()
        .expect("failed to execute mdls");
    println!("{}", String::from_utf8_lossy(&output.stdout));
    println!("--------------");

    println!("Reading file: {}", path_str);

    let mut tagged_file = match read_from_path(path) {
        Ok(f) => f,
        Err(e) => {
            println!("Error reading file: {}", e);
            return;
        }
    };

    println!("Detected format: {:?}", tagged_file.file_type());

    // 1. REMOVE ID3v1 TAGS explicitly
    if tagged_file.tag(TagType::Id3v1).is_some() {
        println!("Removing detected ID3v1 tag...");
        tagged_file.remove(TagType::Id3v1);
    }

    // 2. Get or create the primary tag (Prefer ID3v2 for MP3/AIFF default)
    // Note: AIFF files also use ID3v2 chunks. Lofty handles this abstraction primarily.
    // If it's pure AIFF without ID3v2, it might be using AIFF specific chunks, but standard practice is ID3 chunk.
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

    // Check if we need to force ID3v2 for AIFF/MP3 if not present
    if (tagged_file.file_type() == FileType::Mpeg || tagged_file.file_type() == FileType::Aiff)
        && tag.tag_type() != TagType::Id3v2
    {
        println!("Forcing ID3v2 conversion for better compatibility.");
        // In a real app we might convert field-by-field, here we start clean if type mismatches
        tag = Tag::new(TagType::Id3v2);
    }

    println!("Using Tag Type: {:?}", tag.tag_type());

    // 3. Logic: Delimited Comments
    // Format: "User Comment && Tag1; Tag2; Tag3"
    let existing_comment = tag.get_string(&ItemKey::Comment).unwrap_or("").to_string();
    println!("Existing Comment: '{}'", existing_comment);

    let user_part = if let Some((user, _)) = existing_comment.split_once(DELIMITER) {
        user
    } else {
        // No delimiter found, treat whole string as user comment
        // UNLESS the whole string looks like tags? No, assume user comment.
        &existing_comment
    };

    // Construct new comment
    let final_comment = if user_part.trim().is_empty() {
        format!("{}{}", DELIMITER.trim(), new_tags) // " && Tags" (weird? maybe just "Tags")
                                                    // actually let's just do " && Tags" so we know there's a blank user comment
    } else {
        format!("{}{}{}", user_part, DELIMITER, new_tags)
    };

    println!("New Comment Construct: '{}'", final_comment);

    // Explicit cleaning
    tag.remove_key(&ItemKey::Comment);
    tag.insert_text(ItemKey::Comment, final_comment);

    // Also set grouping for backup/Other apps
    tag.insert_text(ItemKey::ContentGroup, new_tags.to_string());

    // 4. Save
    // We try to save the specific tag.
    // For AIFF, saving an ID3v2 tag usually writes the ID3 chunk.
    match tag.save_to_path(path, WriteOptions::default()) {
        Ok(_) => println!("Success! Tags written."),
        Err(e) => eprintln!("Error writing file: {}", e),
    }
}
