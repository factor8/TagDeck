# Spotify Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selectively import Spotify playlists as taggable "ghost tracks", play them via Spotify Connect, and auto-merge accumulated tags into real files when tracks are purchased.

**Architecture:** Ghosts live in the existing `tracks` table (`source='spotify'`, `file_path=''`) so tag/playlist/search machinery works unchanged. New Rust module `src-tauri/src/spotify/` holds auth (PKCE + Keychain), API client, sync, matcher, and merge engines. Frontend adds a Spotify sidebar section, settings tab, import modal, Connect transport, and match-review queue.

**Tech Stack:** Tauri 2 / Rust (reqwest, keyring, base64, rand, sha2), React 19 + TypeScript, SQLite (rusqlite), Spotify Web API (Development Mode, post-Feb-2026 endpoint set).

**Spec:** [`../specs/2026-07-05-spotify-integration-design.md`](../specs/2026-07-05-spotify-integration-design.md) (formerly `Docs/SpotifyIntegrationPlan.md`). One deliberate deviation: ghosts use `file_path = ''` (empty-string sentinel) instead of SQL `NULL`, because SQLite can't drop `NOT NULL` without a table rebuild and `Track.file_path: String` is used pervasively. Task 1 updates the spec wording.

## Global Constraints

- Branch: `feature/spotify-integration`. Commit after every task (message prefix `feat:`/`fix:`/`docs:` as appropriate).
- Rust verification: `cd src-tauri && cargo test` and `cargo build` must pass at the end of every task.
- Frontend verification: `npm run build` (runs `tsc`) must pass at the end of every frontend task.
- A track is a **ghost** iff `source == "spotify"` (equivalently `file_path == ""` — both are set together, and merge deletes the ghost row rather than converting it).
- Ghost `persistent_id` = `"SP-{spotify_track_id}"`. Spotify playlist `persistent_id` = `"SP-PL-{spotify_playlist_id}"`.
- Tag comment serialization is unchanged: `{user comment} && {tag1; tag2}` with delimiter `" && "`.
- Never write to a ghost's file, never push ghosts to Music.app, never mark ghosts dirty/missing.
- Spotify scopes: `playlist-read-private playlist-read-collaborative user-read-playback-state user-modify-playback-state`.
- OAuth redirect URI is exactly `http://127.0.0.1:43110/callback` (Spotify requires an exact match — fixed port, registered in the user's Spotify app dashboard).
- All new Tauri commands: signature pattern `pub async fn cmd(..., state: State<'_, AppState>) -> Result<T, String>`, registered in `generate_handler!` in `src-tauri/src/lib.rs`, DB access via `state.db.lock().map_err(|_| "Failed to lock DB".to_string())?`.
- Log through `app.state::<crate::logging::LogState>().add_log("INFO"|"ERROR", msg, &app)` where an `AppHandle` is available.
- Do not log tokens or the client secret (there is no client secret — PKCE only).

## File Structure

```
src-tauri/src/spotify/
  mod.rs        — module root, SpotifyState (managed), shared types
  auth.rs       — PKCE flow, loopback listener, Keychain token store, refresh
  client.rs     — typed Web API client (playlists, items, player), 429 handling
  sync.rs       — import + snapshot-diff auto-sync + ghost GC
  matcher.rs    — pure fuzzy-matching functions (fully unit-tested)
  merge.rs      — merge engine + pending-match queue
  commands.rs   — all #[tauri::command] wrappers for the above
src/components/
  SpotifyImportModal.tsx   — checkbox playlist picker
  SpotifyMatchReview.tsx   — pending-match review modal
  SpotifyPlayer.tsx        — Connect transport (used by Player.tsx for ghosts)
  settings/SpotifyTab.tsx  — client ID + connect/disconnect
Modified: db.rs, models.rs, commands.rs, lib.rs, types.ts, App.tsx,
  Sidebar.tsx, TrackList.tsx, SettingsPanel.tsx, Player.tsx,
  Docs/TestPlan.md, Docs/CHANGELOG.md, Docs/SpotifyIntegrationPlan.md
```

---

### Task 1: Schema + model groundwork

**Files:**
- Modify: `src-tauri/src/db.rs` (migrations ~line 121; every `SELECT` returning `Track`; `insert_imported_track`)
- Modify: `src-tauri/src/models.rs`
- Modify: `src/types.ts`
- Modify: `Docs/SpotifyIntegrationPlan.md` (spec wording: empty-string sentinel)
- Test: inline `#[cfg(test)]` in `src-tauri/src/db.rs`

**Interfaces:**
- Produces: `Track.source: String` (`"local"`/`"spotify"`), `Track.spotify_id: Option<String>`, `Track::is_ghost(&self) -> bool`; `Playlist.spotify_playlist_id: Option<String>`, `Playlist.spotify_snapshot_id: Option<String>`; DB columns of the same names; TS `Track.source: 'local' | 'spotify'`, `Track.spotify_id?: string | null`, `Playlist.origin` gains `'spotify'`, `Playlist.spotify_playlist_id?`, `Playlist.spotify_snapshot_id?`.

- [ ] **Step 1: Write the failing test**

At the bottom of `src-tauri/src/db.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn ghost(spotify_id: &str) -> crate::models::Track {
        crate::models::Track {
            id: 0,
            persistent_id: format!("SP-{}", spotify_id),
            file_path: String::new(),
            artist: Some("Artist".into()),
            title: Some("Title".into()),
            album: Some("Album".into()),
            comment_raw: None,
            grouping_raw: None,
            duration_secs: 200.0,
            format: "SPOTIFY".into(),
            size_bytes: 0,
            bit_rate: 0,
            modified_date: 0,
            rating: 0,
            date_added: 0,
            bpm: 0,
            missing: false,
            itunes_pid: None,
            unlinked_at: None,
            source: "spotify".into(),
            spotify_id: Some(spotify_id.to_string()),
        }
    }

    #[test]
    fn ghost_track_roundtrip() {
        let db = Database::new(":memory:").unwrap();
        let id = db.insert_imported_track(&ghost("abc123"), None, None).unwrap();
        let t = db.get_track(id).unwrap().unwrap();
        assert_eq!(t.source, "spotify");
        assert_eq!(t.spotify_id.as_deref(), Some("abc123"));
        assert_eq!(t.file_path, "");
        assert!(t.is_ghost());
        // local tracks default to source='local'
        let all = db.get_all_tracks().unwrap();
        assert_eq!(all.len(), 1);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test ghost_track_roundtrip`
Expected: FAIL — compile errors (`source`/`spotify_id` fields and `is_ghost` don't exist).

- [ ] **Step 3: Extend the models**

In `src-tauri/src/models.rs`, add to the end of `struct Track` (after `unlinked_at`):

```rust
    /// "local" (has a file) or "spotify" (ghost — imported from Spotify, no file yet).
    #[serde(default = "default_source")]
    pub source: String,
    /// Spotify track ID. Set on ghosts; retained on the local track after a merge.
    #[serde(default)]
    pub spotify_id: Option<String>,
```

Below the struct add:

```rust
fn default_source() -> String {
    "local".to_string()
}

impl Track {
    /// Ghost = imported from Spotify with no local file yet.
    pub fn is_ghost(&self) -> bool {
        self.source == "spotify"
    }
}
```

Add to the end of `struct Playlist` (after `updated_at`):

```rust
    #[serde(default)]
    pub spotify_playlist_id: Option<String>,
    #[serde(default)]
    pub spotify_snapshot_id: Option<String>,
```

- [ ] **Step 4: Add DB migrations**

In `src-tauri/src/db.rs`, after the `dirty_since_sync` migration (line ~121), add:

```rust
        // Spotify integration: ghosts are tracks with source='spotify' and
        // file_path=''. spotify_id persists across the ghost→local merge.
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN source TEXT NOT NULL DEFAULT 'local'", []);
        let _ = conn.execute("ALTER TABLE tracks ADD COLUMN spotify_id TEXT", []);
        let _ = conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_spotify_id ON tracks(spotify_id)", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN spotify_playlist_id TEXT", []);
        let _ = conn.execute("ALTER TABLE playlists ADD COLUMN spotify_snapshot_id TEXT", []);
```

- [ ] **Step 5: Update every Track SELECT and constructor**

The compiler finds them all. Run `cd src-tauri && cargo build` and fix every error:

1. Every `SELECT` in `db.rs` that maps to `Track` (at minimum `get_track` ~line 341, `get_all_tracks` ~line 970, `get_tracks_by_itunes_pids` ~line 171): append `, source, spotify_id` to the column list and to the struct mapping:

```rust
                    source: row.get(19).unwrap_or_else(|_| "local".to_string()),
                    spotify_id: row.get(20).unwrap_or(None),
```

(Indexes 19/20 assume the existing 0–18 columns `id..unlinked_at`; match each query's actual column order.)

2. `insert_imported_track` (db.rs ~1284): the existing statement has 18 columns ending in `file_hash` with placeholders to `?18`. Append `, source, spotify_id` to the column list, `, ?19, ?20` to VALUES, and `track.source, track.spotify_id` to the end of `params![]`.

3. Every `Track { ... }` literal found by `grep -rn "Track {" src-tauri/src` (import_files in commands.rs ~2202, library_parser.rs, sync paths): add `source: "local".to_string(), spotify_id: None,` — **except** none of these are Spotify paths yet, so `"local"` everywhere.

4. `insert_track_impl` (db.rs ~262): leave as-is (iTunes path never inserts ghosts; `source` defaults to `'local'` in SQL).

- [ ] **Step 6: Run test to verify it passes**

Run: `cd src-tauri && cargo test ghost_track_roundtrip`
Expected: PASS. Also run `cargo test` (all) — expected: all pass.

- [ ] **Step 7: Mirror types in TypeScript**

In `src/types.ts`, add to `interface Track` after `unlinked_at`:

```ts
    /** 'local' (has a file) or 'spotify' (ghost — no file yet). */
    source: 'local' | 'spotify';
    /** Spotify track ID; kept after merge onto the local track. */
    spotify_id?: string | null;
```

Change `Playlist.origin` to `'itunes' | 'tagdeck' | 'spotify'` and add:

```ts
    spotify_playlist_id?: string | null;
    spotify_snapshot_id?: string | null;
```

Run: `npm run build` — expected: PASS (nothing consumes the new fields yet).

- [ ] **Step 8: Update spec wording**

In `Docs/SpotifyIntegrationPlan.md`:
1. §1: replace the sentence about `file_path` becoming nullable with: ghosts store `file_path = ''` and `source = 'spotify'` (empty-string sentinel; avoids a SQLite table rebuild and an `Option<String>` ripple through every `Track` consumer).
2. §3 and §7: replace "Spotify-side 'local file' entries ... import as metadata-only ghosts" with: Spotify-side "local file" entries are **skipped on import** — they have no Spotify track ID (nothing to dedupe or merge on) and the user already owns those files. Region-unavailable tracks still import as taggable, unplayable ghosts.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(spotify): schema + model groundwork for ghost tracks"
```

---

### Task 2: Dependencies, Spotify module skeleton, client-ID config

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/spotify/mod.rs`, `src-tauri/src/spotify/commands.rs`
- Modify: `src-tauri/src/lib.rs` (declare module, manage state, register commands)
- Test: `cargo build` + manual invoke check

**Interfaces:**
- Consumes: `library_config` key/value helpers `db.get_config(key) -> Result<Option<String>>` / `db.set_config(key, value)` (they exist in db.rs — verify names with `grep -n "fn get_config\|fn set_config" src-tauri/src/db.rs`; if they're named differently, e.g. take/return other types, adapt the call sites in this task only).
- Produces: `SpotifyState { http: reqwest::Client, tokens: Mutex<Option<auth::TokenSet>> }` managed by Tauri; commands `spotify_get_settings() -> SpotifySettings`, `spotify_set_client_id(client_id: String)`; config key `"spotify_client_id"`.

- [ ] **Step 1: Add dependencies**

Append to `[dependencies]` in `src-tauri/Cargo.toml`:

```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
keyring = { version = "3", features = ["apple-native"] }
base64 = "0.22"
rand = "0.8"
```

Run: `cd src-tauri && cargo build` — expected: PASS (fetches new crates).

- [ ] **Step 2: Create the module root**

`src-tauri/src/spotify/mod.rs`:

```rust
pub mod auth;
pub mod client;
pub mod commands;
pub mod matcher;
pub mod merge;
pub mod sync;

use std::sync::Mutex;

/// Shared Spotify runtime state, managed by Tauri.
pub struct SpotifyState {
    pub http: reqwest::Client,
    /// In-memory token cache; source of truth is the Keychain (auth.rs).
    pub tokens: Mutex<Option<auth::TokenSet>>,
}

impl SpotifyState {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
            tokens: Mutex::new(None),
        }
    }
}
```

For this task, create `auth.rs`, `client.rs`, `matcher.rs`, `merge.rs`, `sync.rs` as empty files (just a comment header) so the module compiles; later tasks fill them. `auth.rs` needs the `TokenSet` referenced above — give it the real struct now:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds when access_token expires.
    pub expires_at: i64,
}
```

- [ ] **Step 3: Settings commands**

`src-tauri/src/spotify/commands.rs`:

```rust
use serde::Serialize;
use tauri::State;

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
```

(`auth::load_tokens()` is written in Task 3; for now add a stub in `auth.rs` so this compiles:)

```rust
pub fn load_tokens() -> Option<TokenSet> {
    None // real Keychain implementation lands in the auth task
}
```

- [ ] **Step 4: Wire into lib.rs**

In `src-tauri/src/lib.rs`: add `mod spotify;` beside the other module declarations; in `.setup()` after the existing `app.manage(AppState {...})` add `app.manage(spotify::SpotifyState::new());`; append to `generate_handler!` (after `sync_review::apply_sync_changes`, minding the comma):

```rust
            spotify::commands::spotify_get_settings,
            spotify::commands::spotify_set_client_id
```

- [ ] **Step 5: Verify and commit**

Run: `cd src-tauri && cargo build && cargo test` — expected: PASS.
If `get_config`/`set_config` don't exist in db.rs, add them:

```rust
    pub fn get_config(&self, key: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        Ok(self.conn.query_row(
            "SELECT value FROM library_config WHERE key = ?1",
            params![key], |row| row.get(0),
        ).optional()?)
    }

    pub fn set_config(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO library_config (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }
}
```

```bash
git add -A && git commit -m "feat(spotify): module skeleton, deps, client-id settings"
```

---

### Task 3: PKCE auth with Keychain storage

**Files:**
- Modify: `src-tauri/src/spotify/auth.rs` (replace stub)
- Modify: `src-tauri/src/spotify/commands.rs` (add connect/disconnect commands)
- Modify: `src-tauri/src/lib.rs` (register commands)
- Test: inline `#[cfg(test)]` in `auth.rs`

**Interfaces:**
- Consumes: `SpotifyState`, `db.get_config("spotify_client_id")`, `db.set_config("spotify_account_name", ...)`.
- Produces: `auth::connect(app, client_id) -> Result<String, String>` (returns display name), `auth::disconnect()`, `auth::load_tokens() -> Option<TokenSet>`, `auth::get_valid_access_token(&SpotifyState, client_id: &str) -> Result<String, String>` (auto-refreshes; the function every API call goes through); commands `spotify_connect() -> String`, `spotify_disconnect()`.
- Constants: `REDIRECT_PORT: u16 = 43110`, `REDIRECT_URI = "http://127.0.0.1:43110/callback"`, `SCOPES = "playlist-read-private playlist-read-collaborative user-read-playback-state user-modify-playback-state"`.

- [ ] **Step 1: Write the failing PKCE test**

In `src-tauri/src/spotify/auth.rs` (bottom):

```rust
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
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test pkce` — expected: FAIL (functions not defined).

- [ ] **Step 3: Implement auth.rs**

Replace the stub `auth.rs` with:

```rust
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
    let code = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        listener
            .set_nonblocking(false)
            .map_err(|e| e.to_string())?;
        // Accept connections until we get /callback or time out (~120s).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        for stream in listener.incoming() {
            if std::time::Instant::now() > deadline {
                return Err("Timed out waiting for Spotify authorization".into());
            }
            let mut stream = stream.map_err(|e| e.to_string())?;
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
            if state_val.as_deref() != Some(expected_state.as_str()) {
                return Err("State mismatch in OAuth callback".into());
            }
            if let Some(c) = code {
                return Ok(c);
            }
        }
        Err("Listener closed unexpectedly".into())
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

pub fn disconnect(spotify: &super::SpotifyState) {
    clear_tokens();
    if let Ok(mut t) = spotify.tokens.lock() {
        *t = None;
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test pkce && cargo test verifier_is_valid`
Expected: both PASS.

- [ ] **Step 5: Add connect/disconnect commands**

Append to `src-tauri/src/spotify/commands.rs`:

```rust
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
```

(This requires `use tauri::Manager;` in scope for `app.state::<_>()` — commands.rs already imports it; add it to spotify/commands.rs imports.)

- [ ] **Step 6: Register + verify**

Add `spotify::commands::spotify_connect, spotify::commands::spotify_disconnect` to `generate_handler!` in lib.rs.
Run: `cd src-tauri && cargo build && cargo test` — expected: PASS.

Manual smoke test (requires a Spotify app registered at developer.spotify.com with redirect URI `http://127.0.0.1:43110/callback`): `npm run tauri dev`, then from the devtools console: `window.__TAURI__.core.invoke('spotify_set_client_id', { clientId: '<your id>' }).then(() => window.__TAURI__.core.invoke('spotify_connect'))` — expected: browser opens, after approving, promise resolves with your display name.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(spotify): PKCE OAuth flow with Keychain token storage"
```

---
### Task 4: Typed Web API client

**Files:**
- Modify: `src-tauri/src/spotify/client.rs` (replace stub)
- Test: inline `#[cfg(test)]` in `client.rs`

**Interfaces:**
- Consumes: `auth::get_valid_access_token(&SpotifyState, client_id)`.
- Produces:
  - `SpotifyPlaylistSummary { id: String, name: String, snapshot_id: String, track_count: i64, owner_name: String }`
  - `SpotifyTrackMeta { id: String, uri: String, title: String, artist: String, album: String, duration_secs: f64, is_playable: bool }`
  - `list_my_playlists(&SpotifyState, client_id) -> Result<Vec<SpotifyPlaylistSummary>, String>`
  - `get_playlist_items(&SpotifyState, client_id, playlist_id) -> Result<Vec<SpotifyTrackMeta>, String>`
  - `get_playlist_snapshot(&SpotifyState, client_id, playlist_id) -> Result<String, String>`
  - Player: `play_track(&SpotifyState, client_id, uri, device_id: Option<&str>)`, `pause(..)`, `resume(..)`, `seek(.., position_ms: u64)`, `next(..)`, `previous(..)`, `get_playback(..) -> Result<Option<PlaybackState>, String>`, `list_devices(..) -> Result<Vec<SpotifyDevice>, String>`, `transfer_playback(.., device_id, play: bool)`
  - `PlaybackState { is_playing: bool, progress_ms: u64, track_uri: Option<String>, duration_ms: u64 }`, `SpotifyDevice { id: String, name: String, is_active: bool }`

- [ ] **Step 1: Write failing deserialization tests**

Bottom of `client.rs`:

```rust
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
        assert_eq!(p.tracks.total, 42);
        assert_eq!(p.owner.display_name.as_deref(), Some("jordan"));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test parses_` — expected: FAIL (types not defined).

- [ ] **Step 3: Implement client.rs**

```rust
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
    pub tracks: TracksRef,
    #[serde(default)]
    pub owner: OwnerWire,
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
    for attempt in 0..3 {
        let token = auth::get_valid_access_token(spotify, client_id).await?;
        let mut req = spotify.http.request(method.clone(), url).bearer_auth(&token);
        if let Some(b) = &body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| format!("Spotify request failed: {}", e))?;
        let status = resp.status();
        if status.as_u16() == 429 && attempt < 2 {
            let wait = resp
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(2);
            tokio::time::sleep(std::time::Duration::from_secs(wait.min(30))).await;
            continue;
        }
        if status.as_u16() == 401 && attempt < 2 {
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
            id: p.id,
            name: p.name,
            snapshot_id: p.snapshot_id,
            track_count: p.tracks.total,
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
```

Note: `tokio` is available transitively through Tauri; if `tokio::time::sleep` fails to resolve, add `tokio = { version = "1", features = ["time"] }` to Cargo.toml.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test parses_ && cargo build` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(spotify): typed Web API client with 429/refresh retry"
```

---

### Task 5: Ghost-aware guards in existing backend paths

Ghosts have no file and no Music.app link. Every path that does file IO or Music.app pushes must branch. Tag edits on ghosts update the DB only.

**Files:**
- Modify: `src-tauri/src/commands.rs` (`write_tags` ~line 326, `batch_add_tag` ~392, `batch_remove_tag` ~515, `update_rating` ~1554, `verify_library_files` ~2316, `consolidate_library` ~2421, `export_tracks_to_music` ~2537, `export_playlist_m3u8` ~2622, `export_rekordbox_xml` ~2682, `get_track_artwork` ~1650, `update_track_info` ~1710)
- Test: `cargo test` + targeted manual test

**Interfaces:**
- Consumes: `Track::is_ghost()` from Task 1.
- Produces: tag/rating edits work on ghosts (DB-only); library maintenance and export commands skip ghosts.

- [ ] **Step 1: Guard `write_tags`**

In `write_tags` (commands.rs ~326), after loading the track, add an early ghost branch before the undo preparation:

```rust
    // Ghost tracks (Spotify, no file): DB-only tag storage; no file IO,
    // no Music.app push, no dirty flag, no undo (nothing external to revert).
    if track.is_ghost() {
        track.comment_raw = Some(new_tags);
        db.update_track(&track).map_err(|e| e.to_string())?;
        let _ = db.sync_tags();
        return Ok(());
    }
```

- [ ] **Step 2: Guard the batch tag commands**

In `batch_add_tag` (~392) and `batch_remove_tag` (~515), inside the per-track loop where the new comment is written, wrap the file/Music.app/dirty steps:

```rust
            if track.is_ghost() {
                track.comment_raw = Some(new_full_comment.clone());
                if let Ok(db) = state.db.lock() {
                    let _ = db.update_track(&track);
                }
                continue; // no file write, no Music push, no undo entry
            }
```

Place this immediately before the `write_tags_to_file(...)` call in each command (the comment-string construction above it is shared). After both loops finish, `db.sync_tags()` is NOT currently called in these commands — add `let _ = db.sync_tags();` guarded by a re-lock at the end of each command so ghost tag edits update the vocabulary counts (check first with `grep -n "sync_tags" src-tauri/src/commands.rs` — if the tag flow already refreshes elsewhere, e.g. via the frontend calling `get_global_tags`, keep behavior consistent and skip this).

- [ ] **Step 3: Guard `update_rating` and `update_track_info`**

`update_rating` already skips the Music push when `itunes_pid` is None (always true for ghosts), and `db.update_track_rating` is DB-only — but it calls `mark_tracks_dirty` when push is disabled. Load nothing extra; change the dirty-marking to skip ghosts:

```rust
    if !push_enabled {
        let is_ghost = db.get_track(track_id).ok().flatten().map(|t| t.is_ghost()).unwrap_or(false);
        if !is_ghost {
            if let Err(e) = db.mark_tracks_dirty(&[track_id]) { /* existing logging */ }
        }
    }
```

`update_track_info` (~1710) writes file metadata via `write_track_info` — at the top after loading the track add:

```rust
    if track.is_ghost() {
        return Err("Spotify tracks can't be edited until the file is purchased and merged".into());
    }
```

- [ ] **Step 4: Skip ghosts in maintenance/export commands**

In each of `verify_library_files`, `consolidate_library`, `export_tracks_to_music`, `export_playlist_m3u8`, `export_rekordbox_xml`: locate the loop over tracks (find with `grep -n "for .*track" src-tauri/src/commands.rs` around the listed line numbers) and add as the first statement of the loop body:

```rust
        if track.is_ghost() { continue; }
```

(Adapt the binding name to each loop. For `verify_library_files` this is critical — otherwise every ghost gets flagged missing.) In `get_track_artwork` (~1650), after loading the track: `if track.is_ghost() { return Ok(None); }`.

- [ ] **Step 5: Build, test, manual check**

Run: `cd src-tauri && cargo build && cargo test` — expected: PASS.
Manual (after Task 6 provides ghosts): tag a ghost, restart the app, tag persists; run "Verify Library Files" from settings; ghost is not marked missing.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(spotify): ghost-aware guards in tag/rating/file paths"
```

---

### Task 6: Playlist import (ghosts + playlists)

**Files:**
- Modify: `src-tauri/src/spotify/sync.rs` (replace stub)
- Modify: `src-tauri/src/db.rs` (new helpers)
- Modify: `src-tauri/src/spotify/commands.rs`, `src-tauri/src/lib.rs` (register)
- Test: inline `#[cfg(test)]` in `db.rs`

**Interfaces:**
- Consumes: `client::list_my_playlists`, `client::get_playlist_items`, `SpotifyTrackMeta`.
- Produces:
  - db: `upsert_ghost_track(&SpotifyTrackMeta-shaped args) -> Result<i64>` — see exact signature below; `upsert_spotify_playlist(spotify_playlist_id, name, snapshot_id, track_db_ids: &[i64]) -> Result<i64>`; `get_spotify_playlists() -> Result<Vec<(i64, String, Option<String>)>>` (db id, spotify_playlist_id, snapshot_id); `find_track_by_spotify_id(&str) -> Result<Option<i64>>`
  - sync: `import_playlists(app, state-db-handle, spotify, client_id, playlist_ids: Vec<String>) -> Result<ImportReport, String>` where `ImportReport { playlists: usize, tracks_added: usize, tracks_linked: usize }` (serialize)
  - commands: `spotify_list_playlists() -> Vec<client::SpotifyPlaylistSummary>`, `spotify_import_playlists(playlist_ids: Vec<String>) -> ImportReport`

- [ ] **Step 1: Write failing db-helper tests**

Add to the `tests` module in `db.rs`:

```rust
    #[test]
    fn upsert_ghost_dedupes_by_spotify_id() {
        let db = Database::new(":memory:").unwrap();
        let id1 = db.upsert_ghost_track("abc", "spotify:track:abc", "Artist", "Title", "Album", 200.0).unwrap();
        let id2 = db.upsert_ghost_track("abc", "spotify:track:abc", "Artist2", "Title2", "Album2", 200.0).unwrap();
        assert_eq!(id1, id2);
        // metadata refreshed, tags untouched
        let t = db.get_track(id1).unwrap().unwrap();
        assert_eq!(t.artist.as_deref(), Some("Artist2"));
    }

    #[test]
    fn upsert_spotify_playlist_sets_membership() {
        let db = Database::new(":memory:").unwrap();
        let t1 = db.upsert_ghost_track("t1", "spotify:track:t1", "A", "One", "", 100.0).unwrap();
        let t2 = db.upsert_ghost_track("t2", "spotify:track:t2", "B", "Two", "", 100.0).unwrap();
        let pl = db.upsert_spotify_playlist("pl1", "Crate", "snapA", &[t1, t2]).unwrap();
        let pls = db.get_spotify_playlists().unwrap();
        assert_eq!(pls.len(), 1);
        assert_eq!(pls[0].0, pl);
        assert_eq!(pls[0].2.as_deref(), Some("snapA"));
        // re-import with fewer tracks replaces membership
        db.upsert_spotify_playlist("pl1", "Crate", "snapB", &[t2]).unwrap();
        let ids: Vec<i64> = {
            let mut stmt = db.conn.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position").unwrap();
            stmt.query_map([pl], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(ids, vec![t2]);
    }
```

(If `db.conn` is private, add a `#[cfg(test)] pub(crate) fn conn(&self) -> &Connection` accessor or make the field `pub(crate)`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test upsert_` — expected: FAIL (methods not defined).

- [ ] **Step 3: Implement the db helpers**

Add to `impl Database` in db.rs:

```rust
    /// Insert or refresh a Spotify ghost track. Dedupes on spotify_id — the
    /// existing row (which may hold tags, or may be an already-merged local
    /// track) is metadata-refreshed only when still a ghost. Returns row id.
    pub fn upsert_ghost_track(
        &self,
        spotify_id: &str,
        _uri: &str,
        artist: &str,
        title: &str,
        album: &str,
        duration_secs: f64,
    ) -> Result<i64> {
        use rusqlite::OptionalExtension;
        let existing: Option<(i64, String)> = self.conn.query_row(
            "SELECT id, source FROM tracks WHERE spotify_id = ?1",
            params![spotify_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        if let Some((id, source)) = existing {
            if source == "spotify" {
                self.conn.execute(
                    "UPDATE tracks SET artist = ?1, title = ?2, album = ?3, duration_secs = ?4 WHERE id = ?5",
                    params![artist, title, album, duration_secs, id],
                )?;
            }
            return Ok(id);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;
        self.conn.execute(
            "INSERT INTO tracks (
                persistent_id, file_path, artist, title, album, duration_secs,
                format, size_bytes, bit_rate, modified_date, rating, date_added,
                bpm, source, spotify_id
            ) VALUES (?1, '', ?2, ?3, ?4, ?5, 'SPOTIFY', 0, 0, 0, 0, ?6, 0, 'spotify', ?7)",
            params![format!("SP-{}", spotify_id), artist, title, album, duration_secs, now, spotify_id],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn find_track_by_spotify_id(&self, spotify_id: &str) -> Result<Option<i64>> {
        use rusqlite::OptionalExtension;
        Ok(self.conn.query_row(
            "SELECT id FROM tracks WHERE spotify_id = ?1",
            params![spotify_id], |row| row.get(0),
        ).optional()?)
    }

    /// Upsert a Spotify playlist row and replace its membership (ordered).
    pub fn upsert_spotify_playlist(
        &self,
        spotify_playlist_id: &str,
        name: &str,
        snapshot_id: &str,
        track_db_ids: &[i64],
    ) -> Result<i64> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;
        self.conn.execute(
            "INSERT INTO playlists (persistent_id, name, is_folder, origin, itunes_sync_enabled,
                                    spotify_playlist_id, spotify_snapshot_id, created_at, updated_at)
             VALUES (?1, ?2, 0, 'spotify', 0, ?3, ?4, ?5, ?5)
             ON CONFLICT(persistent_id) DO UPDATE SET
                name = excluded.name,
                spotify_snapshot_id = excluded.spotify_snapshot_id,
                updated_at = excluded.updated_at",
            params![format!("SP-PL-{}", spotify_playlist_id), name, spotify_playlist_id, snapshot_id, now],
        )?;
        let playlist_id: i64 = self.conn.query_row(
            "SELECT id FROM playlists WHERE persistent_id = ?1",
            params![format!("SP-PL-{}", spotify_playlist_id)], |row| row.get(0),
        )?;
        self.conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", params![playlist_id])?;
        for (pos, tid) in track_db_ids.iter().enumerate() {
            self.conn.execute(
                "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
                params![playlist_id, tid, pos as i64],
            )?;
        }
        Ok(playlist_id)
    }

    /// (db id, spotify_playlist_id, snapshot_id) for all imported Spotify playlists.
    pub fn get_spotify_playlists(&self) -> Result<Vec<(i64, String, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, spotify_playlist_id, spotify_snapshot_id FROM playlists
             WHERE origin = 'spotify' AND spotify_playlist_id IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
```

Also verify `get_playlists` (the query behind the `get_playlists` command) selects the new columns — `grep -n "fn get_playlists" src-tauri/src/db.rs` and append `spotify_playlist_id, spotify_snapshot_id` to its SELECT + struct mapping (they're `Option<String>`, `row.get(N).unwrap_or(None)`).

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test upsert_` — expected: PASS.

- [ ] **Step 5: Implement sync.rs import + commands**

`src-tauri/src/spotify/sync.rs`:

```rust
use serde::Serialize;

use super::client;
use super::SpotifyState;
use crate::db::Database;

#[derive(Debug, Default, Serialize)]
pub struct ImportReport {
    pub playlists: usize,
    pub tracks_added: usize,
    pub tracks_linked: usize,
}

/// Import (or re-import) the given Spotify playlists: fetch items, upsert
/// ghosts (deduped on spotify_id), and replace playlist membership.
pub async fn import_playlists(
    spotify: &SpotifyState,
    client_id: &str,
    db: &std::sync::Mutex<Database>,
    playlists: Vec<client::SpotifyPlaylistSummary>,
) -> Result<ImportReport, String> {
    let mut report = ImportReport::default();
    for pl in playlists {
        let items = client::get_playlist_items(spotify, client_id, &pl.id).await?;
        let mut track_ids = Vec::with_capacity(items.len());
        {
            let db = db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            for meta in &items {
                let pre_existing = db.find_track_by_spotify_id(&meta.id).map_err(|e| e.to_string())?;
                let id = db
                    .upsert_ghost_track(&meta.id, &meta.uri, &meta.artist, &meta.title, &meta.album, meta.duration_secs)
                    .map_err(|e| e.to_string())?;
                if pre_existing.is_none() {
                    report.tracks_added += 1;
                } else {
                    report.tracks_linked += 1;
                }
                track_ids.push(id);
            }
            db.upsert_spotify_playlist(&pl.id, &pl.name, &pl.snapshot_id, &track_ids)
                .map_err(|e| e.to_string())?;
        }
        report.playlists += 1;
    }
    Ok(report)
}
```

Append to `spotify/commands.rs`:

```rust
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
    let report = super::sync::import_playlists(&spotify, &client_id, &state.db, selected).await?;
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

/// Shared helper for commands needing the configured client id.
fn get_client_id(state: &State<'_, AppState>) -> Result<String, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.get_config("spotify_client_id")
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty())
        .ok_or("Set your Spotify Client ID first".into())
}
```

Register `spotify_list_playlists` and `spotify_import_playlists` in lib.rs. Note `import_playlists` takes `&state.db` — `AppState.db` is `Mutex<Database>`, passed as `&state.db`; this works because `State` derefs to `AppState`.

- [ ] **Step 6: Build + commit**

Run: `cd src-tauri && cargo build && cargo test` — expected: PASS.

```bash
git add -A && git commit -m "feat(spotify): playlist import with ghost-track dedup"
```

---

### Task 7: Auto-sync + ghost garbage collection

**Files:**
- Modify: `src-tauri/src/spotify/sync.rs`
- Modify: `src-tauri/src/db.rs` (GC helper), `src-tauri/src/spotify/commands.rs`, `src-tauri/src/lib.rs`
- Test: inline test in `db.rs`

**Interfaces:**
- Consumes: `client::get_playlist_snapshot`, `db.get_spotify_playlists()`, `import_playlists` internals.
- Produces: `sync_all(spotify, client_id, db) -> Result<SyncReport, String>` with `SyncReport { checked: usize, updated: usize, ghosts_removed: usize }` (serialize); command `spotify_sync_now() -> SyncReport`; db helper `gc_orphan_ghosts() -> Result<usize>`.

- [ ] **Step 1: Write failing GC test**

In db.rs tests:

```rust
    #[test]
    fn gc_removes_untagged_orphan_ghosts_only() {
        let db = Database::new(":memory:").unwrap();
        let orphan_untagged = db.upsert_ghost_track("g1", "u", "A", "T", "", 100.0).unwrap();
        let orphan_tagged = db.upsert_ghost_track("g2", "u", "A", "T", "", 100.0).unwrap();
        db.conn.execute("UPDATE tracks SET comment_raw = ' && energetic' WHERE id = ?1",
            rusqlite::params![orphan_tagged]).unwrap();
        let member = db.upsert_ghost_track("g3", "u", "A", "T", "", 100.0).unwrap();
        db.upsert_spotify_playlist("pl", "P", "s", &[member]).unwrap();
        let removed = db.gc_orphan_ghosts().unwrap();
        assert_eq!(removed, 1);
        assert!(db.get_track(orphan_untagged).unwrap().is_none());
        assert!(db.get_track(orphan_tagged).unwrap().is_some());
        assert!(db.get_track(member).unwrap().is_some());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test gc_removes` — expected: FAIL.

- [ ] **Step 3: Implement GC + sync_all**

db.rs:

```rust
    /// Delete ghosts that are in no playlist and carry no tags/comment.
    /// Tagged orphans are kept — they're still purchase candidates.
    pub fn gc_orphan_ghosts(&self) -> Result<usize> {
        let n = self.conn.execute(
            "DELETE FROM tracks WHERE source = 'spotify'
             AND (comment_raw IS NULL OR TRIM(comment_raw) = '')
             AND id NOT IN (SELECT track_id FROM playlist_tracks)",
            [],
        )?;
        Ok(n)
    }
```

sync.rs — append:

```rust
#[derive(Debug, Default, Serialize)]
pub struct SyncReport {
    pub checked: usize,
    pub updated: usize,
    pub ghosts_removed: usize,
}

/// Re-sync every imported Spotify playlist whose snapshot_id changed,
/// then GC untagged orphan ghosts.
pub async fn sync_all(
    spotify: &SpotifyState,
    client_id: &str,
    db: &std::sync::Mutex<Database>,
) -> Result<SyncReport, String> {
    let imported = {
        let db = db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.get_spotify_playlists().map_err(|e| e.to_string())?
    };
    let mut report = SyncReport { checked: imported.len(), ..Default::default() };
    if imported.is_empty() {
        return Ok(report);
    }
    // One playlist-list call covers snapshot comparison for all imported lists
    // (and playlist renames); fall back to per-playlist snapshot fetch for any
    // imported playlist not in the listing (e.g. followed playlist unfollowed).
    let live = client::list_my_playlists(spotify, client_id).await?;
    let mut to_update = Vec::new();
    for (_db_id, sp_id, snapshot) in &imported {
        match live.iter().find(|p| &p.id == sp_id) {
            Some(p) if Some(p.snapshot_id.as_str()) != snapshot.as_deref() => to_update.push(p.clone()),
            Some(_) => {}
            None => {
                if let Ok(snap) = client::get_playlist_snapshot(spotify, client_id, sp_id).await {
                    if Some(snap.as_str()) != snapshot.as_deref() {
                        // Minimal summary; name/count refreshed on import.
                        to_update.push(client::SpotifyPlaylistSummary {
                            id: sp_id.clone(),
                            name: String::new(),
                            snapshot_id: snap,
                            track_count: 0,
                            owner_name: String::new(),
                        });
                    }
                }
            }
        }
    }
    if !to_update.is_empty() {
        // Preserve names for playlists found in the live listing.
        let updated = import_playlists(spotify, client_id, db, to_update).await?;
        report.updated = updated.playlists;
    }
    {
        let db = db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        report.ghosts_removed = db.gc_orphan_ghosts().map_err(|e| e.to_string())?;
    }
    Ok(report)
}
```

One fix needed for the `None` fallback: `import_playlists` would blank the name. In `upsert_spotify_playlist` the name is always overwritten — change `import_playlists` to skip empty names: in the `db.upsert_spotify_playlist(...)` call, pass the existing name when `pl.name.is_empty()`:

```rust
            let name = if pl.name.is_empty() {
                db.conn_name_for_spotify_playlist(&pl.id).unwrap_or_default()
            } else { pl.name.clone() };
```

Simplest concrete form: add db helper

```rust
    pub fn get_spotify_playlist_name(&self, spotify_playlist_id: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        Ok(self.conn.query_row(
            "SELECT name FROM playlists WHERE spotify_playlist_id = ?1",
            params![spotify_playlist_id], |row| row.get(0),
        ).optional()?)
    }
```

and in `import_playlists` replace the upsert call with:

```rust
            let name = if pl.name.is_empty() {
                db.get_spotify_playlist_name(&pl.id).map_err(|e| e.to_string())?.unwrap_or_default()
            } else {
                pl.name.clone()
            };
            db.upsert_spotify_playlist(&pl.id, &name, &pl.snapshot_id, &track_ids)
                .map_err(|e| e.to_string())?;
```

Command (spotify/commands.rs) + register in lib.rs:

```rust
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
```

- [ ] **Step 4: Run tests + commit**

Run: `cd src-tauri && cargo test && cargo build` — expected: PASS.

```bash
git add -A && git commit -m "feat(spotify): snapshot-based auto-sync and ghost GC"
```

---
### Task 8: Settings tab (Spotify)

**Files:**
- Create: `src/components/settings/SpotifyTab.tsx`
- Modify: `src/components/SettingsPanel.tsx` (TABS list ~line 39, content switch ~line 210)
- Test: `npm run build` + manual

**Interfaces:**
- Consumes: commands `spotify_get_settings`, `spotify_set_client_id`, `spotify_connect`, `spotify_disconnect`; `useToast` from `../Toast`.
- Produces: `<SpotifyTab />` (no props).

- [ ] **Step 1: Create SpotifyTab.tsx**

```tsx
import { useEffect, useState } from 'react';
import { Loader2, LogIn, LogOut } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '../Toast';

interface SpotifySettings {
    client_id: string | null;
    connected: boolean;
    account_name: string | null;
}

export function SpotifyTab() {
    const [settings, setSettings] = useState<SpotifySettings | null>(null);
    const [clientId, setClientId] = useState('');
    const [busy, setBusy] = useState(false);
    const { showSuccess, showError } = useToast();

    const load = () => {
        invoke<SpotifySettings>('spotify_get_settings')
            .then(s => { setSettings(s); setClientId(s.client_id ?? ''); })
            .catch(e => showError(`Failed to load Spotify settings: ${e}`));
    };
    useEffect(load, []);

    const saveClientId = async () => {
        try {
            await invoke('spotify_set_client_id', { clientId });
            showSuccess('Client ID saved');
            load();
        } catch (e) { showError(String(e)); }
    };

    const connect = async () => {
        setBusy(true);
        try {
            if (clientId !== (settings?.client_id ?? '')) {
                await invoke('spotify_set_client_id', { clientId });
            }
            const name = await invoke<string>('spotify_connect');
            showSuccess(`Connected to Spotify as ${name}`);
            load();
        } catch (e) { showError(String(e)); }
        finally { setBusy(false); }
    };

    const disconnect = async () => {
        setBusy(true);
        try {
            await invoke('spotify_disconnect');
            showSuccess('Disconnected from Spotify');
            load();
        } catch (e) { showError(String(e)); }
        finally { setBusy(false); }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
                <h3 style={{ margin: '0 0 4px' }}>Spotify Account</h3>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
                    Import Spotify playlists, tag their tracks before you own the files,
                    and control playback through the Spotify app. Requires Spotify Premium.
                </p>
            </div>

            <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Client ID</label>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <input
                        value={clientId}
                        onChange={e => setClientId(e.target.value)}
                        placeholder="Spotify app Client ID"
                        spellCheck={false}
                        style={{ flex: 1, padding: '6px 8px', background: 'var(--bg-tertiary)',
                                 border: '1px solid var(--border-color)', borderRadius: 6,
                                 color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: 12 }}
                    />
                    <button onClick={saveClientId} disabled={busy}>Save</button>
                </div>
                <details style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                    <summary style={{ cursor: 'pointer' }}>How to get a Client ID</summary>
                    <ol style={{ paddingLeft: 18, lineHeight: 1.6 }}>
                        <li>Go to developer.spotify.com/dashboard and create an app (requires Spotify Premium).</li>
                        <li>Set the Redirect URI to exactly: <code>http://127.0.0.1:43110/callback</code></li>
                        <li>Select "Web API" as the API used, then copy the Client ID here.</li>
                        <li>Development Mode allows the app owner plus up to 4 allowlisted users.</li>
                    </ol>
                </details>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {settings?.connected ? (
                    <>
                        <span style={{ fontSize: 13 }}>
                            Connected{settings.account_name ? ` as ${settings.account_name}` : ''}
                        </span>
                        <button onClick={disconnect} disabled={busy}
                                style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {busy ? <Loader2 size={14} className="spin" /> : <LogOut size={14} />}
                            Disconnect
                        </button>
                    </>
                ) : (
                    <button onClick={connect} disabled={busy || !clientId.trim()}
                            style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {busy ? <Loader2 size={14} className="spin" /> : <LogIn size={14} />}
                        Connect to Spotify
                    </button>
                )}
            </div>
        </div>
    );
}
```

Match the visual idiom of the sibling tabs — before styling, skim `GeneralTab.tsx` and reuse its heading/label/button classes or inline styles if they differ from the above.

- [ ] **Step 2: Register the tab**

In `SettingsPanel.tsx`: add `'spotify'` to `TabId`; import `AudioLines` from lucide-react (Spotify has no lucide glyph; `AudioLines` reads as streaming) and `SpotifyTab` from `./settings/SpotifyTab`; add `{ id: 'spotify', label: 'Spotify', icon: AudioLines },` after the iTunes entry; add `{activeTab === 'spotify' && <SpotifyTab />}` to the content switch.

- [ ] **Step 3: Verify + commit**

Run: `npm run build` — expected: PASS.
Manual: open Settings → Spotify, paste client ID, Connect → browser opens → approve → "Connected as …" appears; restart app → still connected (Keychain).

```bash
git add -A && git commit -m "feat(spotify): settings tab with connect/disconnect"
```

---

### Task 9: Sidebar Spotify section + import modal + sync timer

**Files:**
- Create: `src/components/SpotifyImportModal.tsx`
- Modify: `src/components/Sidebar.tsx` (tree split ~line 672, section render ~line 900, badge ~line 240)
- Modify: `src/App.tsx` (15-min sync timer + launch sync)
- Test: `npm run build` + manual

**Interfaces:**
- Consumes: `Playlist.origin === 'spotify'` (Task 1), commands `spotify_list_playlists`, `spotify_import_playlists`, `spotify_sync_now`, `spotify_get_settings`.
- Produces: `<SpotifyImportModal isOpen onClose onImported />`; Spotify sidebar section with "Import playlists…" button.

- [ ] **Step 1: Create SpotifyImportModal.tsx**

```tsx
import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from './Toast';

interface SpotifyPlaylistSummary {
    id: string;
    name: string;
    snapshot_id: string;
    track_count: number;
    owner_name: string;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onImported: () => void;
}

export function SpotifyImportModal({ isOpen, onClose, onImported }: Props) {
    const [playlists, setPlaylists] = useState<SpotifyPlaylistSummary[] | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [importing, setImporting] = useState(false);
    const { showSuccess, showError } = useToast();

    useEffect(() => {
        if (!isOpen) return;
        setPlaylists(null);
        setSelected(new Set());
        invoke<SpotifyPlaylistSummary[]>('spotify_list_playlists')
            .then(setPlaylists)
            .catch(e => { showError(String(e)); onClose(); });
    }, [isOpen]);

    if (!isOpen) return null;

    const toggle = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const doImport = async () => {
        setImporting(true);
        try {
            const report = await invoke<{ playlists: number; tracks_added: number }>(
                'spotify_import_playlists', { playlistIds: Array.from(selected) });
            showSuccess(`Imported ${report.playlists} playlist${report.playlists === 1 ? '' : 's'} (${report.tracks_added} new tracks)`);
            onImported();
            onClose();
        } catch (e) { showError(String(e)); }
        finally { setImporting(false); }
    };

    return (
        <>
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 10000 }} onClick={onClose} />
            <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                          width: 440, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
                          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                          borderRadius: 10, zIndex: 10001, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <h3 style={{ margin: 0 }}>Import Spotify Playlists</h3>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}><X size={16} /></button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', minHeight: 120 }}>
                    {playlists === null ? (
                        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Loader2 className="spin" /></div>
                    ) : playlists.length === 0 ? (
                        <p style={{ color: 'var(--text-secondary)' }}>No playlists found on this Spotify account.</p>
                    ) : playlists.map(p => (
                        <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', cursor: 'pointer' }}>
                            <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{p.track_count} tracks</span>
                        </label>
                    ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                    <button onClick={onClose}>Cancel</button>
                    <button onClick={doImport} disabled={importing || selected.size === 0}>
                        {importing ? 'Importing…' : `Import ${selected.size || ''}`}
                    </button>
                </div>
            </div>
        </>
    );
}
```

- [ ] **Step 2: Add the Spotify section to Sidebar.tsx**

1. In the tree-splitting logic (~line 672-699) where `tagdeckTree` / `itunesTree` are built from `origin`, add a third bucket: `spotifyTree` for `origin === 'spotify'` (and exclude those from the other two if the split is currently binary if/else).
2. State: `const [spotifyCollapsed, setSpotifyCollapsed] = useState(false);` and `const [spotifyImportOpen, setSpotifyImportOpen] = useState(false);`.
3. After the iTunes section block (~line 928), add a Spotify section mirroring the iTunes collapsible block:

```tsx
    {(filteredSpotifyTree.length > 0 || spotifyConnected) && (
      <>
        <div onClick={() => setSpotifyCollapsed(!spotifyCollapsed)}
             style={/* copy the iTunes header's style object verbatim */}>
          {spotifyCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span style={{ flex: 1 }}>Spotify</span>
          <button className="sidebar-add-btn" title="Import playlists…"
                  onClick={(e) => { e.stopPropagation(); setSpotifyImportOpen(true); }}>
            <Plus size={14} />
          </button>
        </div>
        {(isFiltering || !spotifyCollapsed) && filteredSpotifyTree.map(node => (
          <PlaylistRow key={node.persistent_id} node={node} level={0}
            /* same props as the iTunes rows, but omit onFileDrop */ />
        ))}
      </>
    )}
    <SpotifyImportModal isOpen={spotifyImportOpen}
        onClose={() => setSpotifyImportOpen(false)}
        onImported={() => { onPlaylistsChanged?.(); }} />
```

`spotifyConnected`: load once in Sidebar via `useEffect(() => { invoke<{connected: boolean}>('spotify_get_settings').then(s => setSpotifyConnected(s.connected)).catch(() => {}); }, [refreshTrigger]);` — the section (with its import button) shows when connected even before any import.
4. Apply the filter logic used for the other trees to `spotifyTree` → `filteredSpotifyTree` (same helper).
5. Badge: in `PlaylistRow` (~line 240), next to the iTunes `<Music>` badge, add:

```tsx
{node.origin === 'spotify' && !isRenaming && (
  <span title="Imported from Spotify" style={{ display: 'flex', minWidth: 12, flexShrink: 0 }}>
    <AudioLines size={12} style={{ opacity: 0.5, color: isSelected ? '#fff' : '#1DB954' }} />
  </span>
)}
```

(import `AudioLines` from lucide-react.)
6. Context menu on Spotify playlists: the existing playlist context menu offers rename/delete/sync toggles that don't apply. Where the context menu items are built, for `origin === 'spotify'` show only: "Sync now" (`invoke('spotify_sync_now')` then `onPlaylistsChanged?.()`) and "Remove from TagDeck" (existing `delete_playlist` command — verify it only deletes the playlist row + membership, which is correct for Spotify playlists; ghosts get GC'd on next sync).

- [ ] **Step 3: Launch + interval sync in App.tsx**

Add one effect near the other startup effects:

```tsx
    // Spotify auto-sync: on launch and every 15 minutes.
    useEffect(() => {
        let cancelled = false;
        const sync = async () => {
            try {
                const s = await invoke<{ connected: boolean }>('spotify_get_settings');
                if (!s.connected || cancelled) return;
                const report = await invoke<{ updated: number }>('spotify_sync_now');
                if (report.updated > 0 && !cancelled) handleRefresh();
            } catch (e) {
                console.warn('Spotify sync skipped:', e);
            }
        };
        sync();
        const id = setInterval(sync, 15 * 60 * 1000);
        return () => { cancelled = true; clearInterval(id); };
    }, []);
```

(`handleRefresh` already exists in App.tsx — it's passed to SettingsPanel as `onRefresh`; confirm its name with `grep -n "handleRefresh" src/App.tsx`.)

- [ ] **Step 4: Offline/error indicator on the Spotify header**

Spec §7: offline or revoked-token states show a quiet indicator, and sync skips. Track the last sync failure in Sidebar: when `spotify_sync_now` (context-menu "Sync now") or the settings load fails, set `const [spotifySyncError, setSpotifySyncError] = useState<string | null>(null);` and render in the Spotify header, before the import button:

```tsx
{spotifySyncError && (
  <span title={`Spotify sync unavailable: ${spotifySyncError}`}
        style={{ display: 'flex', flexShrink: 0 }}>
    <CloudOff size={12} style={{ color: 'var(--text-secondary)', opacity: 0.7 }} />
  </span>
)}
```

(import `CloudOff` from lucide-react). In App.tsx's sync effect (Step 3), on failure dispatch `window.dispatchEvent(new CustomEvent('spotify-sync-error', { detail: String(e) }))` instead of only `console.warn`, and on success dispatch it with `detail: null`; Sidebar listens for that event to set/clear the state.

- [ ] **Step 5: Quick-switcher coverage**

`PlaylistCommandPalette.tsx` builds its list from `get_playlists` — verify Spotify playlists appear in ⌘K results (they should automatically, since they're ordinary `playlists` rows). If the palette filters by `origin`, extend the filter to include `'spotify'`.

- [ ] **Step 6: Verify + commit**

Run: `npm run build` — expected: PASS.
Manual: connect → sidebar shows "Spotify" header → Import playlists… → pick two → they appear with green badges; open one → ghost tracks list with artist/title/duration; ⌘K finds the imported playlists; with Wi-Fi off, launch sync shows the CloudOff indicator and no error toast spam.

```bash
git add -A && git commit -m "feat(spotify): sidebar section, import modal, auto-sync timer"
```

---

### Task 10: Ghost styling + guards in TrackList / App

**Files:**
- Modify: `src/components/TrackList.tsx` (row render ~503, title cell ~1257, context menu ~1994, Cmd+R ~1047, drag-out ~1592, MIK analyze ~2028, All-Tracks filter in loadTracks/filter pipeline ~831-1159)
- Modify: `src/App.tsx` (double-click guard not needed — ghosts are playable after Task 11; nothing here yet)
- Test: `npm run build` + manual

**Interfaces:**
- Consumes: `Track.source` (Task 1).
- Produces: ghosts hidden from All Tracks; dimmed rows + Spotify glyph in playlist views; file-ops disabled for ghosts.

- [ ] **Step 1: Hide ghosts outside Spotify playlists**

In TrackList's filtering pipeline, after the playlist-membership filter is applied (where rows for `playlistId == null` mean All Tracks): add

```tsx
    // Ghosts (Spotify imports) only appear inside their playlists —
    // the main library view stays local-files-only.
    const visibleTracks = playlistId == null
        ? tracks.filter(t => t.source !== 'spotify')
        : filteredByMembership;
```

Adapt to the actual variable names around ~line 831-1159 (the memo/effect that derives displayed rows from `tracks`, `playlistId`, and `searchTerm`); the rule: `playlistId == null → exclude source === 'spotify'`.

- [ ] **Step 2: Row styling + glyph**

In the `<tr>` render (~503), add to the row's existing style/className computation: when `row.original.source === 'spotify'`, apply `opacity: 0.75` (same mechanism the `missing` dimming uses — find with `grep -n "missing" src/components/TrackList.tsx | head`, reuse that pattern at lower strength).
In the title cell (~1257) beside the `unlinked` badge, add:

```tsx
      {info.row.original.source === 'spotify' && (
        <span title="Spotify track — not in your library yet"
              style={{ display: 'inline-flex', flexShrink: 0 }}>
          <AudioLines size={12} style={{ color: '#1DB954', opacity: 0.7 }} />
        </span>
      )}
```

(import `AudioLines` from lucide-react.)

- [ ] **Step 3: Guard file operations**

- Context menu (~1994): wrap "Show in Finder" and "Analyze with Mixed In Key" items in `{contextMenu.track.source !== 'spotify' && ( ... )}`.
- Cmd+R reveal (~1047): extend the existing condition to `trackToReveal && trackToReveal.file_path && trackToReveal.source !== 'spotify'`.
- Drag-out (~1592): the filter already requires `t.file_path` — ghosts have `''` which is falsy, so they're excluded; verify and leave as-is.
- MIK analyze (~2028): filter the selection first: `const tracksToAnalyze = selected.filter(t => t.source !== 'spotify');`.

- [ ] **Step 4: Verify + commit**

Run: `npm run build` — expected: PASS.
Manual: All Tracks shows no ghosts; a Spotify playlist shows dimmed rows with green glyphs; right-click a ghost → no Show in Finder; tagging a ghost via the tag deck works and persists across restart.

```bash
git add -A && git commit -m "feat(spotify): ghost row styling and file-op guards"
```

---

### Task 11: Playback via Spotify Connect

**Files:**
- Modify: `src-tauri/src/spotify/commands.rs`, `src-tauri/src/lib.rs` (player commands)
- Create: `src/components/SpotifyPlayer.tsx`
- Modify: `src/components/Player.tsx` (branch for ghosts)
- Test: `cargo build`, `npm run build`, manual

**Interfaces:**
- Consumes: `client::` player functions (Task 4); `Track.spotify_id`.
- Produces: commands `spotify_play_track(spotifyId: String) -> ()` (ensures a device: uses active device, else launches Spotify.app and transfers), `spotify_pause()`, `spotify_resume()`, `spotify_seek(positionMs: u64)`, `spotify_get_playback() -> Option<client::PlaybackState>`; component `<SpotifyPlayer track onNext onPrev accentColor onPlayStateChange />`.

- [ ] **Step 1: Backend player commands**

Append to `spotify/commands.rs`:

```rust
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
```

Register all five in lib.rs. Run `cd src-tauri && cargo build` — expected: PASS.

- [ ] **Step 2: Create SpotifyPlayer.tsx**

A transport bar visually consistent with Player.tsx's standard mode: track title/artist, play/pause, prev/next, seek bar. Polls every 5s, interpolates locally at 250ms.

```tsx
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, AudioLines } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';

interface Props {
    track: Track;
    autoPlay?: boolean;
    onAutoPlayProcessed?: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    accentColor?: string;
    onPlayStateChange?: (isPlaying: boolean) => void;
}

export function SpotifyPlayer({ track, autoPlay, onAutoPlayProcessed, onNext, onPrev, accentColor = '#1DB954', onPlayStateChange }: Props) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [progressMs, setProgressMs] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const durationMs = Math.round(track.duration_secs * 1000);
    const lastPollRef = useRef<number>(0);

    // Start playback when the track changes (double-click sets autoPlay).
    useEffect(() => {
        if (!autoPlay || !track.spotify_id) return;
        setError(null);
        invoke('spotify_play_track', { spotifyId: track.spotify_id })
            .then(() => { setIsPlaying(true); setProgressMs(0); onPlayStateChange?.(true); })
            .catch(e => setError(String(e)))
            .finally(() => onAutoPlayProcessed?.());
    }, [track.id, autoPlay]);

    // Poll real state every 5s; interpolate between polls.
    useEffect(() => {
        const poll = async () => {
            try {
                const s = await invoke<{ is_playing: boolean; progress_ms: number; track_uri: string | null } | null>('spotify_get_playback');
                if (!s || s.track_uri !== `spotify:track:${track.spotify_id}`) return;
                setIsPlaying(s.is_playing);
                setProgressMs(s.progress_ms);
                onPlayStateChange?.(s.is_playing);
                lastPollRef.current = Date.now();
            } catch { /* offline / no device — leave UI as-is */ }
        };
        poll();
        const pollId = setInterval(poll, 5000);
        const tickId = setInterval(() => {
            setProgressMs(p => (isPlaying ? Math.min(p + 250, durationMs) : p));
        }, 250);
        return () => { clearInterval(pollId); clearInterval(tickId); };
    }, [track.id, isPlaying, durationMs]);

    const togglePlay = async () => {
        try {
            if (isPlaying) { await invoke('spotify_pause'); setIsPlaying(false); onPlayStateChange?.(false); }
            else { await invoke('spotify_resume'); setIsPlaying(true); onPlayStateChange?.(true); }
        } catch (e) { setError(String(e)); }
    };

    const seek = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const ms = Number(e.target.value);
        setProgressMs(ms);
        try { await invoke('spotify_seek', { positionMs: ms }); } catch { /* ignore */ }
    };

    const fmt = (ms: number) => {
        const s = Math.floor(ms / 1000);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
            <AudioLines size={18} style={{ color: accentColor, flexShrink: 0 }} />
            <div style={{ minWidth: 0, width: 200 }}>
                <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.title || 'Unknown'}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {track.artist || 'Unknown'} · via Spotify
                </div>
            </div>
            <button onClick={onPrev} title="Previous"><SkipBack size={16} /></button>
            <button onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button onClick={onNext} title="Next"><SkipForward size={16} /></button>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{fmt(progressMs)}</span>
            <input type="range" min={0} max={durationMs} value={Math.min(progressMs, durationMs)}
                   onChange={seek} style={{ flex: 1, accentColor }} />
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{fmt(durationMs)}</span>
            {error && <span style={{ fontSize: 11, color: 'var(--error, #e5484d)' }}>{error}</span>}
        </div>
    );
}
```

Before finalizing markup, mirror Player.tsx's outer container structure/classes so both transports occupy the same footprint. Reuse its button styles.

- [ ] **Step 3: Branch in Player.tsx**

At the top of the `Player` function body (after hooks are declared is NOT allowed — do it before any hooks or as an early return component split):

```tsx
export function Player(props: Props) {
    if (props.track && props.track.source === 'spotify') {
        return (
            <SpotifyPlayer
                track={props.track}
                autoPlay={props.autoPlay}
                onAutoPlayProcessed={props.onAutoPlayProcessed}
                onNext={props.onNext}
                onPrev={props.onPrev}
                accentColor={props.accentColor}
                onPlayStateChange={props.onPlayStateChange}
            />
        );
    }
    return <LocalPlayer {...props} />;
}
```

Mechanically: rename the existing `Player` function to `LocalPlayer` (keep it in the same file, not exported) and add the wrapper above. This keeps hook order legal in both branches.

- [ ] **Step 4: Verify + commit**

Run: `npm run build && cd src-tauri && cargo build` — expected: PASS.
Manual (Premium account, Spotify app installed): double-click a ghost → Spotify app starts playing it; TagDeck transport shows progress advancing; pause/seek/next from TagDeck control the Spotify app; double-click a local track → old player behaves exactly as before.

```bash
git add -A && git commit -m "feat(spotify): Connect playback with TagDeck transport"
```

---
### Task 12: Fuzzy matcher

Pure functions, no IO. Score = `0.5 * title_similarity + 0.35 * artist_similarity + 0.15 * duration_score`, where duration outside ±3s zeroes the whole score (hard gate).

**Files:**
- Modify: `src-tauri/src/spotify/matcher.rs` (replace stub)
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Produces: `normalize(s: &str) -> String`, `similarity(a: &str, b: &str) -> f64` (0..1), `match_score(ghost_artist, ghost_title, ghost_duration_secs, local_artist, local_title, local_duration_secs) -> f64`, `pub const AUTO_MERGE_THRESHOLD: f64 = 0.90`, `pub const REVIEW_THRESHOLD: f64 = 0.60`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_noise() {
        assert_eq!(normalize("Song Title (2011 Remaster)"), "song title");
        assert_eq!(normalize("Track [Extended Mix]"), "track extended mix"); // mix names are meaningful
        assert_eq!(normalize("Artist feat. Someone"), "artist");
        assert_eq!(normalize("Artist ft. Someone"), "artist");
        assert_eq!(normalize("Hello,  World!"), "hello world");
        assert_eq!(normalize("Song - 2014 Remastered Version"), "song");
    }

    #[test]
    fn identical_tracks_score_high() {
        let s = match_score("Daft Punk", "One More Time", 320.0, "Daft Punk", "One More Time", 321.5);
        assert!(s >= AUTO_MERGE_THRESHOLD, "score was {}", s);
    }

    #[test]
    fn remaster_suffix_still_matches() {
        let s = match_score("Daft Punk", "One More Time", 320.0,
                            "Daft Punk", "One More Time (2011 Remaster)", 320.8);
        assert!(s >= AUTO_MERGE_THRESHOLD, "score was {}", s);
    }

    #[test]
    fn duration_gate_kills_mismatch() {
        let s = match_score("Daft Punk", "One More Time", 320.0, "Daft Punk", "One More Time", 200.0);
        assert_eq!(s, 0.0);
    }

    #[test]
    fn different_song_scores_low() {
        let s = match_score("Daft Punk", "One More Time", 320.0, "Daft Punk", "Around the World", 321.0);
        assert!(s < REVIEW_THRESHOLD, "score was {}", s);
    }

    #[test]
    fn similar_but_uncertain_lands_in_review_band() {
        // Same title, different-but-overlapping artist credit → mid confidence
        let s = match_score("Calvin Harris, Dua Lipa", "One Kiss", 214.0, "Calvin Harris", "One Kiss", 214.5);
        assert!(s >= REVIEW_THRESHOLD && s < 1.0, "score was {}", s);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test matcher` — expected: FAIL (functions not defined).

- [ ] **Step 3: Implement matcher.rs**

```rust
//! Pure fuzzy-matching between Spotify ghosts and local files.
//! No IO here — everything is unit-testable.

pub const AUTO_MERGE_THRESHOLD: f64 = 0.90;
pub const REVIEW_THRESHOLD: f64 = 0.60;
const DURATION_TOLERANCE_SECS: f64 = 3.0;

/// Lowercase, strip punctuation, drop "feat./ft./featuring …" credits and
/// remaster/version suffixes. Keeps mix names ("extended mix") — those
/// distinguish genuinely different recordings.
pub fn normalize(s: &str) -> String {
    let lower = s.to_lowercase();

    // Cut "feat."/"ft."/"featuring" and everything after.
    let lower = ["feat.", "feat ", "ft.", "ft ", "featuring"]
        .iter()
        .fold(lower, |acc, marker| match acc.find(marker) {
            Some(idx) => acc[..idx].to_string(),
            None => acc,
        });

    // Remove parenthesized/bracketed chunks that are remaster/version noise.
    let mut out = String::with_capacity(lower.len());
    let mut depth = 0usize;
    let mut chunk = String::new();
    for c in lower.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                chunk.clear();
            }
            ')' | ']' => {
                if depth > 0 {
                    depth -= 1;
                    if !is_version_noise(&chunk) {
                        out.push(' ');
                        out.push_str(&chunk);
                    }
                    chunk.clear();
                }
            }
            _ => {
                if depth > 0 {
                    chunk.push(c);
                } else {
                    out.push(c);
                }
            }
        }
    }

    // Remove "- 2014 remastered version"-style dash suffixes.
    let out = match out.find(" - ") {
        Some(idx) if is_version_noise(&out[idx + 3..]) => out[..idx].to_string(),
        _ => out,
    };

    // Strip punctuation, collapse whitespace.
    out.chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_version_noise(s: &str) -> bool {
    let s = s.trim();
    ["remaster", "remastered", "re-master", "deluxe", "bonus", "single version", "album version", "radio edit"]
        .iter()
        .any(|k| s.contains(k))
        || s.chars().filter(|c| c.is_ascii_digit()).count() == 4 && s.len() <= 24 // "2011 remaster"-ish
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() { return b.len(); }
    if b.is_empty() { return a.len(); }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

/// 0..1 string similarity on normalized inputs: max of edit-distance ratio
/// and token-overlap (Jaccard), so word reordering isn't punished.
pub fn similarity(a: &str, b: &str) -> f64 {
    let a = normalize(a);
    let b = normalize(b);
    if a.is_empty() && b.is_empty() { return 1.0; }
    if a.is_empty() || b.is_empty() { return 0.0; }
    let max_len = a.chars().count().max(b.chars().count()) as f64;
    let edit = 1.0 - levenshtein(&a, &b) as f64 / max_len;
    let ta: std::collections::HashSet<&str> = a.split(' ').collect();
    let tb: std::collections::HashSet<&str> = b.split(' ').collect();
    let jaccard = ta.intersection(&tb).count() as f64 / ta.union(&tb).count() as f64;
    edit.max(jaccard)
}

/// Combined confidence that a local file is the same recording as a ghost.
/// Duration outside the tolerance window is a hard zero.
pub fn match_score(
    ghost_artist: &str,
    ghost_title: &str,
    ghost_duration_secs: f64,
    local_artist: &str,
    local_title: &str,
    local_duration_secs: f64,
) -> f64 {
    let dur_delta = (ghost_duration_secs - local_duration_secs).abs();
    if dur_delta > DURATION_TOLERANCE_SECS {
        return 0.0;
    }
    let duration_score = 1.0 - (dur_delta / DURATION_TOLERANCE_SECS);
    0.5 * similarity(ghost_title, local_title)
        + 0.35 * similarity(ghost_artist, local_artist)
        + 0.15 * duration_score
}
```

- [ ] **Step 4: Run tests until green**

Run: `cd src-tauri && cargo test matcher` — expected: PASS. If a threshold test fails by a small margin, tune `is_version_noise`/weights — do NOT loosen the test expectations; they encode the spec's behavior.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(spotify): fuzzy matcher with duration gate (TDD)"
```

---

### Task 13: Merge engine + pending-match queue

**Files:**
- Modify: `src-tauri/src/spotify/merge.rs` (replace stub)
- Modify: `src-tauri/src/db.rs` (pending_matches migration + helpers)
- Modify: `src-tauri/src/commands.rs` (hook at end of `import_files` ~2299 and `sync_recent_changes` where `tracks_added` are known)
- Modify: `src-tauri/src/spotify/commands.rs`, `src-tauri/src/lib.rs`
- Test: inline test in `merge.rs`

**Interfaces:**
- Consumes: `matcher::{match_score, AUTO_MERGE_THRESHOLD, REVIEW_THRESHOLD}`, `crate::metadata::write_tags` (file-level fn, "left-side preservation"), db helpers below.
- Produces:
  - Migration: `CREATE TABLE IF NOT EXISTS spotify_pending_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, ghost_track_id INTEGER NOT NULL, local_track_id INTEGER NOT NULL, score REAL NOT NULL, created_at INTEGER NOT NULL, UNIQUE(ghost_track_id, local_track_id))` (add to `Database::new` with the other migrations)
  - `merge::process_new_local_tracks(db: &Mutex<Database>, app: &tauri::AppHandle, new_track_ids: &[i64]) -> MergeOutcome` where `MergeOutcome { auto_merged: usize, pending_review: usize }` (Serialize)
  - `merge::merge_ghost_into_local(db: &Database, ghost_id: i64, local_id: i64) -> Result<(), String>` — tag union → file comment via `crate::metadata::write_tags`, repoint `playlist_tracks`, transfer `spotify_id`, delete ghost
  - `merge::union_tags(ghost_comment: &str, local_comment: &str) -> String` — pure, returns the new tag-block string (semicolon-joined union, local first, case-insensitive dedupe)
  - db: `get_ghost_tracks() -> Result<Vec<Track>>`, `get_pending_matches() -> Result<Vec<PendingMatch>>` with `PendingMatch { id: i64, ghost: Track, local: Track, score: f64 }` (Serialize), `add_pending_match(ghost_id, local_id, score)`, `delete_pending_match(id) -> Result<Option<(i64, i64)>>` (returns the pair), `delete_pending_matches_for_ghost(ghost_id)`
  - commands: `spotify_get_pending_matches() -> Vec<PendingMatch>`, `spotify_confirm_match(matchId: i64)`, `spotify_reject_match(matchId: i64)`, `spotify_manual_link(ghostTrackId: i64, localTrackId: i64)`
  - Tauri event `spotify-merge-completed` emitted with payload `{ merged: usize }` after any auto-merge (frontend listens → refresh + toast)

- [ ] **Step 1: Write failing tests for the pure pieces**

In `merge.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn union_tags_merges_and_dedupes_case_insensitively() {
        // ghost has tags only; local has a user comment and one overlapping tag
        assert_eq!(
            union_tags(" && energetic; House", "my note && house; classic"),
            "house; classic; energetic"
        );
        // ghost tags into empty local comment
        assert_eq!(union_tags(" && a; b", ""), "a; b");
        // no ghost tags → local tags unchanged
        assert_eq!(union_tags("just a comment", " && x"), "x");
    }

    #[test]
    fn merge_repoints_playlists_and_transfers_spotify_id() {
        let dbm = crate::db::Database::new(":memory:").unwrap();
        let ghost = dbm.upsert_ghost_track("g1", "u", "Artist", "Title", "Al", 200.0).unwrap();
        dbm.conn.execute("UPDATE tracks SET comment_raw = ' && energetic' WHERE id = ?1",
            rusqlite::params![ghost]).unwrap();
        dbm.upsert_spotify_playlist("pl", "P", "s", &[ghost]).unwrap();
        // local track (no file IO in this test: file_path is a temp file we create)
        let tmp = std::env::temp_dir().join("tagdeck_merge_test.mp3");
        // merge_ghost_into_local skips the file write gracefully if the file
        // can't be tagged — create an empty file so the path exists.
        std::fs::write(&tmp, b"").unwrap();
        let local = dbm.insert_imported_track(&crate::models::Track {
            id: 0, persistent_id: "TD-x".into(), file_path: tmp.to_string_lossy().into_owned(),
            artist: Some("Artist".into()), title: Some("Title".into()), album: None,
            comment_raw: None, grouping_raw: None, duration_secs: 200.0, format: "MP3".into(),
            size_bytes: 0, bit_rate: 0, modified_date: 0, rating: 0, date_added: 0, bpm: 0,
            missing: false, itunes_pid: None, unlinked_at: None,
            source: "local".into(), spotify_id: None,
        }, None, None).unwrap();

        merge_ghost_into_local(&dbm, ghost, local).unwrap();

        assert!(dbm.get_track(ghost).unwrap().is_none(), "ghost deleted");
        let merged = dbm.get_track(local).unwrap().unwrap();
        assert_eq!(merged.spotify_id.as_deref(), Some("g1"));
        assert!(merged.comment_raw.unwrap_or_default().contains("energetic"));
        let member: i64 = dbm.conn.query_row(
            "SELECT track_id FROM playlist_tracks LIMIT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(member, local, "playlist membership repointed");
    }
}
```

(Note: lofty will fail to write tags to an empty non-audio file — `merge_ghost_into_local` must treat the file-write as best-effort: log and continue, since the DB comment is authoritative and the next real tag edit rewrites the file. This behavior is asserted implicitly by the test passing with a dummy file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test merge` — expected: FAIL.

- [ ] **Step 3: Implement merge.rs, db helpers, migration**

Add the `spotify_pending_matches` migration to `Database::new` (with the other `let _ = conn.execute` migrations — full SQL in Interfaces above).

db.rs helpers:

```rust
    pub fn get_ghost_tracks(&self) -> Result<Vec<Track>> {
        // same SELECT/mapping as get_all_tracks with: WHERE source = 'spotify'
    }

    pub fn add_pending_match(&self, ghost_id: i64, local_id: i64, score: f64) -> Result<()> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs() as i64;
        self.conn.execute(
            "INSERT OR IGNORE INTO spotify_pending_matches (ghost_track_id, local_track_id, score, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![ghost_id, local_id, score, now],
        )?;
        Ok(())
    }

    pub fn delete_pending_match(&self, id: i64) -> Result<Option<(i64, i64)>> {
        use rusqlite::OptionalExtension;
        let pair: Option<(i64, i64)> = self.conn.query_row(
            "SELECT ghost_track_id, local_track_id FROM spotify_pending_matches WHERE id = ?1",
            params![id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        self.conn.execute("DELETE FROM spotify_pending_matches WHERE id = ?1", params![id])?;
        Ok(pair)
    }

    pub fn delete_pending_matches_for_ghost(&self, ghost_id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM spotify_pending_matches WHERE ghost_track_id = ?1", params![ghost_id])?;
        Ok(())
    }

    pub fn get_pending_match_rows(&self) -> Result<Vec<(i64, i64, i64, f64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ghost_track_id, local_track_id, score FROM spotify_pending_matches ORDER BY score DESC")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
```

(For `get_ghost_tracks`, copy `get_all_tracks`'s SELECT verbatim and append the WHERE clause — full column list, no shortcuts.)

merge.rs:

```rust
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

use super::matcher;
use crate::db::Database;

#[derive(Debug, Default, Serialize)]
pub struct MergeOutcome {
    pub auto_merged: usize,
    pub pending_review: usize,
}

const DELIMITER: &str = " && ";

fn split_comment(raw: &str) -> (&str, Vec<String>) {
    match raw.find(DELIMITER) {
        Some(idx) => {
            let tags = raw[idx + DELIMITER.len()..]
                .split(';')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
            (&raw[..idx], tags)
        }
        None => (raw, Vec::new()),
    }
}

/// Union of local + ghost tag blocks (local order first, case-insensitive
/// dedupe). Returns only the tag-block string; the caller's file write goes
/// through metadata::write_tags which preserves the local user comment.
pub fn union_tags(ghost_comment: &str, local_comment: &str) -> String {
    let (_, ghost_tags) = split_comment(ghost_comment);
    let (_, local_tags) = split_comment(local_comment);
    let mut seen: Vec<String> = Vec::new();
    for t in local_tags.into_iter().chain(ghost_tags.into_iter()) {
        if !seen.iter().any(|s| s.eq_ignore_ascii_case(&t)) {
            seen.push(t);
        }
    }
    seen.join("; ")
}

/// Merge a ghost into a local track: union tags into the local file's comment
/// (file write is best-effort; DB is authoritative), repoint playlist rows,
/// transfer spotify_id, delete the ghost and its pending matches.
pub fn merge_ghost_into_local(db: &Database, ghost_id: i64, local_id: i64) -> Result<(), String> {
    let ghost = db.get_track(ghost_id).map_err(|e| e.to_string())?.ok_or("Ghost not found")?;
    let local = db.get_track(local_id).map_err(|e| e.to_string())?.ok_or("Local track not found")?;
    if !ghost.is_ghost() {
        return Err("Source track is not a Spotify ghost".into());
    }
    if local.is_ghost() {
        return Err("Target track has no local file".into());
    }

    let ghost_comment = ghost.comment_raw.clone().unwrap_or_default();
    let local_comment = local.comment_raw.clone().unwrap_or_default();
    let merged_tag_block = union_tags(&ghost_comment, &local_comment);

    // 1. File write (best-effort — write_tags preserves the user-comment side)
    if !merged_tag_block.is_empty() {
        if let Err(e) = crate::metadata::write_tags(&local.file_path, &merged_tag_block) {
            eprintln!("Spotify merge: file tag write failed ({}), DB still updated", e);
        }
    }

    // 2. DB comment: rebuild "user && tags" from the local user part
    let (local_user, _) = split_comment(&local_comment);
    let new_comment = if merged_tag_block.is_empty() {
        local_user.to_string()
    } else if local_user.trim().is_empty() {
        format!("{}{}", DELIMITER, merged_tag_block)
    } else {
        format!("{}{}{}", local_user, DELIMITER, merged_tag_block)
    };
    let mut updated = local.clone();
    updated.comment_raw = if new_comment.is_empty() { None } else { Some(new_comment) };
    db.update_track(&updated).map_err(|e| e.to_string())?;

    // 3. Repoint playlist membership (ignore rows where local is already a member)
    db.repoint_playlist_tracks(ghost_id, local_id).map_err(|e| e.to_string())?;

    // 4. Transfer spotify_id, drop ghost + pending matches
    db.transfer_spotify_id(ghost_id, local_id).map_err(|e| e.to_string())?;
    db.delete_pending_matches_for_ghost(ghost_id).map_err(|e| e.to_string())?;
    db.delete_track(ghost_id).map_err(|e| e.to_string())?;
    let _ = db.sync_tags();
    Ok(())
}

/// Match freshly imported local tracks against all ghosts. High confidence →
/// merge now; mid → queue for review. Emits "spotify-merge-completed".
pub fn process_new_local_tracks(
    db: &Mutex<Database>,
    app: &tauri::AppHandle,
    new_track_ids: &[i64],
) -> MergeOutcome {
    let mut outcome = MergeOutcome::default();
    let Ok(db) = db.lock() else { return outcome };
    let Ok(ghosts) = db.get_ghost_tracks() else { return outcome };
    if ghosts.is_empty() {
        return outcome;
    }
    for &local_id in new_track_ids {
        let Ok(Some(local)) = db.get_track(local_id) else { continue };
        if local.is_ghost() { continue; }
        // Best ghost for this new file
        let mut best: Option<(i64, f64)> = None;
        for g in &ghosts {
            let score = matcher::match_score(
                g.artist.as_deref().unwrap_or(""),
                g.title.as_deref().unwrap_or(""),
                g.duration_secs,
                local.artist.as_deref().unwrap_or(""),
                local.title.as_deref().unwrap_or(""),
                local.duration_secs,
            );
            if best.map(|(_, s)| score > s).unwrap_or(score > 0.0) {
                best = Some((g.id, score));
            }
        }
        match best {
            Some((ghost_id, score)) if score >= matcher::AUTO_MERGE_THRESHOLD => {
                if merge_ghost_into_local(&db, ghost_id, local_id).is_ok() {
                    outcome.auto_merged += 1;
                }
            }
            Some((ghost_id, score)) if score >= matcher::REVIEW_THRESHOLD => {
                if db.add_pending_match(ghost_id, local_id, score).is_ok() {
                    outcome.pending_review += 1;
                }
            }
            _ => {}
        }
    }
    if outcome.auto_merged > 0 || outcome.pending_review > 0 {
        let _ = app.emit("spotify-merge-completed", serde_json::json!({
            "merged": outcome.auto_merged, "pending": outcome.pending_review
        }));
        app.state::<crate::logging::LogState>().add_log(
            "INFO",
            &format!("Spotify merge: {} auto-merged, {} queued for review",
                     outcome.auto_merged, outcome.pending_review),
            app,
        );
    }
    outcome
}
```

The helpers referenced above go in db.rs:

```rust
    /// Move playlist memberships from one track to another, skipping
    /// playlists where the target is already a member.
    pub fn repoint_playlist_tracks(&self, from_track: i64, to_track: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE OR IGNORE playlist_tracks SET track_id = ?2 WHERE track_id = ?1",
            params![from_track, to_track],
        )?;
        self.conn.execute(
            "DELETE FROM playlist_tracks WHERE track_id = ?1",
            params![from_track],
        )?;
        Ok(())
    }

    pub fn transfer_spotify_id(&self, from_track: i64, to_track: i64) -> Result<()> {
        use rusqlite::OptionalExtension;
        let sid: Option<String> = self.conn.query_row(
            "SELECT spotify_id FROM tracks WHERE id = ?1", params![from_track], |r| r.get(0),
        ).optional()?.flatten();
        // Clear on the ghost FIRST (unique index), then set on the local track.
        self.conn.execute("UPDATE tracks SET spotify_id = NULL WHERE id = ?1", params![from_track])?;
        if let Some(sid) = sid {
            self.conn.execute("UPDATE tracks SET spotify_id = ?1 WHERE id = ?2", params![sid, to_track])?;
        }
        Ok(())
    }

    pub fn delete_track(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM playlist_tracks WHERE track_id = ?1", params![id])?;
        self.conn.execute("DELETE FROM tracks WHERE id = ?1", params![id])?;
        Ok(())
    }
```

(If `delete_track` already exists — check with `grep -n "fn delete_track" src-tauri/src/db.rs` — reuse it.)

- [ ] **Step 4: Hook into import + sync**

- End of `import_files` (commands.rs ~2299), right before `Ok(ImportSummary {...})`, add:

```rust
    // Spotify merge-on-purchase: match new files against ghost tracks.
    if !imported_track_ids.is_empty() {
        let _ = crate::spotify::merge::process_new_local_tracks(&state.db, &app, &imported_track_ids);
    }
```

- In `sync_recent_changes` (~722): find where newly added tracks' DB ids are known (the `tracks_added` counting site). Collect their ids into a `Vec<i64>` and call the same hook before returning. If ids aren't directly available there, query them: tracks added in this sync have `date_added >= since_timestamp` — acceptable approximation:

```rust
    if result.tracks_added > 0 {
        let new_ids: Vec<i64> = {
            let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
            let mut stmt = db.conn_prepare_new_local_ids(since_timestamp); // or inline query
            stmt
        };
        let _ = crate::spotify::merge::process_new_local_tracks(&state.db, &app, &new_ids);
    }
```

Concrete inline form — add db helper:

```rust
    pub fn get_local_track_ids_added_since(&self, since: i64) -> Result<Vec<i64>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM tracks WHERE source = 'local' AND date_added >= ?1")?;
        let rows = stmt.query_map(params![since], |r| r.get(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
```

- [ ] **Step 5: Review/confirm commands**

`spotify/commands.rs`:

```rust
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
```

Register all four in lib.rs.

- [ ] **Step 6: Run tests + commit**

Run: `cd src-tauri && cargo test && cargo build` — expected: PASS (including the merge tests from Step 1).

```bash
git add -A && git commit -m "feat(spotify): merge engine with auto-merge and review queue"
```

---

### Task 14: Match review UI + manual link + merge notifications

**Files:**
- Create: `src/components/SpotifyMatchReview.tsx`
- Modify: `src/components/Sidebar.tsx` (badge + entry point on the Spotify header)
- Modify: `src/components/TrackList.tsx` (ghost context-menu item "Link to local track…")
- Modify: `src/App.tsx` (listen for `spotify-merge-completed` → toast + refresh)
- Test: `npm run build` + manual

**Interfaces:**
- Consumes: `spotify_get_pending_matches`, `spotify_confirm_match`, `spotify_reject_match`, `spotify_manual_link`, `get_tracks`; event `spotify-merge-completed`.
- Produces: `<SpotifyMatchReview isOpen onClose onChanged />`.

- [ ] **Step 1: Create SpotifyMatchReview.tsx**

```tsx
import { useEffect, useState } from 'react';
import { AudioLines, Check, FileAudio, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';
import { useToast } from './Toast';

interface PendingMatch { id: number; ghost: Track; local: Track; score: number; }

interface Props { isOpen: boolean; onClose: () => void; onChanged: () => void; }

export function SpotifyMatchReview({ isOpen, onClose, onChanged }: Props) {
    const [matches, setMatches] = useState<PendingMatch[]>([]);
    const { showSuccess, showError } = useToast();

    const load = () => {
        invoke<PendingMatch[]>('spotify_get_pending_matches').then(setMatches).catch(e => showError(String(e)));
    };
    useEffect(() => { if (isOpen) load(); }, [isOpen]);

    if (!isOpen) return null;

    const act = async (cmd: 'spotify_confirm_match' | 'spotify_reject_match', m: PendingMatch) => {
        try {
            await invoke(cmd, { matchId: m.id });
            if (cmd === 'spotify_confirm_match') {
                showSuccess(`Merged tags into "${m.local.title ?? 'track'}"`);
                onChanged();
            }
            load();
        } catch (e) { showError(String(e)); }
    };

    const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

    const cell = (t: Track, icon: React.ReactNode) => (
        <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                {icon}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.artist || '?'} — {t.title || '?'}
                </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t.album || ''} · {fmtDur(t.duration_secs)}</div>
        </div>
    );

    return (
        <>
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 10000 }} onClick={onClose} />
            <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                          width: 620, maxHeight: '70vh', overflowY: 'auto',
                          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                          borderRadius: 10, zIndex: 10001, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                    <h3 style={{ margin: 0 }}>Review Matches</h3>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}><X size={16} /></button>
                </div>
                {matches.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No matches waiting for review.</p>}
                {matches.map(m => (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
                                             borderBottom: '1px solid var(--border-color)' }}>
                        {cell(m.ghost, <AudioLines size={13} style={{ color: '#1DB954', flexShrink: 0 }} />)}
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}>
                            {(m.score * 100).toFixed(0)}%
                        </span>
                        {cell(m.local, <FileAudio size={13} style={{ flexShrink: 0 }} />)}
                        <button title="Merge tags into this file" onClick={() => act('spotify_confirm_match', m)}><Check size={14} /></button>
                        <button title="Not the same track" onClick={() => act('spotify_reject_match', m)}><X size={14} /></button>
                    </div>
                ))}
            </div>
        </>
    );
}
```

- [ ] **Step 2: Badge + entry point in Sidebar**

In the Spotify section header from Task 9: load the pending count and render a badge that opens the modal.

```tsx
const [pendingCount, setPendingCount] = useState(0);
const [reviewOpen, setReviewOpen] = useState(false);
useEffect(() => {
    invoke<unknown[]>('spotify_get_pending_matches')
        .then(m => setPendingCount(m.length)).catch(() => {});
}, [refreshTrigger]);
```

In the header row, before the Plus button:

```tsx
{pendingCount > 0 && (
  <button className="sidebar-add-btn" title={`${pendingCount} matches to review`}
          onClick={(e) => { e.stopPropagation(); setReviewOpen(true); }}
          style={{ background: 'var(--accent-color)', color: '#fff', borderRadius: 8,
                   fontSize: 10, padding: '0 6px', minWidth: 16 }}>
    {pendingCount}
  </button>
)}
```

And mount `<SpotifyMatchReview isOpen={reviewOpen} onClose={() => setReviewOpen(false)} onChanged={() => onPlaylistsChanged?.()} />` beside the import modal.

- [ ] **Step 3: Manual link from ghost context menu**

In TrackList's context menu, for `contextMenu.track.source === 'spotify'` add item "Link to local track…". Implement the picker inline: reuse the modal pattern — a small search input filtering the already-loaded `tracks` array (`t.source !== 'spotify'`, match on artist/title substring), listing the top 20, clicking one calls:

```tsx
await invoke('spotify_manual_link', { ghostTrackId: ghost.id, localTrackId: chosen.id });
```

then refreshes (`onRefresh?.()`). Keep it a local component (`GhostLinkPicker`) at the bottom of TrackList.tsx — state: `const [linkPickerGhost, setLinkPickerGhost] = useState<Track | null>(null);` opened from the menu item.

- [ ] **Step 4: Merge notifications in App.tsx**

Beside the existing `listen('music-library-changed', ...)` effect:

```tsx
    useEffect(() => {
        const un = listen<{ merged: number; pending: number }>('spotify-merge-completed', (e) => {
            const { merged, pending } = e.payload;
            if (merged > 0) showSuccess(`Merged Spotify tags into ${merged} purchased track${merged === 1 ? '' : 's'}`);
            if (pending > 0) showToast(`${pending} possible Spotify match${pending === 1 ? '' : 'es'} to review`, 'info');
            handleRefresh();
        });
        return () => { un.then(f => f()); };
    }, []);
```

(`showToast` comes from `useToast()`; confirm the destructured names at App.tsx:27.)

- [ ] **Step 5: Verify + commit**

Run: `npm run build` — expected: PASS.
Manual end-to-end: tag a ghost → drop the purchased file into TagDeck → toast "Merged Spotify tags into 1 purchased track"; file's comment field contains the ghost's tags (check with the metadata viewer); Spotify playlist row now points at the local file (undimmed); ghost gone. For a deliberately renamed file → review badge appears → confirm → same result.

```bash
git add -A && git commit -m "feat(spotify): match review UI, manual linking, merge toasts"
```

---

### Task 15: Docs + changelog

**Files:**
- Modify: `Docs/TestPlan.md`, `Docs/CHANGELOG.md`

**Interfaces:** none.

- [ ] **Step 1: TestPlan entries**

Follow the existing TestPlan.md format (read its most recent section first). Add a "Spotify Integration" section covering: connect (fresh + after restart + wrong client ID), disconnect (data kept), selective import, auto-sync picks up a playlist edit within 15 min / on relaunch, ghost tagging persists, ghosts absent from All Tracks and exports, verify-library ignores ghosts, Connect playback (app closed and open), pause/seek/next, auto-merge on file import (exact + remaster-suffix name), review queue confirm/reject, manual link, GC of untagged removed ghosts, offline behavior (sync skips quietly).

- [ ] **Step 2: CHANGELOG entry**

Follow the existing format under an Unreleased/next-version heading (ask the user before bumping any version number — per project rules): "Added: Spotify integration — import playlists selectively, tag Spotify tracks before you own them, play via Spotify Connect, and automatically merge tags into files when you buy the track (Settings → Spotify; requires Spotify Premium)."

- [ ] **Step 3: Commit**

```bash
git add Docs/TestPlan.md Docs/CHANGELOG.md && git commit -m "docs: test plan + changelog for Spotify integration"
```

---

## Post-plan verification (whole feature)

1. `cd src-tauri && cargo test` — all green.
2. `npm run build` — clean.
3. Full manual pass per the new TestPlan.md section.
4. Run the superpowers:requesting-code-review skill before merging; branch integration via superpowers:finishing-a-development-branch.

## Known risks / watch items

- **`/playlists/{id}/items` vs `/tracks`**: the Feb-2026 API renamed the endpoint; client.rs falls back automatically. If both 404, log the response body — the Development-Mode endpoint set may have shifted again.
- **Search-endpoint result cap (10)** is irrelevant here (we never search), but do not add search-based matching without checking the cap.
- **Keyring on macOS** may prompt the user for Keychain access on first run of a dev build — expected, click "Always Allow".
- **`update_track` writes only comment/grouping/modified** — ghost metadata refresh in `upsert_ghost_track` uses its own UPDATE; don't route ghost updates through `update_track` expecting artist/title persistence.
- **Undo**: ghost tag edits and merges are not pushed to the undo stack (nothing external to revert for ghosts; merge reversal = re-import the playlist and re-tag). The spec's "undoable notification" is satisfied by the toast + the fact that a wrong merge's file-side tags can be edited normally; if full merge-undo proves necessary, add it as a follow-up.
