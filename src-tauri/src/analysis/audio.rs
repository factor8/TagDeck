//! Audio decoding + resampling to mono 48kHz f32 for the CLAP frontend.
//!
//! Primary path is symphonia (pure Rust, all our formats). On any decode
//! failure we fall back to macOS's built-in `afconvert`, which can decode
//! anything Core Audio handles (HE-AAC, odd ALAC/AIFF variants) — this keeps a
//! single bad file from ever aborting a batch.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{anyhow, Context, Result};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use super::features::SAMPLE_RATE;

/// Decode `path` to mono f32 at 48kHz. Tries symphonia, then afconvert.
pub fn decode_to_mono_48k(path: &Path) -> Result<Vec<f32>> {
    match decode_symphonia(path) {
        Ok(s) if !s.is_empty() => Ok(s),
        Ok(_) => decode_afconvert(path).context("symphonia produced no samples; afconvert fallback"),
        Err(e) => decode_afconvert(path)
            .with_context(|| format!("symphonia failed ({e}); afconvert fallback also failed")),
    }
}

fn decode_symphonia(path: &Path) -> Result<Vec<f32>> {
    let file = std::fs::File::open(path).context("open audio file")?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .context("probe format")?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| anyhow!("no audio track"))?;
    let track_id = track.id;
    let audio_params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| anyhow!("missing audio codec params"))?
        .clone();

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&audio_params, &AudioDecoderOptions::default())
        .context("make decoder")?;

    let mut mono: Vec<f32> = Vec::new();
    let mut src_rate: Option<u32> = None;
    let mut interleaved: Vec<f32> = Vec::new();

    while let Some(packet) = format.next_packet().context("read packet")? {
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                let spec = buf.spec();
                let channels = spec.channels().count().max(1);
                src_rate.get_or_insert(spec.rate());

                let n = buf.samples_interleaved();
                interleaved.resize(n, 0.0);
                buf.copy_to_slice_interleaved(&mut interleaved[..]);

                // Downmix to mono by averaging channels.
                mono.reserve(n / channels);
                for frame in interleaved[..n].chunks_exact(channels) {
                    let sum: f32 = frame.iter().sum();
                    mono.push(sum / channels as f32);
                }
            }
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(e) => return Err(anyhow!("decode error: {e}")),
        }
    }

    let src_rate = src_rate.ok_or_else(|| anyhow!("no decoded audio"))?;
    resample_to_48k(mono, src_rate)
}

/// Resample mono f32 from `src_rate` to 48kHz using a high-quality sinc filter.
/// Passthrough when already at target rate.
fn resample_to_48k(mono: Vec<f32>, src_rate: u32) -> Result<Vec<f32>> {
    if src_rate == SAMPLE_RATE || mono.is_empty() {
        return Ok(mono);
    }
    let ratio = SAMPLE_RATE as f64 / src_rate as f64;
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let chunk = 16_384usize;
    let mut resampler = SincFixedIn::<f32>::new(ratio, 2.0, params, chunk, 1)
        .context("build resampler")?;

    let mut out: Vec<f32> = Vec::with_capacity((mono.len() as f64 * ratio) as usize + chunk);
    let mut pos = 0usize;
    while pos < mono.len() {
        let end = (pos + chunk).min(mono.len());
        let mut frame = mono[pos..end].to_vec();
        let is_last = end == mono.len();
        if frame.len() < chunk {
            frame.resize(chunk, 0.0); // pad final partial chunk
        }
        let res = resampler
            .process(&[frame], None)
            .context("resample chunk")?;
        out.extend_from_slice(&res[0]);
        if is_last {
            break;
        }
        pos = end;
    }
    Ok(out)
}

/// Fallback: shell out to macOS `afconvert` → temp 32-bit float WAV @48kHz mono,
/// then decode that WAV with symphonia (guaranteed-simple PCM path).
fn decode_afconvert(path: &Path) -> Result<Vec<f32>> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let tmp = std::env::temp_dir().join(format!(
        "tagdeck-clap-{}-{}.wav",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let status = std::process::Command::new("/usr/bin/afconvert")
        .args(["-f", "WAVE", "-d", "LEF32@48000", "-c", "1"])
        .arg(path)
        .arg(&tmp)
        .status()
        .context("spawn afconvert")?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(anyhow!("afconvert exited with {status}"));
    }
    let out = decode_symphonia(&tmp);
    let _ = std::fs::remove_file(&tmp);
    out
}
