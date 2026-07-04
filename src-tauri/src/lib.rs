pub mod commands;
pub mod apple_music;
pub mod db;
pub mod library_parser;
pub mod system_library;
pub mod metadata;
pub mod logging;
pub mod models;
pub mod toggle_logs;
pub mod undo;
pub mod library_watcher;
pub mod file_manager;
pub mod sync_review;
pub mod rekordbox;

use commands::AppState;
use db::Database;
use undo::UndoStack;

use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem, Submenu, PredefinedMenuItem};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            let log_state = logging::LogState::new();
            log_state.init_log_dir();
            app.manage(log_state);

            // Menu construction
            let window_menu = Submenu::with_items(app, "Window", true, &[
                &PredefinedMenuItem::minimize(app, None).unwrap(),
                &PredefinedMenuItem::separator(app).unwrap(),
                &MenuItem::with_id(app, "open_logs", "Logs", true, Some("CmdOrCtrl+Option+L")).unwrap(),
            ]).unwrap();

            let menu = Menu::with_items(app, &[
                &Submenu::with_items(app, "App", true, &[
                    &PredefinedMenuItem::about(app, None, None).unwrap(),
                    &PredefinedMenuItem::separator(app).unwrap(),
                    &PredefinedMenuItem::hide(app, None).unwrap(),
                    &PredefinedMenuItem::hide_others(app, None).unwrap(),
                    &PredefinedMenuItem::show_all(app, None).unwrap(),
                    &PredefinedMenuItem::separator(app).unwrap(),
                    &PredefinedMenuItem::quit(app, None).unwrap(),
                ]).unwrap(),
                &Submenu::with_items(app, "File", true, &[
                    &PredefinedMenuItem::close_window(app, None).unwrap(),
                ]).unwrap(),
                &Submenu::with_items(app, "Edit", true, &[
                    &PredefinedMenuItem::undo(app, None).unwrap(),
                    &PredefinedMenuItem::redo(app, None).unwrap(),
                    &PredefinedMenuItem::separator(app).unwrap(),
                    &PredefinedMenuItem::cut(app, None).unwrap(),
                    &PredefinedMenuItem::copy(app, None).unwrap(),
                    &PredefinedMenuItem::paste(app, None).unwrap(),
                    &PredefinedMenuItem::select_all(app, None).unwrap(),
                ]).unwrap(),
                &Submenu::with_items(app, "View", true, &[
                    &PredefinedMenuItem::fullscreen(app, None).unwrap(),
                ]).unwrap(),
                &window_menu,
            ]).unwrap();

            app.set_menu(menu).unwrap();

            app.on_menu_event(move |app_handle, event| {
                if event.id() == "open_logs" {
                    if let Some(window) = app_handle.get_webview_window("logs") {
                        let _ = window.close();
                    } else {
                        let _ = tauri::WebviewWindowBuilder::new(
                            app_handle,
                            "logs",
                            tauri::WebviewUrl::App("index.html?page=logs".into())
                        )
                        .title("Logs")
                        .inner_size(800.0, 600.0)
                        .build();
                    }
                }
            });

            // Initialize Database
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
            let db_path = app_data_dir.join("tagdeck.db");

            let db = Database::new(db_path).expect("failed to initialize database");

            // First run (or pre-sync-mode upgrade): default to TwoWay when
            // Music.app is present — existing users keep today's behavior —
            // otherwise Off for a standalone library.
            if db.get_config("sync_mode").ok().flatten().is_none() {
                let default_mode = if apple_music::is_apple_music_available() {
                    "two_way"
                } else {
                    "off"
                };
                if let Err(e) = db.set_config("sync_mode", default_mode) {
                    eprintln!("Failed to persist default sync_mode: {}", e);
                } else {
                    println!("Initialized sync_mode to '{}'", default_mode);
                }
            }

            app.manage(AppState {
                db: Mutex::new(db),
                undo_stack: Mutex::new(UndoStack::new()),
                is_syncing: AtomicBool::new(false), 
            });

            // Start Library Watcher
            library_watcher::start_library_watcher(app.handle().clone());

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            logging::get_logs,
            logging::log_error,
            logging::log_from_frontend,
            logging::get_debug_mode,
            logging::set_debug_mode,
            logging::open_log_folder,
            logging::get_log_file_path,
            logging::get_log_stats,
            toggle_logs::toggle_logs,
            commands::import_library,
            commands::get_tracks,
            commands::get_global_tags,
            commands::show_in_finder,
            commands::analyze_with_mixed_in_key,
            commands::write_tags,
            commands::batch_add_tag,
            commands::batch_remove_tag,
            commands::import_from_music_app,
            commands::get_playlists,
            commands::create_playlist,
            commands::rename_playlist,
            commands::delete_playlist,
            commands::move_playlist,
            commands::duplicate_playlist,
            commands::reorder_sibling_playlists,
            commands::update_playlist_metadata,
            commands::set_playlist_sync,
            commands::add_to_playlist,
            commands::get_playlist_track_ids,
            commands::mark_track_missing,
            commands::get_track_artwork,
            commands::get_tag_groups,
            commands::create_tag_group,
            commands::update_tag_group,
            commands::delete_tag_group,
            commands::set_tag_group,
            commands::reorder_tag_groups,
            commands::get_all_tags,
            commands::delete_tag,
            commands::get_playlists_for_track,
            commands::copy_playlist_memberships,
            commands::undo,
            commands::redo,
            commands::update_rating,
            commands::update_track_info,
            commands::sync_recent_changes,
            commands::remove_from_playlist,
            commands::reorder_playlist_tracks,
            commands::get_library_config,
            commands::set_library_config,
            commands::import_files,
            commands::verify_library_files,
            commands::consolidate_library,
            commands::export_tracks_to_music,
            commands::export_playlist_m3u8,
            commands::export_rekordbox_xml,
            commands::get_rekordbox_export_path,
            commands::check_apple_music_available,
            sync_review::preview_sync,
            sync_review::apply_sync_changes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
