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
