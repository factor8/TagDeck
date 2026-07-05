// Spotify OAuth (PKCE) token exchange, refresh, and Keychain storage.
// Real implementation lands in the auth task.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds when access_token expires.
    pub expires_at: i64,
}

pub fn load_tokens() -> Option<TokenSet> {
    None // real Keychain implementation lands in the auth task
}
