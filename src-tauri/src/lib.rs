pub mod commands;
pub mod db;
pub mod library_parser;
pub mod system_library;
pub mod metadata;
pub mod models;

use commands::AppState;
use db::Database;
use std::sync::Mutex;
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Initialize Database
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
            let db_path = app_data_dir.join("tagdeck.db");

            let db = Database::new(db_path).expect("failed to initialize database");

            app.manage(AppState { db: Mutex::new(db) });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::import_library,
            commands::get_tracks,
            commands::get_global_tags,
            commands::show_in_finder,
            commands::write_tags,
            commands::import_from_music_app,
            commands::get_playlists,
            commands::get_playlist_track_ids
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
