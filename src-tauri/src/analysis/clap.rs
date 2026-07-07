//! CLAP inference: audio + text towers via ONNX Runtime.
//!
//! Wraps the two Xenova ONNX exports of laion/clap-htsat-unfused plus the
//! RoBERTa tokenizer. Produces L2-normalized 512-dim embeddings that live in a
//! shared space, so `cos(audio, text)` and `cos(audio, audio)` are both
//! meaningful for the scorer.
//!
//! Split into two embedders so a batch job can hold N cheap [`AudioEmbedder`]s
//! (34MB model each) across worker threads while the heavier [`TextEmbedder`]
//! (127MB) is loaded once for tag prompts and dropped.
//!
//! IMPORTANT: the text export has no attention_mask input, so text must be run
//! unpadded, one string at a time (padding tokens would corrupt the embedding).

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use tokenizers::Tokenizer;

use super::features::{fit_window, MelFrontend, MAX_SAMPLES, N_FRAMES, N_MELS};

pub const EMBED_DIM: usize = 512;

pub const AUDIO_MODEL_FILE: &str = "audio_model_quantized.onnx";
pub const TEXT_MODEL_FILE: &str = "text_model_quantized.onnx";
pub const TOKENIZER_FILE: &str = "tokenizer.json";

/// Audio tower + mel frontend. Cheap enough to hold one per worker thread.
pub struct AudioEmbedder {
    audio: Session,
    mel: MelFrontend,
}

impl AudioEmbedder {
    pub fn load(model_dir: &Path) -> Result<Self> {
        let audio = build_session(&model_dir.join(AUDIO_MODEL_FILE)).context("load audio model")?;
        Ok(Self { audio, mel: MelFrontend::new() })
    }

    /// Embed a decoded mono-48k waveform. Averages embeddings of up to three 10s
    /// windows (25/50/75% through the track) for a stable whole-track vector.
    pub fn embed_audio(&mut self, samples: &[f32]) -> Result<Vec<f32>> {
        let mut acc = vec![0.0f32; EMBED_DIM];
        let mut count = 0;
        for start in window_offsets(samples.len()) {
            let slice = &samples[start..(start + MAX_SAMPLES).min(samples.len())];
            let fitted = fit_window(slice);
            let emb = self.embed_one_window(&fitted)?;
            for i in 0..EMBED_DIM {
                acc[i] += emb[i];
            }
            count += 1;
        }
        if count == 0 {
            return Err(anyhow!("no audio windows"));
        }
        l2_normalize(&mut acc);
        Ok(acc)
    }

    fn embed_one_window(&mut self, fitted: &[f32]) -> Result<Vec<f32>> {
        let mel = self.mel.log_mel(fitted); // [N_FRAMES * N_MELS]
        let input = Tensor::from_array(([1usize, 1, N_FRAMES, N_MELS], mel))
            .map_err(|e| anyhow!("build mel tensor: {e}"))?;
        let outputs = self
            .audio
            .run(ort::inputs!["input_features" => input])
            .map_err(|e| anyhow!("audio inference: {e}"))?;
        let (_, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow!("extract audio embeds: {e}"))?;
        let mut v = data[..EMBED_DIM].to_vec();
        l2_normalize(&mut v);
        Ok(v)
    }
}

/// Text tower + tokenizer. Loaded once per job to embed tag prompts.
pub struct TextEmbedder {
    text: Session,
    tokenizer: Tokenizer,
}

impl TextEmbedder {
    pub fn load(model_dir: &Path) -> Result<Self> {
        let text = build_session(&model_dir.join(TEXT_MODEL_FILE)).context("load text model")?;
        let tokenizer = Tokenizer::from_file(model_dir.join(TOKENIZER_FILE))
            .map_err(|e| anyhow!("load tokenizer: {e}"))?;
        Ok(Self { text, tokenizer })
    }

    /// Embed a text prompt. Run unpadded (see module note).
    pub fn embed_text(&mut self, text: &str) -> Result<Vec<f32>> {
        let enc = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| anyhow!("tokenize: {e}"))?;
        let ids: Vec<i64> = enc.get_ids().iter().map(|&i| i as i64).collect();
        let len = ids.len();
        let input = Tensor::from_array(([1usize, len], ids))
            .map_err(|e| anyhow!("build ids tensor: {e}"))?;
        let outputs = self
            .text
            .run(ort::inputs!["input_ids" => input])
            .map_err(|e| anyhow!("text inference: {e}"))?;
        let (_, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow!("extract text embeds: {e}"))?;
        let mut v = data[..EMBED_DIM].to_vec();
        l2_normalize(&mut v);
        Ok(v)
    }
}

fn build_session(path: &Path) -> Result<Session> {
    // ort errors are not Send, so `?`-into-anyhow fails; stringify at each step.
    let mut builder = Session::builder()
        .map_err(|e| anyhow!("ort builder: {e}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| anyhow!("ort opt level: {e}"))?
        .with_intra_threads(1)
        .map_err(|e| anyhow!("ort threads: {e}"))?;
    builder
        .commit_from_file(path)
        .map_err(|e| anyhow!("commit model: {e}"))
}

/// Choose up to three window start offsets (25/50/75%) that each fit MAX_SAMPLES.
/// Short tracks collapse to a single zero-offset window (padded downstream).
fn window_offsets(len: usize) -> Vec<usize> {
    if len <= MAX_SAMPLES {
        return vec![0];
    }
    let max_start = len - MAX_SAMPLES;
    let mut offs: Vec<usize> = [0.25f64, 0.5, 0.75]
        .iter()
        .map(|f| ((len as f64 * f) as usize).min(max_start))
        .collect();
    offs.dedup();
    offs
}

fn l2_normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-12 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}
