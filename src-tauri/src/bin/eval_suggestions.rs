//! Dev harness: embed real library tracks and evaluate suggestion quality
//! against the user's existing labels (leave-one-out). Doubles as the Phase 1
//! real-decode check (exercises every audio format) and the Phase 2 quality gate.
//!
//! Usage:
//!   CLAP_MODEL_DIR=<dir> cargo run --bin eval_suggestions -- <db_path> [max_tracks]
//!
//! Embeddings are stored in the given DB (a COPY of the real one), so re-runs
//! skip already-embedded tracks.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tagdeck_lib::analysis::audio::decode_to_mono_48k;
use tagdeck_lib::analysis::clap::{AudioEmbedder, TextEmbedder};
use tagdeck_lib::analysis::model_manager::MODEL_VERSION;
use tagdeck_lib::analysis::prompts::derive_prompt;
use tagdeck_lib::analysis::scoring::{score_suggestions, ScoreInput, TagInfo};
use tagdeck_lib::db::Database;
use tagdeck_lib::models::parse_comment_tags;

const TARGET_TAGS: [&str; 6] = ["Dubstep", "Sinister", "BroStep", "Evening", "Female Vocals", "Breaks"];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let db_path = args.get(1).expect("usage: eval_suggestions <db_path> [max_tracks]");
    let max_tracks: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(250);
    let model_dir = std::env::var("CLAP_MODEL_DIR").expect("set CLAP_MODEL_DIR");
    let model_dir = Path::new(&model_dir);

    let db = Database::new(db_path).expect("open db");

    // 1. Candidate tracks: local, present on disk, with at least one tag.
    let tracks = db.get_all_tracks().expect("tracks");
    let tags = db.get_all_tags().expect("tags");
    let groups = db.get_tag_groups().expect("groups");
    let group_names: HashMap<i64, String> = groups.into_iter().map(|g| (g.id, g.name)).collect();
    let name_to_id: HashMap<String, i64> =
        tags.iter().map(|t| (t.name.to_lowercase(), t.id)).collect();

    let target_ids: HashSet<i64> = TARGET_TAGS
        .iter()
        .filter_map(|t| name_to_id.get(&t.to_lowercase()).copied())
        .collect();

    // Stratify: take up to N/target tracks per target tag, plus a background.
    let mut chosen: Vec<(i64, String)> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    let per_tag = max_tracks / (TARGET_TAGS.len() + 1);
    let mut per_tag_count: HashMap<i64, usize> = HashMap::new();

    for tr in &tracks {
        if tr.source != "local" || tr.missing || tr.file_path.is_empty() {
            continue;
        }
        if !Path::new(&tr.file_path).exists() {
            continue;
        }
        let Some(raw) = &tr.comment_raw else { continue };
        let names = parse_comment_tags(raw);
        if names.is_empty() {
            continue;
        }
        let tids: HashSet<i64> = names
            .iter()
            .filter_map(|n| name_to_id.get(&n.to_lowercase()).copied())
            .collect();
        let hits_target: Vec<i64> = tids.intersection(&target_ids).copied().collect();
        if hits_target.is_empty() {
            continue;
        }
        // Cap per target tag so no single tag dominates the sample.
        if hits_target
            .iter()
            .all(|t| *per_tag_count.get(t).unwrap_or(&0) >= per_tag)
        {
            continue;
        }
        if seen.insert(tr.id) {
            for t in &hits_target {
                *per_tag_count.entry(*t).or_insert(0) += 1;
            }
            chosen.push((tr.id, tr.file_path.clone()));
        }
        if chosen.len() >= max_tracks {
            break;
        }
    }
    println!("Selected {} tracks for embedding", chosen.len());

    // 2. Embed tag prompts (zero-shot anchors).
    let already_tags: HashSet<i64> = db
        .all_tag_text_embeddings(MODEL_VERSION)
        .unwrap()
        .into_iter()
        .map(|(id, _, _)| id)
        .collect();
    {
        let mut text = TextEmbedder::load(model_dir).expect("load text model");
        for tag in &tags {
            if already_tags.contains(&tag.id) {
                continue;
            }
            let gname = tag.group_id.and_then(|g| group_names.get(&g)).map(|s| s.as_str());
            if let Some(prompt) = derive_prompt(&tag.name, gname, tag.description.as_deref()) {
                if let Ok(v) = text.embed_text(&prompt) {
                    db.upsert_tag_text_embedding(tag.id, MODEL_VERSION, &prompt, &v, 0).unwrap();
                }
            }
        }
    }
    println!("Tag prompts embedded");

    // 3. Embed tracks (skip already-embedded) across a small pool.
    let embedded_ids = db.embedded_track_ids(MODEL_VERSION).unwrap();
    let todo: Vec<(i64, String)> =
        chosen.iter().filter(|(id, _)| !embedded_ids.contains(id)).cloned().collect();
    println!("Embedding {} new tracks ({} already done)…", todo.len(), chosen.len() - todo.len());

    let db = Arc::new(Mutex::new(db));
    let queue = Arc::new(Mutex::new(todo.into_iter()));
    let done = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicUsize::new(0));
    let total = chosen.len();

    let workers = std::thread::available_parallelism().map(|n| n.get().min(4)).unwrap_or(2);
    let mut handles = Vec::new();
    for _ in 0..workers {
        let queue = Arc::clone(&queue);
        let db = Arc::clone(&db);
        let done = Arc::clone(&done);
        let failed = Arc::clone(&failed);
        let model_dir = model_dir.to_path_buf();
        handles.push(std::thread::spawn(move || {
            let mut engine = AudioEmbedder::load(&model_dir).expect("load audio model");
            loop {
                let item = { queue.lock().unwrap().next() };
                let Some((id, path)) = item else { break };
                match decode_to_mono_48k(Path::new(&path)).and_then(|s| engine.embed_audio(&s)) {
                    Ok(v) => {
                        db.lock().unwrap().upsert_track_embedding(id, MODEL_VERSION, &v, 0).unwrap();
                    }
                    Err(e) => {
                        failed.fetch_add(1, Ordering::SeqCst);
                        eprintln!("  fail {path}: {e}");
                    }
                }
                let d = done.fetch_add(1, Ordering::SeqCst) + 1;
                if d % 20 == 0 {
                    println!("  embedded {d}…");
                }
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    println!("Embedding complete: {} failed", failed.load(Ordering::SeqCst));

    // 4. Leave-one-out eval over target tags.
    let db = Arc::try_unwrap(db).ok().unwrap().into_inner().unwrap();
    let all_emb = db.all_track_embeddings(MODEL_VERSION).unwrap();
    let emb_ids: HashSet<i64> = all_emb.iter().map(|(id, _)| *id).collect();
    let text: HashMap<i64, Vec<f32>> = db
        .all_tag_text_embeddings(MODEL_VERSION)
        .unwrap()
        .into_iter()
        .map(|(id, _, v)| (id, v))
        .collect();
    let tag_infos: Vec<TagInfo> = tags
        .iter()
        .map(|t| TagInfo { id: t.id, name: t.name.clone(), group_id: t.group_id })
        .collect();

    // Build positives + per-track applied among embedded tracks.
    let mut positives: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut track_tags: HashMap<i64, HashSet<i64>> = HashMap::new();
    for tr in &tracks {
        if !emb_ids.contains(&tr.id) {
            continue;
        }
        if let Some(raw) = &tr.comment_raw {
            for name in parse_comment_tags(raw) {
                if let Some(&tid) = name_to_id.get(&name.to_lowercase()) {
                    positives.entry(tid).or_default().push(tr.id);
                    track_tags.entry(tr.id).or_default().insert(tid);
                }
            }
        }
    }

    println!("\n=== Leave-one-out eval (n embedded = {}) ===", all_emb.len());
    println!("{:<16} {:>6} {:>9} {:>9} {:>10}", "tag", "n", "prec@3", "recall@8", "baseline");
    let emb_index: HashMap<i64, &Vec<f32>> = all_emb.iter().map(|(id, v)| (*id, v)).collect();

    for tname in TARGET_TAGS {
        let Some(&tid) = name_to_id.get(&tname.to_lowercase()) else { continue };
        let pos: Vec<i64> = positives.get(&tid).cloned().unwrap_or_default();
        if pos.len() < 4 {
            println!("{tname:<16} {:>6} (too few)", pos.len());
            continue;
        }
        let baseline = pos.len() as f32 / all_emb.len() as f32; // random top-1 rate
        let mut hit3 = 0usize;
        let mut hit8 = 0usize;
        for &qid in &pos {
            let query = emb_index[&qid];
            // applied = this track's tags minus the held-out target tag.
            let mut applied = track_tags.get(&qid).cloned().unwrap_or_default();
            applied.remove(&tid);
            // Hold out qid from this tag's positives.
            let mut loo_pos = positives.clone();
            if let Some(v) = loo_pos.get_mut(&tid) {
                v.retain(|x| *x != qid);
            }
            let input = ScoreInput {
                query,
                query_track_id: qid,
                all_tracks: &all_emb,
                tag_text: &text,
                tag_positives: &loo_pos,
                tags: &tag_infos,
                applied: &applied,
                threshold: 0.0, // rank-based metric; ignore threshold
                max_total: 64,
                max_per_group: 64,
            };
            let sugg = score_suggestions(&input);
            let rank = sugg.iter().position(|s| s.tag_id == tid);
            if let Some(r) = rank {
                if r < 3 {
                    hit3 += 1;
                }
                if r < 8 {
                    hit8 += 1;
                }
            }
        }
        let n = pos.len() as f32;
        println!(
            "{tname:<16} {:>6} {:>9.2} {:>9.2} {:>10.3}",
            pos.len(),
            hit3 as f32 / n,
            hit8 as f32 / n,
            baseline
        );
    }
}
