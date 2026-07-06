use serde::Serialize;
use tauri::{Manager, State};

use crate::commands::AppState;
use super::SpotifyState;

#[derive(Serialize)]
pub struct SpotifySettings {
    pub client_id: Option<String>,
    pub connected: bool,
    pub account_name: Option<String>,
}

#[tauri::command]
pub async fn spotify_get_settings(
    state: State<'_, AppState>,
    spotify: State<'_, SpotifyState>,
) -> Result<SpotifySettings, String> {
    let client_id = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.get_config("spotify_client_id").map_err(|e| e.to_string())?
    };
    let connected = spotify.tokens.lock().map(|t| t.is_some()).unwrap_or(false)
        || super::auth::load_tokens().is_some();
    let account_name = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.get_config("spotify_account_name").map_err(|e| e.to_string())?
    };
    Ok(SpotifySettings { client_id, connected, account_name })
}

#[tauri::command]
pub async fn spotify_set_client_id(
    client_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.set_config("spotify_client_id", client_id.trim())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn spotify_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    spotify: State<'_, SpotifyState>,
) -> Result<String, String> {
    let client_id = {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.get_config("spotify_client_id")
            .map_err(|e| e.to_string())?
            .filter(|s| !s.is_empty())
            .ok_or("Set your Spotify Client ID first")?
    };
    let name = super::auth::connect(app.clone(), &spotify, &client_id).await?;
    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.set_config("spotify_account_name", &name).map_err(|e| e.to_string())?;
    }
    app.state::<crate::logging::LogState>().add_log(
        "INFO",
        &format!("Spotify connected as {}", name),
        &app,
    );
    Ok(name)
}

#[tauri::command]
pub async fn spotify_disconnect(
    state: State<'_, AppState>,
    spotify: State<'_, SpotifyState>,
) -> Result<(), String> {
    super::auth::disconnect(&spotify);
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.set_config("spotify_account_name", "").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn spotify_list_playlists(
    state: State<'_, AppState>,
    spotify: State<'_, SpotifyState>,
) -> Result<Vec<super::client::SpotifyPlaylistSummary>, String> {
    let client_id = get_client_id(&state)?;
    super::client::list_my_playlists(&spotify, &client_id).await
}

#[tauri::command]
pub async fn spotify_import_playlists(
    app: tauri::AppHandle,
    playlist_ids: Vec<String>,
    state: State<'_, AppState>,
    spotify: State<'_, SpotifyState>,
) -> Result<super::sync::ImportReport, String> {
    let client_id = get_client_id(&state)?;
    let all = super::client::list_my_playlists(&spotify, &client_id).await?;
    let selected: Vec<_> = all.into_iter().filter(|p| playlist_ids.contains(&p.id)).collect();
    let report = match super::sync::import_playlists(&spotify, &client_id, &state.db, selected).await {
        Ok(r) => r,
        Err(e) => {
            app.state::<crate::logging::LogState>().add_log(
                "ERROR",
                &format!("Spotify import failed: {}", e),
                &app,
            );
            return Err(e);
        }
    };
    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let _ = db.sync_tags();
    }
    app.state::<crate::logging::LogState>().add_log(
        "INFO",
        &format!("Spotify import: {} playlists, {} new tracks", report.playlists, report.tracks_added),
        &app,
    );
    Ok(report)
}

#[tauri::command]
pub async fn spotify_sync_now(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    spotify: State<'_, SpotifyState>,
) -> Result<super::sync::SyncReport, String> {
    let client_id = get_client_id(&state)?;
    let report = super::sync::sync_all(&spotify, &client_id, &state.db).await?;
    if report.updated > 0 {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let _ = db.sync_tags();
    }
    app.state::<crate::logging::LogState>().add_log(
        "INFO",
        &format!("Spotify sync: {}/{} playlists updated, {} ghosts GC'd",
                 report.updated, report.checked, report.ghosts_removed),
        &app,
    );
    Ok(report)
}

/// Shared helper for commands needing the configured client id.
fn get_client_id(state: &State<'_, AppState>) -> Result<String, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.get_config("spotify_client_id")
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty())
        .ok_or("Set your Spotify Client ID first".into())
}
