//! Download-on-demand management for the CLAP model.
//!
//! The model is NOT bundled with the app (it's ~160MB). The user opts in from
//! Settings; we fetch from a pinned Hugging Face revision, verify sha256, and
//! store under `app_data_dir/models/<MODEL_VERSION>/`. Nothing here ever runs
//! without an explicit user action.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::clap::{AUDIO_MODEL_FILE, TEXT_MODEL_FILE, TOKENIZER_FILE};

/// Bump this whenever the model files or preprocessing change. Old embeddings
/// keyed by a prior version simply stop matching (no destructive migration).
pub const MODEL_VERSION: &str = "clap-htsat-unfused-q8-v1";

/// Immutable Hugging Face revision the files are pinned to.
const HF_REPO: &str = "Xenova/clap-htsat-unfused";
const HF_REVISION: &str = "c28f2883575e590e04d3146ff0713c2448d691ba";

struct RemoteFile {
    /// Local filename (also the name the loader expects).
    name: &'static str,
    /// Path within the HF repo.
    repo_path: &'static str,
    sha256: &'static str,
    size: u64,
}

const FILES: [RemoteFile; 3] = [
    RemoteFile {
        name: AUDIO_MODEL_FILE,
        repo_path: "onnx/audio_model_quantized.onnx",
        sha256: "3fcff2c8824e7bcb83a983f2a49edab3b60cbcf4872ac70efee517355173bd1f",
        size: 34_301_667,
    },
    RemoteFile {
        name: TEXT_MODEL_FILE,
        repo_path: "onnx/text_model_quantized.onnx",
        sha256: "1a3df8b197e249816e08415fd040434c44762b2eea7eb7bf8a48a0f0bf3c14e5",
        size: 126_603_263,
    },
    RemoteFile {
        name: TOKENIZER_FILE,
        repo_path: "tokenizer.json",
        sha256: "dc239041d98de27ffc3975473a1a23e3db4c937b23c138c38bbc66588bd247e5",
        size: 2_108_774,
    },
];

/// Total download size in bytes (for the UI to show before starting).
pub fn total_download_bytes() -> u64 {
    FILES.iter().map(|f| f.size).sum()
}

/// Model directory for the active version under the app data dir.
pub fn model_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("models").join(MODEL_VERSION)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ModelStatus {
    /// No usable model present.
    NotDownloaded,
    /// All files present and hash-verified.
    Ready,
}

/// Ready only if every file exists at the right size (cheap check; full hash
/// verification happens during/after download).
pub fn status(app_data_dir: &Path) -> ModelStatus {
    let dir = model_dir(app_data_dir);
    let ok = FILES.iter().all(|f| {
        std::fs::metadata(dir.join(f.name))
            .map(|m| m.len() == f.size)
            .unwrap_or(false)
    });
    if ok {
        ModelStatus::Ready
    } else {
        ModelStatus::NotDownloaded
    }
}

/// Delete the downloaded model to free disk. Stored embeddings are untouched, so
/// re-downloading later does not require re-analyzing the library.
pub fn remove(app_data_dir: &Path) -> Result<()> {
    let dir = model_dir(app_data_dir);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).context("remove model dir")?;
    }
    Ok(())
}

/// Download any missing/invalid files, verifying sha256. `on_progress` is called
/// with (bytes_done, bytes_total) across the whole set; it should throttle its
/// own emission. Resumable: existing valid files are skipped.
pub async fn download<F: FnMut(u64, u64)>(app_data_dir: &Path, mut on_progress: F) -> Result<()> {
    let dir = model_dir(app_data_dir);
    std::fs::create_dir_all(&dir).context("create model dir")?;

    let total: u64 = total_download_bytes();
    // Bytes already accounted for by files that are present and valid.
    let mut done: u64 = 0;

    let client = reqwest::Client::builder()
        .build()
        .context("build http client")?;

    for f in FILES.iter() {
        let dest = dir.join(f.name);
        if file_matches(&dest, f) {
            done += f.size;
            on_progress(done, total);
            continue;
        }

        let url = format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            HF_REPO, HF_REVISION, f.repo_path
        );
        let part = dir.join(format!("{}.part", f.name));
        let resp = client
            .get(&url)
            .send()
            .await
            .with_context(|| format!("request {}", f.name))?
            .error_for_status()
            .with_context(|| format!("http status for {}", f.name))?;

        let mut hasher = Sha256::new();
        let mut file = std::fs::File::create(&part).context("create .part file")?;
        let mut stream = resp.bytes_stream();
        let file_start = done;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.with_context(|| format!("stream {}", f.name))?;
            use std::io::Write;
            hasher.update(&chunk);
            file.write_all(&chunk).context("write chunk")?;
            done = done.saturating_add(chunk.len() as u64);
            on_progress(done, total);
        }
        drop(file);

        let digest = hex::encode(hasher.finalize());
        if digest != f.sha256 {
            let _ = std::fs::remove_file(&part);
            return Err(anyhow!(
                "sha256 mismatch for {} (expected {}, got {})",
                f.name,
                f.sha256,
                digest
            ));
        }
        std::fs::rename(&part, &dest).context("finalize model file")?;
        // Re-anchor the running total to the file boundary in case of retries.
        done = file_start + f.size;
        on_progress(done, total);
    }
    Ok(())
}

fn file_matches(path: &Path, f: &RemoteFile) -> bool {
    // Size check only — hashing on every status poll would be wasteful. Full
    // hash verification happens at download time; a size match on a finalized
    // file is sufficient confidence for load.
    std::fs::metadata(path).map(|m| m.len() == f.size).unwrap_or(false)
}

/// Local hex encoder (avoids pulling the `hex` crate for one call site).
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        let mut s = String::with_capacity(bytes.as_ref().len() * 2);
        for b in bytes.as_ref() {
            s.push_str(&format!("{:02x}", b));
        }
        s
    }
}
