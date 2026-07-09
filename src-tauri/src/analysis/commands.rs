//! Tauri commands for the analysis subsystem: model download, batch embedding,
//! and tag suggestions.
//!
//! Long jobs never hold the main DB mutex during CPU work: candidates are
//! snapshotted under a brief lock, the heavy decode+inference runs on worker
//! threads, and each result is written back under a short lock. Progress is
//! surfaced via dedicated `analysis-progress` / `analysis-complete` events.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::audio::decode_to_mono_48k;
use super::clap::{AudioEmbedder, TextEmbedder, EMBED_DIM};
use super::model_manager::{self, ModelStatus, MODEL_VERSION};
use super::prompts::derive_prompt_ensemble;
use super::scoring::{score_suggestions, ScoreInput, Suggestion, TagInfo};
use super::{AnalysisState, AnalysisStatus};
use crate::commands::AppState;
use crate::models::{parse_comment_tags, TagCandidate};

const PROGRESS_EVENT: &str = "analysis-progress";
const COMPLETE_EVENT: &str = "analysis-complete";
const DEFAULT_THRESHOLD: f32 = 0.5;
const MAX_SUGGESTIONS: usize = 8;
const MAX_PER_GROUP: usize = 3;
/// Upper bound on worker threads (each holds a ~34MB audio model in memory).
const MAX_WORKERS: usize = 3;
/// Higher default confidence bar for brand-new tags (vs 0.5 for known tags).
const DEFAULT_VOCAB_THRESHOLD: f32 = 0.6;
/// Never surface more than this many new-tag ghost chips on one track.
const MAX_NEW_TAGS_PER_TRACK: usize = 2;

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Normalize a vector to unit L2 length in place (no-op on the zero vector).
fn l2_normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-12 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))
}

// ---------------------------------------------------------------------------
// Model management
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ModelInfo {
    pub status: ModelStatus,
    pub download_bytes: u64,
    pub version: String,
}

#[tauri::command]
pub async fn get_model_status(app: AppHandle) -> Result<ModelInfo, String> {
    let dir = app_data_dir(&app)?;
    Ok(ModelInfo {
        status: model_manager::status(&dir),
        download_bytes: model_manager::total_download_bytes(),
        version: MODEL_VERSION.to_string(),
    })
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    phase: &'static str,
    bytes_done: u64,
    bytes_total: u64,
}

#[tauri::command]
pub async fn download_analysis_model(app: AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    if model_manager::status(&dir) == ModelStatus::Ready {
        return Ok(());
    }
    let app_ev = app.clone();
    let mut last = Instant::now();
    let mut last_pct = u64::MAX;
    let result = model_manager::download(&dir, |done, total| {
        // Throttle: emit on ~1% change or every 250ms.
        let pct = if total > 0 { done * 100 / total } else { 0 };
        if pct != last_pct || last.elapsed() >= Duration::from_millis(250) {
            last_pct = pct;
            last = Instant::now();
            let _ = app_ev.emit(
                PROGRESS_EVENT,
                DownloadProgress { phase: "downloading_model", bytes_done: done, bytes_total: total },
            );
        }
    })
    .await;

    match result {
        Ok(()) => {
            let _ = app.emit(
                PROGRESS_EVENT,
                DownloadProgress {
                    phase: "downloading_model",
                    bytes_done: model_manager::total_download_bytes(),
                    bytes_total: model_manager::total_download_bytes(),
                },
            );
            Ok(())
        }
        Err(e) => {
            app.state::<crate::logging::LogState>()
                .add_log("ERROR", &format!("Model download failed: {e:#}"), &app);
            Err(format!("Download failed: {e}"))
        }
    }
}

#[tauri::command]
pub async fn remove_analysis_model(app: AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    model_manager::remove(&dir).map_err(|e| format!("Remove failed: {e}"))
}

// ---------------------------------------------------------------------------
// Batch analysis
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct AnalysisProgress {
    phase: String,
    current: usize,
    total: usize,
    embedded: usize,
    failed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    track_id: Option<i64>,
}

#[derive(Serialize, Clone)]
struct AnalysisComplete {
    embedded: usize,
    skipped: usize,
    failed: usize,
    cancelled: bool,
}

struct TagPromptJob {
    tag_id: i64,
    /// Prompt wordings to embed and average into one text anchor.
    prompts: Vec<String>,
    /// Drift-detection key (the joined wordings) stored alongside the vector, so
    /// changing the ensemble templates or a tag's description re-embeds it.
    key: String,
}

#[tauri::command]
pub async fn analyze_tracks(
    app: AppHandle,
    state: State<'_, AppState>,
    analysis: State<'_, AnalysisState>,
    track_ids: Option<Vec<i64>>,
    force: bool,
) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    if model_manager::status(&dir) != ModelStatus::Ready {
        return Err("Analysis model is not downloaded".to_string());
    }
    // Guard against concurrent runs.
    if analysis.running.swap(true, Ordering::SeqCst) {
        return Err("Analysis is already running".to_string());
    }
    analysis.cancel.store(false, Ordering::SeqCst);

    // Snapshot candidates + tag prompt jobs under one brief lock.
    let snapshot = (|| -> Result<(Vec<(i64, String)>, Vec<TagPromptJob>), String> {
        let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
        let embedded = db
            .embedded_track_ids(MODEL_VERSION)
            .map_err(|e| e.to_string())?;
        let id_filter: Option<HashSet<i64>> = track_ids.map(|v| v.into_iter().collect());

        let tracks = db.get_all_tracks().map_err(|e| e.to_string())?;
        let mut candidates = Vec::new();
        for t in &tracks {
            if t.source != "local" || t.missing || t.file_path.is_empty() {
                continue;
            }
            if let Some(filter) = &id_filter {
                if !filter.contains(&t.id) {
                    continue;
                }
            }
            if !force && embedded.contains(&t.id) {
                continue;
            }
            if !std::path::Path::new(&t.file_path).exists() {
                continue;
            }
            candidates.push((t.id, t.file_path.clone()));
        }

        // Tag prompt jobs: (re)embed prompts that are missing or have drifted.
        let groups = db.get_tag_groups().map_err(|e| e.to_string())?;
        let group_names: HashMap<i64, String> =
            groups.into_iter().map(|g| (g.id, g.name)).collect();
        let existing = db
            .all_tag_text_embeddings(MODEL_VERSION)
            .map_err(|e| e.to_string())?;
        let existing_prompt: HashMap<i64, String> =
            existing.into_iter().map(|(id, p, _)| (id, p)).collect();
        let tags = db.get_all_tags().map_err(|e| e.to_string())?;
        let mut tag_jobs = Vec::new();
        for tag in &tags {
            let gname = tag
                .group_id
                .and_then(|gid| group_names.get(&gid))
                .map(|s| s.as_str());
            if let Some(prompts) = derive_prompt_ensemble(&tag.name, gname, tag.description.as_deref())
            {
                let key = prompts.join("\n");
                let needs = force || existing_prompt.get(&tag.id) != Some(&key);
                if needs {
                    tag_jobs.push(TagPromptJob { tag_id: tag.id, prompts, key });
                }
            }
        }
        Ok((candidates, tag_jobs))
    })();

    let (candidates, tag_jobs) = match snapshot {
        Ok(v) => v,
        Err(e) => {
            analysis.running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    let app_job = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_job(app_job, candidates, tag_jobs);
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_analysis(analysis: State<'_, AnalysisState>) -> Result<(), String> {
    analysis.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn get_analysis_status(
    analysis: State<'_, AnalysisState>,
) -> Result<AnalysisStatus, String> {
    let status = analysis.status.lock().map_err(|_| "lock status")?;
    Ok(status.clone())
}

/// The batch job body — runs on a blocking thread; owns no DB lock across work.
fn run_job(app: AppHandle, candidates: Vec<(i64, String)>, tag_jobs: Vec<TagPromptJob>) {
    let dir = match app_data_dir(&app) {
        Ok(d) => d,
        Err(_) => {
            app.state::<AnalysisState>()
                .running
                .store(false, Ordering::SeqCst);
            return;
        }
    };
    let model_dir = model_manager::model_dir(&dir);

    let set_status = |phase: &str, current: usize, total: usize, embedded: usize, failed: usize| {
        if let Ok(mut s) = app.state::<AnalysisState>().status.lock() {
            *s = AnalysisStatus {
                running: true,
                phase: phase.to_string(),
                current,
                total,
                embedded,
                failed,
            };
        }
    };
    let log_err = |msg: String| {
        app.state::<crate::logging::LogState>().add_log("ERROR", &msg, &app);
    };

    // --- Phase 1: embed tag prompts (text tower loaded once, then dropped) ---
    if !tag_jobs.is_empty() {
        set_status("embedding_tags", 0, tag_jobs.len(), 0, 0);
        let _ = app.emit(
            PROGRESS_EVENT,
            AnalysisProgress {
                phase: "embedding_tags".into(),
                current: 0,
                total: tag_jobs.len(),
                embedded: 0,
                failed: 0,
                track_id: None,
            },
        );
        match TextEmbedder::load(&model_dir) {
            Ok(mut text) => {
                for (i, job) in tag_jobs.iter().enumerate() {
                    if app.state::<AnalysisState>().cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    // Embed each wording and mean-pool into one anchor. Averaging
                    // smooths CLAP's sensitivity to exact phrasing (see eval_levers).
                    let mut acc = vec![0f32; EMBED_DIM];
                    let mut n = 0f32;
                    let mut err: Option<String> = None;
                    for p in &job.prompts {
                        match text.embed_text(p) {
                            Ok(v) => {
                                for (k, x) in v.iter().enumerate() {
                                    acc[k] += x;
                                }
                                n += 1.0;
                            }
                            Err(e) => err = Some(format!("{p}: {e:#}")),
                        }
                    }
                    if n > 0.0 {
                        l2_normalize(&mut acc);
                        if let Ok(db) = app.state::<AppState>().db.lock() {
                            let _ = db.upsert_tag_text_embedding(
                                job.tag_id,
                                MODEL_VERSION,
                                &job.key,
                                &acc,
                                now_ts(),
                            );
                        }
                    } else if let Some(e) = err {
                        log_err(format!("tag prompt embed failed ({e})"));
                    }
                    let _ = app.emit(
                        PROGRESS_EVENT,
                        AnalysisProgress {
                            phase: "embedding_tags".into(),
                            current: i + 1,
                            total: tag_jobs.len(),
                            embedded: 0,
                            failed: 0,
                            track_id: None,
                        },
                    );
                }
            }
            // Zero-shot just won't be available; k-NN still works.
            Err(e) => log_err(format!("text model load failed: {e:#}")),
        }
    }

    // --- Phase 2: embed tracks across a small worker pool ---
    let total = candidates.len();
    set_status("analyzing", 0, total, 0, 0);
    let _ = app.emit(
        PROGRESS_EVENT,
        AnalysisProgress {
            phase: "analyzing".into(),
            current: 0,
            total,
            embedded: 0,
            failed: 0,
            track_id: None,
        },
    );

    let queue = Arc::new(Mutex::new(candidates.into_iter()));
    let completed = Arc::new(AtomicUsize::new(0));
    let embedded = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicUsize::new(0));
    let last_emit = Arc::new(Mutex::new(Instant::now()));

    let workers = worker_count(total);
    let mut handles = Vec::new();
    for _ in 0..workers {
        let app = app.clone();
        let model_dir = model_dir.clone();
        let queue = Arc::clone(&queue);
        let completed = Arc::clone(&completed);
        let embedded = Arc::clone(&embedded);
        let failed = Arc::clone(&failed);
        let last_emit = Arc::clone(&last_emit);
        handles.push(std::thread::spawn(move || {
            let mut engine = match AudioEmbedder::load(&model_dir) {
                Ok(e) => e,
                Err(e) => {
                    app.state::<crate::logging::LogState>()
                        .add_log("ERROR", &format!("audio model load failed: {e:#}"), &app);
                    return;
                }
            };
            loop {
                if app.state::<AnalysisState>().cancel.load(Ordering::SeqCst) {
                    break;
                }
                let item = { queue.lock().ok().and_then(|mut q| q.next()) };
                let (track_id, path) = match item {
                    Some(x) => x,
                    None => break,
                };
                match decode_to_mono_48k(std::path::Path::new(&path))
                    .and_then(|samples| engine.embed_audio(&samples))
                {
                    Ok(vec) => {
                        if let Ok(db) = app.state::<AppState>().db.lock() {
                            match db.upsert_track_embedding(track_id, MODEL_VERSION, &vec, now_ts()) {
                                Ok(()) => {
                                    embedded.fetch_add(1, Ordering::SeqCst);
                                }
                                Err(e) => {
                                    failed.fetch_add(1, Ordering::SeqCst);
                                    app.state::<crate::logging::LogState>().add_log(
                                        "ERROR",
                                        &format!("store embedding failed (track {track_id}): {e}"),
                                        &app,
                                    );
                                }
                            }
                        }
                    }
                    Err(e) => {
                        failed.fetch_add(1, Ordering::SeqCst);
                        app.state::<crate::logging::LogState>().add_log(
                            "WARN",
                            &format!("analyze failed ({path}): {e:#}"),
                            &app,
                        );
                    }
                }
                let current = completed.fetch_add(1, Ordering::SeqCst) + 1;
                let emb = embedded.load(Ordering::SeqCst);
                let fail = failed.load(Ordering::SeqCst);
                // Throttle progress to ~250ms, but always emit the final tick.
                let should = current == total
                    || last_emit
                        .lock()
                        .map(|mut t| {
                            if t.elapsed() >= Duration::from_millis(250) {
                                *t = Instant::now();
                                true
                            } else {
                                false
                            }
                        })
                        .unwrap_or(false);
                if should {
                    if let Ok(mut s) = app.state::<AnalysisState>().status.lock() {
                        *s = AnalysisStatus {
                            running: true,
                            phase: "analyzing".to_string(),
                            current,
                            total,
                            embedded: emb,
                            failed: fail,
                        };
                    }
                    let _ = app.emit(
                        PROGRESS_EVENT,
                        AnalysisProgress {
                            phase: "analyzing".into(),
                            current,
                            total,
                            embedded: emb,
                            failed: fail,
                            track_id: Some(track_id),
                        },
                    );
                }
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }

    let cancelled = app.state::<AnalysisState>().cancel.load(Ordering::SeqCst);
    let emb = embedded.load(Ordering::SeqCst);
    let fail = failed.load(Ordering::SeqCst);
    let done = completed.load(Ordering::SeqCst);
    let skipped = total.saturating_sub(done);

    set_status("done", done, total, emb, fail);
    if let Ok(mut s) = app.state::<AnalysisState>().status.lock() {
        s.running = false;
    }
    app.state::<AnalysisState>()
        .running
        .store(false, Ordering::SeqCst);

    let _ = app.emit(
        COMPLETE_EVENT,
        AnalysisComplete { embedded: emb, skipped, failed: fail, cancelled },
    );
}

fn worker_count(total: usize) -> usize {
    if total == 0 {
        return 0;
    }
    let cores = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(2))
        .unwrap_or(2)
        .max(1);
    cores.min(MAX_WORKERS).min(total)
}

// ---------------------------------------------------------------------------
// Suggestions (no model needed — pure vector math over stored embeddings)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct NewTagSuggestion {
    pub candidate_id: i64,
    pub name: String,
    pub group_id: Option<i64>,
    pub score: f32,
}

#[derive(Serialize)]
pub struct SuggestionsResponse {
    /// False when the track has no embedding yet (UI shows "analyze this track").
    pub analyzed: bool,
    pub suggestions: Vec<Suggestion>,
    /// Brand-new tags proposed via vocabulary expansion (may be empty / disabled).
    pub new_tags: Vec<NewTagSuggestion>,
}

#[tauri::command]
pub async fn get_tag_suggestions(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<SuggestionsResponse, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;

    let query = match db
        .get_track_embedding(track_id, MODEL_VERSION)
        .map_err(|e| e.to_string())?
    {
        Some(v) => v,
        None => {
            return Ok(SuggestionsResponse { analyzed: false, suggestions: vec![], new_tags: vec![] })
        }
    };

    let all_tracks = db.all_track_embeddings(MODEL_VERSION).map_err(|e| e.to_string())?;
    let text = db.all_tag_text_embeddings(MODEL_VERSION).map_err(|e| e.to_string())?;
    let tags = db.get_all_tags().map_err(|e| e.to_string())?;
    let tracks = db.get_all_tracks().map_err(|e| e.to_string())?;
    let threshold = db
        .get_config("suggestion_threshold")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(DEFAULT_THRESHOLD);

    // Vocabulary-expansion inputs — only loaded when the toggle is on.
    let vocab_enabled = db
        .get_config("vocab_expansion_enabled")
        .ok()
        .flatten()
        .map(|s| s == "true")
        .unwrap_or(false);
    let (cand_rows, cand_emb, vocab_threshold) = if vocab_enabled {
        let rows = db.get_tag_candidates(Some("approved")).map_err(|e| e.to_string())?;
        let emb = db.all_tag_candidate_embeddings(MODEL_VERSION).map_err(|e| e.to_string())?;
        let t = db
            .get_config("vocab_new_tag_threshold")
            .ok()
            .flatten()
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(DEFAULT_VOCAB_THRESHOLD);
        (rows, emb, t)
    } else {
        (Vec::new(), Vec::new(), DEFAULT_VOCAB_THRESHOLD)
    };
    drop(db);

    // Map applied/positive tag assignments from comment strings.
    let name_to_id: HashMap<String, i64> =
        tags.iter().map(|t| (t.name.to_lowercase(), t.id)).collect();
    let mut positives: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut applied: HashSet<i64> = HashSet::new();
    for tr in &tracks {
        if let Some(raw) = &tr.comment_raw {
            for name in parse_comment_tags(raw) {
                if let Some(&tid) = name_to_id.get(&name.to_lowercase()) {
                    positives.entry(tid).or_default().push(tr.id);
                    if tr.id == track_id {
                        applied.insert(tid);
                    }
                }
            }
        }
    }

    let tag_text: HashMap<i64, Vec<f32>> = text.into_iter().map(|(id, _p, v)| (id, v)).collect();
    let tag_infos: Vec<TagInfo> = tags
        .iter()
        .map(|t| TagInfo { id: t.id, name: t.name.clone(), group_id: t.group_id })
        .collect();

    let input = ScoreInput {
        query: &query,
        query_track_id: track_id,
        all_tracks: &all_tracks,
        tag_text: &tag_text,
        tag_positives: &positives,
        tags: &tag_infos,
        applied: &applied,
        threshold,
        max_total: MAX_SUGGESTIONS,
        max_per_group: MAX_PER_GROUP,
    };
    let suggestions = score_suggestions(&input);

    let new_tags = if vocab_enabled {
        let existing_names: HashSet<String> = tags.iter().map(|t| t.name.to_lowercase()).collect();
        score_new_tags(&query, track_id, &all_tracks, &cand_rows, &cand_emb, &existing_names, vocab_threshold)
    } else {
        Vec::new()
    };

    Ok(SuggestionsResponse { analyzed: true, suggestions, new_tags })
}

/// Zero-shot-score approved vocabulary candidates against a track. Candidates
/// have no positive examples, so the scorer always takes its zero-shot branch.
fn score_new_tags(
    query: &[f32],
    track_id: i64,
    all_tracks: &[(i64, Vec<f32>)],
    cands: &[TagCandidate],
    cand_emb: &[(i64, Vec<f32>)],
    existing_names: &HashSet<String>,
    threshold: f32,
) -> Vec<NewTagSuggestion> {
    if cands.is_empty() || cand_emb.is_empty() {
        return Vec::new();
    }
    let emb_map: HashMap<i64, Vec<f32>> = cand_emb.iter().cloned().collect();
    let infos: Vec<TagInfo> = cands
        .iter()
        .filter(|c| emb_map.contains_key(&c.id) && !existing_names.contains(&c.name.to_lowercase()))
        .map(|c| TagInfo { id: c.id, name: c.name.clone(), group_id: c.group_id })
        .collect();
    if infos.is_empty() {
        return Vec::new();
    }
    let empty_pos: HashMap<i64, Vec<i64>> = HashMap::new();
    let empty_applied: HashSet<i64> = HashSet::new();
    let input = ScoreInput {
        query,
        query_track_id: track_id,
        all_tracks,
        tag_text: &emb_map,
        tag_positives: &empty_pos,
        tags: &infos,
        applied: &empty_applied,
        threshold,
        max_total: MAX_NEW_TAGS_PER_TRACK,
        max_per_group: MAX_NEW_TAGS_PER_TRACK,
    };
    score_suggestions(&input)
        .into_iter()
        .map(|s| NewTagSuggestion {
            candidate_id: s.tag_id,
            name: s.name,
            group_id: s.group_id,
            score: s.score,
        })
        .collect()
}

#[tauri::command]
pub async fn set_tag_description(
    state: State<'_, AppState>,
    tag_id: i64,
    description: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    let desc = description.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    db.set_tag_description(tag_id, desc).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Vocabulary expansion: candidate scan + review
// ---------------------------------------------------------------------------

/// Deterministically propose new-tag candidates from the shape of the tag cloud.
/// No model needed; inserts `proposed` rows (idempotent) and returns the full
/// current candidate list.
#[tauri::command]
pub async fn scan_tag_candidates(state: State<'_, AppState>) -> Result<Vec<TagCandidate>, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    let groups = db.get_tag_groups().map_err(|e| e.to_string())?;
    let tags = db.get_all_tags().map_err(|e| e.to_string())?;

    let existing: HashSet<String> = tags.iter().map(|t| t.name.to_lowercase()).collect();
    let mut by_group: HashMap<i64, Vec<String>> = HashMap::new();
    for t in &tags {
        if let Some(g) = t.group_id {
            by_group.entry(g).or_default().push(t.name.clone());
        }
    }
    let group_pairs: Vec<(i64, String)> = groups.iter().map(|g| (g.id, g.name.clone())).collect();

    let proposed = super::concept_map::propose(&group_pairs, &by_group, &existing);
    let now = now_ts();
    for p in &proposed {
        db.insert_tag_candidate(&p.name, Some(p.group_id), p.description.as_deref(), "concept_map", now)
            .map_err(|e| e.to_string())?;
    }
    db.get_tag_candidates(None).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_tag_candidates(
    state: State<'_, AppState>,
    status: Option<String>,
) -> Result<Vec<TagCandidate>, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    db.get_tag_candidates(status.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn approve_tag_candidate(state: State<'_, AppState>, candidate_id: i64) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    db.set_tag_candidate_status(candidate_id, "approved").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dismiss_tag_candidate(state: State<'_, AppState>, candidate_id: i64) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    db.set_tag_candidate_status(candidate_id, "dismissed").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_tag_candidate(state: State<'_, AppState>, candidate_id: i64) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    db.delete_tag_candidate(candidate_id).map_err(|e| e.to_string())
}

/// Minimum blended confidence a suggestion must clear to be shown, persisted in
/// `library_config`. Mirrors the value `get_tag_suggestions` reads.
#[tauri::command]
pub async fn get_suggestion_threshold(state: State<'_, AppState>) -> Result<f32, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    Ok(db
        .get_config("suggestion_threshold")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(DEFAULT_THRESHOLD))
}

#[tauri::command]
pub async fn set_suggestion_threshold(
    state: State<'_, AppState>,
    threshold: f32,
) -> Result<(), String> {
    let clamped = threshold.clamp(0.0, 1.0);
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    db.set_config("suggestion_threshold", &clamped.to_string())
        .map_err(|e| e.to_string())
}

/// Embed every approved candidate that still lacks an embedding for the current
/// model. Text-only (no audio) — loads the text tower on a blocking thread and
/// drops it when done. Mirrors the tag-prompt recipe in `run_job` Phase 1.
#[tauri::command]
pub async fn embed_tag_candidates(app: AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    if model_manager::status(&dir) != ModelStatus::Ready {
        return Err("Analysis model is not downloaded".to_string());
    }
    let model_dir = model_manager::model_dir(&dir);

    // Snapshot approved-but-unembedded candidates under a brief lock.
    // (TagPromptJob is reused; its `tag_id` field carries the candidate id here.)
    let jobs: Vec<TagPromptJob> = {
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
        let embedded = db.candidate_embedded_ids(MODEL_VERSION).map_err(|e| e.to_string())?;
        let groups = db.get_tag_groups().map_err(|e| e.to_string())?;
        let group_names: HashMap<i64, String> = groups.into_iter().map(|g| (g.id, g.name)).collect();
        let cands = db.get_tag_candidates(Some("approved")).map_err(|e| e.to_string())?;
        let mut jobs = Vec::new();
        for c in &cands {
            if embedded.contains(&c.id) {
                continue;
            }
            let gname = c.group_id.and_then(|gid| group_names.get(&gid)).map(|s| s.as_str());
            if let Some(prompts) = derive_prompt_ensemble(&c.name, gname, c.description.as_deref()) {
                let key = prompts.join("\n");
                jobs.push(TagPromptJob { tag_id: c.id, prompts, key });
            }
        }
        jobs
    };
    if jobs.is_empty() {
        return Ok(());
    }

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut text = TextEmbedder::load(&model_dir).map_err(|e| format!("text model load failed: {e:#}"))?;
        for job in &jobs {
            let mut acc = vec![0f32; EMBED_DIM];
            let mut n = 0f32;
            let mut err = None;
            for p in &job.prompts {
                match text.embed_text(p) {
                    Ok(v) => {
                        for (k, x) in v.iter().enumerate() {
                            acc[k] += x;
                        }
                        n += 1.0;
                    }
                    Err(e) => err = Some(format!("{p}: {e:#}")),
                }
            }
            if n > 0.0 {
                l2_normalize(&mut acc);
                if let Ok(db) = app2.state::<AppState>().db.lock() {
                    let _ = db.upsert_tag_candidate_embedding(job.tag_id, MODEL_VERSION, &job.key, &acc, now_ts());
                }
            } else if let Some(e) = err {
                app2.state::<crate::logging::LogState>()
                    .add_log("ERROR", &format!("candidate prompt embed failed ({e})"), &app2);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("embed task join: {e}"))?
}

#[derive(Serialize)]
pub struct VocabSettings {
    pub enabled: bool,
    pub threshold: f32,
}

#[tauri::command]
pub async fn get_vocab_settings(state: State<'_, AppState>) -> Result<VocabSettings, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    let enabled = db
        .get_config("vocab_expansion_enabled")
        .ok()
        .flatten()
        .map(|s| s == "true")
        .unwrap_or(false);
    let threshold = db
        .get_config("vocab_new_tag_threshold")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(DEFAULT_VOCAB_THRESHOLD);
    Ok(VocabSettings { enabled, threshold })
}

#[tauri::command]
pub async fn set_vocab_settings(
    state: State<'_, AppState>,
    enabled: bool,
    threshold: f32,
) -> Result<(), String> {
    let clamped = threshold.clamp(0.0, 1.0);
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    db.set_config("vocab_expansion_enabled", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())?;
    db.set_config("vocab_new_tag_threshold", &clamped.to_string())
        .map_err(|e| e.to_string())
}

/// Finalize acceptance of a new-tag candidate. Precondition: the tag name has
/// already been applied to a track (creating the `tags` row via `sync_tags`).
/// This files the new tag under the candidate's group, copies the curated
/// zero-shot description, and retires the candidate. Returns the new tag id.
#[tauri::command]
pub async fn finalize_accepted_candidate(
    state: State<'_, AppState>,
    candidate_id: i64,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB")?;
    let cand = db
        .get_tag_candidate(candidate_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Candidate not found".to_string())?;
    let tag_id = db
        .get_tag_id_by_name(&cand.name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Tag has not been created yet".to_string())?;
    db.set_tag_group(tag_id, cand.group_id).map_err(|e| e.to_string())?;
    if let Some(desc) = cand.description.as_deref() {
        db.set_tag_description(tag_id, Some(desc)).map_err(|e| e.to_string())?;
    }
    db.delete_tag_candidate(candidate_id).map_err(|e| e.to_string())?;
    Ok(tag_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: i64, name: &str, group_id: Option<i64>) -> TagCandidate {
        TagCandidate {
            id,
            name: name.to_string(),
            group_id,
            group_name: None,
            description: None,
            status: "approved".to_string(),
            source: "concept_map".to_string(),
        }
    }

    #[test]
    fn score_new_tags_empty_candidates_returns_empty() {
        let existing: HashSet<String> = HashSet::new();
        let out = score_new_tags(&[1.0f32, 0.0], 1, &[], &[], &[], &existing, 0.5);
        assert!(out.is_empty());
    }

    #[test]
    fn score_new_tags_empty_embeddings_returns_empty() {
        let existing: HashSet<String> = HashSet::new();
        let cands = vec![cand(1, "moody", None)];
        let out = score_new_tags(&[1.0f32, 0.0], 1, &[], &cands, &[], &existing, 0.5);
        assert!(out.is_empty());
    }

    #[test]
    fn score_new_tags_missing_candidate_embedding_returns_empty() {
        let existing: HashSet<String> = HashSet::new();
        let cands = vec![cand(1, "moody", None)];
        // Embedding present, but for a different candidate id than the one proposed.
        let cand_emb = vec![(99i64, vec![1.0f32, 0.0])];
        let out = score_new_tags(&[1.0f32, 0.0], 1, &[], &cands, &cand_emb, &existing, 0.5);
        assert!(out.is_empty());
    }

    /// Pins Fix 1: a candidate whose name already exists as a real tag (matched
    /// case-insensitively) must never resurface as a "new tag" suggestion.
    #[test]
    fn score_new_tags_excludes_candidate_already_a_real_tag() {
        let mut existing: HashSet<String> = HashSet::new();
        existing.insert("moody".to_string());
        let cands = vec![cand(1, "Moody", None)];
        let cand_emb = vec![(1i64, vec![1.0f32, 0.0])];
        let out = score_new_tags(&[1.0f32, 0.0], 1, &[], &cands, &cand_emb, &existing, 0.5);
        assert!(out.is_empty());
    }

    /// With `all_tracks` empty, `mean_std` (scoring.rs) deterministically falls
    /// back to (mean=0, std=1), so the zero-shot z-score reduces to plain
    /// `sigmoid(dot(query, candidate_embedding))` with no calibration noise —
    /// safe to assert on exactly, unlike the general calibrated case.
    #[test]
    fn score_new_tags_maps_suggestion_fields_when_deterministically_clears_threshold() {
        let existing: HashSet<String> = HashSet::new();
        let cands = vec![cand(7, "moody", Some(3))];
        let cand_emb = vec![(7i64, vec![1.0f32, 0.0])];
        let out = score_new_tags(&[1.0f32, 0.0], 1, &[], &cands, &cand_emb, &existing, 0.5);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].candidate_id, 7);
        assert_eq!(out[0].name, "moody");
        assert_eq!(out[0].group_id, Some(3));
        assert!(out[0].score >= 0.5);
    }
}
