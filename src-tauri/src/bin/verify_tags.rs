use lofty::prelude::*;
use lofty::read_from_path;
use lofty::config::WriteOptions;
use std::env;
use std::path::Path;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        println!("Usage: verify_tags <file_path> <grouping_text>");
        return;
    }

    let path_str = &args[1];
    let grouping_text = &args[2];
    let path = Path::new(path_str);

    println!("Reading file: {}", path_str);

    let mut tagged_file = match read_from_path(path) {
        Ok(f) => f,
        Err(e) => {
            println!("Error reading file: {}", e);
            return;
        }
    };

    println!("Detected format: {:?}", tagged_file.file_type());

    // Get the primary tag, or insert a default one if possible
    let tag = match tagged_file.primary_tag_mut() {
        Some(t) => t,
        None => {
            if let Some(t) = tagged_file.first_tag_mut() {
                t
            } else {
                println!("No editable tags found on this file.");
                return;
            }
        }
    };

    tag.insert_text(ItemKey::ContentGroupDescription, grouping_text.to_string());
    
    println!("Set Grouping to: '{}'", grouping_text);

    if let Err(e) = tagged_file.save_to_path(path) {
        println!("Error saving file: {}", e);
    } else {
        println!("Success! Tags written to disk.");
    }
}
