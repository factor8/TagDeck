//! Local audio analysis → tag recommendation.
//!
//! Pipeline: decode (audio.rs) → log-mel (features.rs) → CLAP embeddings
//! (clap.rs) → hybrid scoring (scoring.rs, Phase 2). Embeddings persist in
//! SQLite so suggestions never need the model loaded.

pub mod audio;
pub mod clap;
pub mod features;
