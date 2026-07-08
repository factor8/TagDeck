//! Local audio analysis → tag recommendation.
//!
//! Pipeline: decode (audio.rs) → log-mel (features.rs) → CLAP embeddings
//! (clap.rs) → hybrid scoring (scoring.rs) → suggestions. Embeddings persist in
//! SQLite so suggestions never need the model loaded.

pub mod audio;
pub mod clap;
pub mod concept_map;
pub mod commands;
pub mod features;
pub mod model_manager;
pub mod prompts;
pub mod scoring;

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use serde::Serialize;

/// Managed state for the analysis subsystem. Kept separate from `AppState` so a
/// long-running batch job never contends on the main DB mutex for bookkeeping.
#[derive(Default)]
pub struct AnalysisState {
    /// True while a batch job is in flight (guards against concurrent runs).
    pub running: AtomicBool,
    /// Set by `cancel_analysis`; workers check it between tracks.
    pub cancel: AtomicBool,
    /// Latest snapshot, so the UI can re-attach after a window reopen.
    pub status: Mutex<AnalysisStatus>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalysisStatus {
    pub running: bool,
    /// "idle" | "loading_model" | "embedding_tags" | "analyzing" | "done"
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub embedded: usize,
    pub failed: usize,
}

impl Default for AnalysisStatus {
    fn default() -> Self {
        Self {
            running: false,
            phase: "idle".to_string(),
            current: 0,
            total: 0,
            embedded: 0,
            failed: 0,
        }
    }
}
