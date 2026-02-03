pub mod commands;
pub mod apple_music;
pub mod db;
pub mod library_parser;
pub mod system_library;
pub mod metadata;
pub mod logging;
pub mod models;
pub mod toggle_logs;

use commands::AppState;
use db::Database;

use std::sync::Mutex;
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
        .setup(|app| {
            app.manage(logging::LogState::new());

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

            app.manage(AppState { db: Mutex::new(db) });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            logging::get_logs,
            logging::log_error,
            toggle_logs::toggle_logs,
            commands::import_library,
            commands::get_tracks,
            commands::get_global_tags,
            commands::show_in_finder,
            commands::write_tags,
            commands::batch_add_tag,
            commands::batch_remove_tag,
            commands::import_from_music_app,
            commands::get_playlists,
            commands::get_playlist_track_ids,
            commands::mark_track_missing,
            commands::get_track_artwork
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
