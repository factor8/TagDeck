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
    let report = match super::sync::sync_all(&spotify, &client_id, &state.db).await {
        Ok(r) => r,
        Err(e) => {
            app.state::<crate::logging::LogState>().add_log(
                "ERROR",
                &format!("Spotify sync failed: {}", e),
                &app,
            );
            return Err(e);
        }
    };
    if report.updated > 0 {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        let _ = db.sync_tags();
    }
    for err in &report.errors {
        app.state::<crate::logging::LogState>().add_log(
            "ERROR",
            &format!("Spotify sync: playlist failed: {}", err),
            &app,
        );
    }
    let summary = if report.failed > 0 {
        format!("Spotify sync: {}/{} playlists updated, {} ghosts GC'd ({} playlists failed)",
                report.updated, report.checked, report.ghosts_removed, report.failed)
    } else {
        format!("Spotify sync: {}/{} playlists updated, {} ghosts GC'd",
                report.updated, report.checked, report.ghosts_removed)
    };
    app.state::<crate::logging::LogState>().add_log("INFO", &summary, &app);
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

#[tauri::command]
pub async fn spotify_play_track(
    app: tauri::AppHandle,
    spotify_id: String,
    state: State<'_, AppState>,
    spotify: State<'_, SpotifyState>,
) -> Result<(), String> {
    let client_id = get_client_id(&state)?;
    let uri = format!("spotify:track:{}", spotify_id);

    // Prefer the active device; otherwise wake the Spotify desktop app.
    let devices = super::client::list_devices(&spotify, &client_id).await?;
    let device_id = match devices.iter().find(|d| d.is_active).or(devices.first()) {
        Some(d) => Some(d.id.clone()),
        None => {
            // Launch Spotify.app and poll for it to register (max ~15s).
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url("spotify:", None::<String>)
                .map_err(|e| format!("Couldn't launch Spotify: {}", e))?;
            let mut found = None;
            for _ in 0..15 {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                let ds = super::client::list_devices(&spotify, &client_id).await.unwrap_or_default();
                if let Some(d) = ds.into_iter().next() {
                    found = Some(d.id);
                    break;
                }
            }
            Some(found.ok_or("Spotify app didn't become available — is it installed and logged in?")?)
        }
    };
    super::client::play_track(&spotify, &client_id, &uri, device_id.as_deref()).await
}

#[tauri::command]
pub async fn spotify_pause(state: State<'_, AppState>, spotify: State<'_, SpotifyState>) -> Result<(), String> {
    let client_id = get_client_id(&state)?;
    super::client::pause(&spotify, &client_id).await
}

#[tauri::command]
pub async fn spotify_resume(state: State<'_, AppState>, spotify: State<'_, SpotifyState>) -> Result<(), String> {
    let client_id = get_client_id(&state)?;
    super::client::resume(&spotify, &client_id).await
}

#[tauri::command]
pub async fn spotify_seek(position_ms: u64, state: State<'_, AppState>, spotify: State<'_, SpotifyState>) -> Result<(), String> {
    let client_id = get_client_id(&state)?;
    super::client::seek(&spotify, &client_id, position_ms).await
}

#[tauri::command]
pub async fn spotify_get_playback(
    state: State<'_, AppState>,
    spotify: State<'_, SpotifyState>,
) -> Result<Option<super::client::PlaybackState>, String> {
    let client_id = get_client_id(&state)?;
    super::client::get_playback(&spotify, &client_id).await
}

// ---------------------------------------------------------------------------
// Merge engine: pending-match review queue (Task 13)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct PendingMatch {
    pub id: i64,
    pub ghost: crate::models::Track,
    pub local: crate::models::Track,
    pub score: f64,
}

#[tauri::command]
pub async fn spotify_get_pending_matches(state: State<'_, AppState>) -> Result<Vec<PendingMatch>, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    let rows = db.get_pending_match_rows().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (id, ghost_id, local_id, score) in rows {
        if let (Ok(Some(ghost)), Ok(Some(local))) = (db.get_track(ghost_id), db.get_track(local_id)) {
            out.push(PendingMatch { id, ghost, local, score });
        } else {
            let _ = db.delete_pending_match(id); // stale row
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn spotify_confirm_match(match_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    let (ghost_id, local_id) = db.delete_pending_match(match_id)
        .map_err(|e| e.to_string())?
        .ok_or("Match not found")?;
    super::merge::merge_ghost_into_local(&db, ghost_id, local_id)
}

#[tauri::command]
pub async fn spotify_reject_match(match_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.delete_pending_match(match_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn spotify_manual_link(
    ghost_track_id: i64,
    local_track_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    super::merge::merge_ghost_into_local(&db, ghost_track_id, local_track_id)
}
