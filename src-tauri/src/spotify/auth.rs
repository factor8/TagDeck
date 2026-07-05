use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

pub const REDIRECT_PORT: u16 = 43110;
pub const REDIRECT_URI: &str = "http://127.0.0.1:43110/callback";
pub const SCOPES: &str =
    "playlist-read-private playlist-read-collaborative user-read-playback-state user-modify-playback-state";
const KEYRING_SERVICE: &str = "TagDeck-Spotify";
const KEYRING_USER: &str = "oauth-tokens";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds when access_token expires.
    pub expires_at: i64,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn generate_code_verifier() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    (0..64).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

pub fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

// ---- Keychain persistence ----

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

pub fn save_tokens(tokens: &TokenSet) -> Result<(), String> {
    let json = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    keyring_entry()?.set_password(&json).map_err(|e| e.to_string())
}

pub fn load_tokens() -> Option<TokenSet> {
    let entry = keyring_entry().ok()?;
    let json = entry.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

pub fn clear_tokens() {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
}

// ---- Token endpoint ----

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

async fn exchange_code(
    http: &reqwest::Client,
    client_id: &str,
    code: &str,
    verifier: &str,
) -> Result<TokenSet, String> {
    let resp = http
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", client_id),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Token exchange failed ({}): {}", status, body));
    }
    let tr: TokenResponse = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(TokenSet {
        access_token: tr.access_token,
        refresh_token: tr.refresh_token.ok_or("No refresh token returned")?,
        expires_at: now_secs() + tr.expires_in - 60,
    })
}

async fn refresh(
    http: &reqwest::Client,
    client_id: &str,
    refresh_token: &str,
) -> Result<TokenSet, String> {
    let resp = http
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ])
        .send()
        .await
        .map_err(|e| format!("Token refresh failed: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Token refresh failed ({}): {}", status, body));
    }
    let tr: TokenResponse = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(TokenSet {
        access_token: tr.access_token,
        // Spotify rotates refresh tokens; fall back to the old one if omitted.
        refresh_token: tr.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
        expires_at: now_secs() + tr.expires_in - 60,
    })
}

/// Returns a valid access token, refreshing (and re-persisting) if expired.
pub async fn get_valid_access_token(
    spotify: &super::SpotifyState,
    client_id: &str,
) -> Result<String, String> {
    let cached = spotify.tokens.lock().map_err(|_| "lock".to_string())?.clone();
    let tokens = match cached {
        Some(t) => t,
        None => load_tokens().ok_or("Not connected to Spotify")?,
    };
    if tokens.expires_at > now_secs() {
        *spotify.tokens.lock().map_err(|_| "lock".to_string())? = Some(tokens.clone());
        return Ok(tokens.access_token);
    }
    let fresh = refresh(&spotify.http, client_id, &tokens.refresh_token).await?;
    save_tokens(&fresh)?;
    *spotify.tokens.lock().map_err(|_| "lock".to_string())? = Some(fresh.clone());
    Ok(fresh.access_token)
}

// ---- Interactive connect flow ----

/// Runs the full PKCE flow: opens the browser, waits for the loopback
/// callback (2 min timeout), exchanges the code, persists tokens.
/// Returns the Spotify display name.
pub async fn connect(
    app: tauri::AppHandle,
    spotify: &super::SpotifyState,
    client_id: &str,
) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;

    let verifier = generate_code_verifier();
    let challenge = code_challenge(&verifier);
    let state_param = generate_code_verifier(); // reuse generator for CSRF state

    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT)).map_err(|e| {
        format!("Port {} unavailable ({}). Close the app using it and retry.", REDIRECT_PORT, e)
    })?;

    let auth_url = format!(
        "https://accounts.spotify.com/authorize?client_id={}&response_type=code&redirect_uri={}&code_challenge_method=S256&code_challenge={}&state={}&scope={}",
        urlencoding::encode(client_id),
        urlencoding::encode(REDIRECT_URI),
        challenge,
        state_param,
        urlencoding::encode(SCOPES),
    );
    app.opener()
        .open_url(&auth_url, None::<String>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    // Wait for the callback on a blocking thread so we don't stall the async runtime.
    let expected_state = state_param.clone();
    let code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_callback(listener, &expected_state, std::time::Duration::from_secs(120))
    })
    .await
    .map_err(|e| e.to_string())??;

    let tokens = exchange_code(&spotify.http, client_id, &code, &verifier).await?;
    save_tokens(&tokens)?;
    *spotify.tokens.lock().map_err(|_| "lock".to_string())? = Some(tokens.clone());

    // Fetch display name for the settings UI.
    let me: serde_json::Value = spotify
        .http
        .get("https://api.spotify.com/v1/me")
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(me
        .get("display_name")
        .and_then(|v| v.as_str())
        .unwrap_or("Spotify user")
        .to_string())
}

/// Polls `listener` for the OAuth `/callback` request until a valid authorization
/// code arrives or `timeout` elapses. The listener is put into non-blocking mode so
/// the deadline check keeps running even if the browser tab is never completed
/// (closed, navigated away, etc.) — a blocking `accept()` would otherwise hang
/// forever and leak the listener's port for the rest of the app's lifetime.
fn wait_for_callback(
    listener: TcpListener,
    expected_state: &str,
    timeout: std::time::Duration,
) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let mut stream = match listener.accept() {
            Ok((stream, _addr)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() > deadline {
                    return Err(
                        "Timed out waiting for Spotify authorization (2 minutes). Please try again."
                            .to_string(),
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .ok();
        let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).is_err() {
            continue;
        }
        // request_line: "GET /callback?code=...&state=... HTTP/1.1"
        let path = request_line.split_whitespace().nth(1).unwrap_or("");
        if !path.starts_with("/callback") {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n");
            continue;
        }
        let query = path.splitn(2, '?').nth(1).unwrap_or("");
        let mut code = None;
        let mut state_val = None;
        let mut error = None;
        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            match (kv.next(), kv.next()) {
                (Some("code"), Some(v)) => code = Some(v.to_string()),
                (Some("state"), Some(v)) => state_val = Some(v.to_string()),
                (Some("error"), Some(v)) => error = Some(v.to_string()),
                _ => {}
            }
        }
        let body = if error.is_none() && code.is_some() {
            "<html><body style='font-family:sans-serif'><h2>TagDeck connected to Spotify</h2>You can close this tab.</body></html>"
        } else {
            "<html><body style='font-family:sans-serif'><h2>Spotify authorization failed</h2>Return to TagDeck and try again.</body></html>"
        };
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );
        if let Some(err) = error {
            return Err(format!("Spotify authorization denied: {}", err));
        }
        if state_val.as_deref() != Some(expected_state) {
            return Err("State mismatch in OAuth callback".into());
        }
        if let Some(c) = code {
            return Ok(c);
        }
        // /callback request with neither `code` nor `error` — keep waiting.
    }
}

pub fn disconnect(spotify: &super::SpotifyState) {
    clear_tokens();
    if let Ok(mut t) = spotify.tokens.lock() {
        *t = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_vector() {
        // RFC 7636 appendix B test vector
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_is_valid() {
        let v = generate_code_verifier();
        assert!(v.len() >= 43 && v.len() <= 128);
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));
    }

    #[test]
    fn wait_for_callback_times_out_when_no_connection_arrives() {
        // Ephemeral port — never bind the real 43110 redirect port in tests.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let start = std::time::Instant::now();
        let result = wait_for_callback(
            listener,
            "irrelevant-state",
            std::time::Duration::from_millis(300),
        );
        let elapsed = start.elapsed();
        match &result {
            Err(e) => assert!(e.contains("Timed out"), "unexpected error message: {}", e),
            Ok(_) => panic!("expected a timeout error, got Ok"),
        }
        assert!(elapsed < std::time::Duration::from_secs(2), "took too long: {:?}", elapsed);
    }
}
