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
