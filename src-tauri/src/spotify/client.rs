use serde::Deserialize;
use serde_json::json;

use super::auth;
use super::SpotifyState;

const API: &str = "https://api.spotify.com/v1";

// ---- Wire types (permissive: everything optional unless required) ----

#[derive(Debug, Deserialize)]
pub struct PlaylistPage {
    pub items: Vec<PlaylistWire>,
    pub next: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PlaylistWire {
    pub id: String,
    pub name: String,
    pub snapshot_id: String,
    // Pre-Feb-2026 API sends the count as "tracks", post-rename as "items".
    // Kept as two optional fields (not a serde alias) so a response carrying
    // both during the transition can't fail with a duplicate-field error.
    #[serde(default)]
    pub tracks: Option<TracksRef>,
    #[serde(default)]
    pub items: Option<TracksRef>,
    #[serde(default)]
    pub owner: OwnerWire,
}

impl PlaylistWire {
    pub fn track_total(&self) -> i64 {
        self.items
            .as_ref()
            .or(self.tracks.as_ref())
            .map(|t| t.total)
            .unwrap_or(0)
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct OwnerWire {
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TracksRef {
    pub total: i64,
}

#[derive(Debug, Deserialize)]
pub struct ItemsPage {
    pub items: Vec<ItemWire>,
    pub next: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ItemWire {
    pub track: Option<TrackWire>,
}

#[derive(Debug, Deserialize)]
pub struct TrackWire {
    pub id: Option<String>, // null for Spotify-side local files
    pub uri: String,
    pub name: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default = "default_true")]
    pub is_playable: bool,
    #[serde(default)]
    pub artists: Vec<ArtistWire>,
    #[serde(default)]
    pub album: Option<AlbumWire>,
}

fn default_true() -> bool { true }

#[derive(Debug, Deserialize)]
pub struct ArtistWire { pub name: String }

#[derive(Debug, Deserialize)]
pub struct AlbumWire { pub name: String }

// ---- Public result types ----

#[derive(Debug, Clone, serde::Serialize)]
pub struct SpotifyPlaylistSummary {
    pub id: String,
    pub name: String,
    pub snapshot_id: String,
    pub track_count: i64,
    pub owner_name: String,
}

#[derive(Debug, Clone)]
pub struct SpotifyTrackMeta {
    pub id: String,
    pub uri: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: f64,
    pub is_playable: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PlaybackState {
    pub is_playing: bool,
    pub progress_ms: u64,
    pub track_uri: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SpotifyDevice {
    pub id: String,
    pub name: String,
    pub is_active: bool,
}

pub fn page_to_track_metas(page: &ItemsPage) -> Vec<SpotifyTrackMeta> {
    page.items
        .iter()
        .filter_map(|item| item.track.as_ref())
        .filter_map(|t| {
            let id = t.id.clone()?; // skip Spotify local files (id null)
            Some(SpotifyTrackMeta {
                id,
                uri: t.uri.clone(),
                title: t.name.clone(),
                artist: t.artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", "),
                album: t.album.as_ref().map(|a| a.name.clone()).unwrap_or_default(),
                duration_secs: t.duration_ms as f64 / 1000.0,
                is_playable: t.is_playable,
            })
        })
        .collect()
}

// ---- Request helper: bearer auth + one retry on 429/expired ----

async fn request(
    spotify: &SpotifyState,
    client_id: &str,
    method: reqwest::Method,
    url: &str,
    body: Option<serde_json::Value>,
) -> Result<(reqwest::StatusCode, String), String> {
    for attempt in 0..2 {
        let token = auth::get_valid_access_token(spotify, client_id).await?;
        let mut req = spotify.http.request(method.clone(), url).bearer_auth(&token);
        if let Some(b) = &body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| format!("Spotify request failed: {}", e))?;
        let status = resp.status();
        if status.as_u16() == 429 && attempt < 1 {
            let wait = resp
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(2);
            tokio::time::sleep(std::time::Duration::from_secs(wait.min(30))).await;
            continue;
        }
        if status.as_u16() == 401 && attempt < 1 {
            // Force refresh by clearing the cache and retrying.
            if let Ok(mut t) = spotify.tokens.lock() {
                if let Some(ts) = t.as_mut() {
                    ts.expires_at = 0;
                }
            }
            continue;
        }
        let text = resp.text().await.unwrap_or_default();
        return Ok((status, text));
    }
    Err("Spotify API retries exhausted".into())
}

fn ensure_ok(status: reqwest::StatusCode, body: &str, what: &str) -> Result<(), String> {
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("{} failed ({}): {}", what, status, body))
    }
}

// ---- Playlists ----

pub async fn list_my_playlists(
    spotify: &SpotifyState,
    client_id: &str,
) -> Result<Vec<SpotifyPlaylistSummary>, String> {
    let mut out = Vec::new();
    let mut url = format!("{}/me/playlists?limit=50", API);
    loop {
        let (status, body) = request(spotify, client_id, reqwest::Method::GET, &url, None).await?;
        ensure_ok(status, &body, "List playlists")?;
        let page: PlaylistPage = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        out.extend(page.items.into_iter().map(|p| SpotifyPlaylistSummary {
            track_count: p.track_total(),
            id: p.id,
            name: p.name,
            snapshot_id: p.snapshot_id,
            owner_name: p.owner.display_name.unwrap_or_default(),
        }));
        match page.next {
            Some(next) => url = next,
            None => break,
        }
    }
    Ok(out)
}

pub async fn get_playlist_items(
    spotify: &SpotifyState,
    client_id: &str,
    playlist_id: &str,
) -> Result<Vec<SpotifyTrackMeta>, String> {
    let mut out = Vec::new();
    // Post-Feb-2026 API renamed /tracks to /items; fall back for older behavior.
    let mut url = format!("{}/playlists/{}/items?limit=50", API, playlist_id);
    loop {
        let (status, body) = request(spotify, client_id, reqwest::Method::GET, &url, None).await?;
        if status.as_u16() == 404 && url.contains("/items") && out.is_empty() {
            url = format!("{}/playlists/{}/tracks?limit=50", API, playlist_id);
            continue;
        }
        ensure_ok(status, &body, "Get playlist items")?;
        let page: ItemsPage = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        out.extend(page_to_track_metas(&page));
        match page.next {
            Some(next) => url = next,
            None => break,
        }
    }
    Ok(out)
}

pub async fn get_playlist_snapshot(
    spotify: &SpotifyState,
    client_id: &str,
    playlist_id: &str,
) -> Result<String, String> {
    let url = format!("{}/playlists/{}?fields=snapshot_id", API, playlist_id);
    let (status, body) = request(spotify, client_id, reqwest::Method::GET, &url, None).await?;
    ensure_ok(status, &body, "Get playlist")?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    v.get("snapshot_id")
        .and_then(|s| s.as_str())
        .map(String::from)
        .ok_or("No snapshot_id in response".into())
}

// ---- Player ----

pub async fn play_track(
    spotify: &SpotifyState,
    client_id: &str,
    uri: &str,
    device_id: Option<&str>,
) -> Result<(), String> {
    let url = match device_id {
        Some(d) => format!("{}/me/player/play?device_id={}", API, d),
        None => format!("{}/me/player/play", API),
    };
    let (status, body) = request(
        spotify, client_id, reqwest::Method::PUT, &url,
        Some(json!({ "uris": [uri] })),
    ).await?;
    ensure_ok(status, &body, "Play")
}

pub async fn pause(spotify: &SpotifyState, client_id: &str) -> Result<(), String> {
    let (status, body) = request(
        spotify, client_id, reqwest::Method::PUT,
        &format!("{}/me/player/pause", API), None,
    ).await?;
    ensure_ok(status, &body, "Pause")
}

pub async fn resume(spotify: &SpotifyState, client_id: &str) -> Result<(), String> {
    let (status, body) = request(
        spotify, client_id, reqwest::Method::PUT,
        &format!("{}/me/player/play", API), None,
    ).await?;
    ensure_ok(status, &body, "Resume")
}

pub async fn seek(spotify: &SpotifyState, client_id: &str, position_ms: u64) -> Result<(), String> {
    let (status, body) = request(
        spotify, client_id, reqwest::Method::PUT,
        &format!("{}/me/player/seek?position_ms={}", API, position_ms), None,
    ).await?;
    ensure_ok(status, &body, "Seek")
}

pub async fn next(spotify: &SpotifyState, client_id: &str) -> Result<(), String> {
    let (status, body) = request(
        spotify, client_id, reqwest::Method::POST,
        &format!("{}/me/player/next", API), None,
    ).await?;
    ensure_ok(status, &body, "Next")
}

pub async fn previous(spotify: &SpotifyState, client_id: &str) -> Result<(), String> {
    let (status, body) = request(
        spotify, client_id, reqwest::Method::POST,
        &format!("{}/me/player/previous", API), None,
    ).await?;
    ensure_ok(status, &body, "Previous")
}

pub async fn get_playback(
    spotify: &SpotifyState,
    client_id: &str,
) -> Result<Option<PlaybackState>, String> {
    let (status, body) = request(
        spotify, client_id, reqwest::Method::GET,
        &format!("{}/me/player", API), None,
    ).await?;
    if status.as_u16() == 204 || body.trim().is_empty() {
        return Ok(None); // nothing playing / no active device
    }
    ensure_ok(status, &body, "Get playback")?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(Some(PlaybackState {
        is_playing: v.get("is_playing").and_then(|b| b.as_bool()).unwrap_or(false),
        progress_ms: v.get("progress_ms").and_then(|n| n.as_u64()).unwrap_or(0),
        track_uri: v.pointer("/item/uri").and_then(|s| s.as_str()).map(String::from),
        duration_ms: v.pointer("/item/duration_ms").and_then(|n| n.as_u64()).unwrap_or(0),
    }))
}

pub async fn list_devices(
    spotify: &SpotifyState,
    client_id: &str,
) -> Result<Vec<SpotifyDevice>, String> {
    let (status, body) = request(
        spotify, client_id, reqwest::Method::GET,
        &format!("{}/me/player/devices", API), None,
    ).await?;
    ensure_ok(status, &body, "List devices")?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(v.get("devices")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|d| {
                    Some(SpotifyDevice {
                        id: d.get("id")?.as_str()?.to_string(),
                        name: d.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                        is_active: d.get("is_active").and_then(|b| b.as_bool()).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

pub async fn transfer_playback(
    spotify: &SpotifyState,
    client_id: &str,
    device_id: &str,
    play: bool,
) -> Result<(), String> {
    let (status, body) = request(
        spotify, client_id, reqwest::Method::PUT,
        &format!("{}/me/player", API),
        Some(json!({ "device_ids": [device_id], "play": play })),
    ).await?;
    ensure_ok(status, &body, "Transfer playback")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_playlist_page() {
        let json = r#"{
            "items": [{"id":"pl1","name":"Crate","snapshot_id":"snapA",
                       "tracks":{"total":42},"owner":{"display_name":"jordan"}}],
            "next": null
        }"#;
        let page: PlaylistPage = serde_json::from_str(json).unwrap();
        let p = &page.items[0];
        assert_eq!(p.id, "pl1");
        assert_eq!(p.snapshot_id, "snapA");
        assert_eq!(p.track_total(), 42);
        assert_eq!(p.owner.display_name.as_deref(), Some("jordan"));
    }

    #[test]
    fn parses_playlist_page_with_post_feb_2026_items_field() {
        // Live /me/playlists responses now carry "items":{...,"total":N} on each
        // playlist instead of "tracks" (same Feb-2026 rename as the endpoint).
        let json = r#"{
            "items": [{"id":"pl1","name":"Crate","snapshot_id":"snapA",
                       "items":{"href":"https://api.spotify.com/v1/playlists/pl1/items","total":4},
                       "owner":{"display_name":"jordan"}}],
            "next": null
        }"#;
        let page: PlaylistPage = serde_json::from_str(json).unwrap();
        assert_eq!(page.items[0].track_total(), 4);
    }

    #[test]
    fn playlist_missing_both_count_fields_still_parses() {
        let json = r#"{
            "items": [{"id":"pl1","name":"Crate","snapshot_id":"snapA"}],
            "next": null
        }"#;
        let page: PlaylistPage = serde_json::from_str(json).unwrap();
        assert_eq!(page.items[0].track_total(), 0);
    }

    #[test]
    fn parses_playlist_items_and_skips_null_tracks() {
        let json = r#"{
            "items": [
                {"track": {"id":"t1","uri":"spotify:track:t1","name":"Song",
                           "duration_ms": 200000, "is_playable": true,
                           "artists":[{"name":"A"},{"name":"B"}],
                           "album":{"name":"Alb"}}},
                {"track": null},
                {"track": {"id": null, "uri":"spotify:local:x","name":"Local file",
                           "duration_ms": 1000, "artists":[], "album":{"name":""}}}
            ],
            "next": null
        }"#;
        let page: ItemsPage = serde_json::from_str(json).unwrap();
        let metas = page_to_track_metas(&page);
        assert_eq!(metas.len(), 1); // null track and id-less local file skipped
        assert_eq!(metas[0].artist, "A, B");
        assert!((metas[0].duration_secs - 200.0).abs() < 0.001);
    }
}

