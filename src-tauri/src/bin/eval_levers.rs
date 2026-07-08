//! A/B harness for the two "free" quality levers, measured by full-vocabulary
//! leave-one-out prec@3 against a real library (reuses the track embeddings
//! cached by `eval_diagnose`, keyed by model_version):
//!
//!   Lever 1 — personalized scorer:   TopK cosine   vs   mean-diff linear probe
//!   Lever 2 — zero-shot text anchor: single prompt vs   prompt ensemble
//!
//! Both tag-text variants are computed in-memory (not persisted), so this never
//! disturbs the shipping `tag_text_embeddings`. It reports each lever in
//! isolation plus the combined switch policy, so we can see whether stacking
//! them helps before wiring anything into the suggestion path.
//!
//! Usage:
//!   CLAP_MODEL_DIR=<onnx_dir> cargo run --release --bin eval_levers -- <db_path> [max_tracks]

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tagdeck_lib::analysis::audio::decode_to_mono_48k;
use tagdeck_lib::analysis::clap::{AudioEmbedder, TextEmbedder};
use tagdeck_lib::analysis::model_manager::MODEL_VERSION;
use tagdeck_lib::analysis::prompts::{derive_prompt, derive_prompt_ensemble};
use tagdeck_lib::analysis::scoring::{
    score_suggestions_with, KnnMode, ScoreInput, ScoreParams, TagInfo,
};
use tagdeck_lib::db::Database;
use tagdeck_lib::models::parse_comment_tags;

const MIN_EVAL: usize = 4;

fn l2(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 1e-12 {
        for x in v.iter_mut() {
            *x /= n;
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let db_path = args.get(1).expect("usage: eval_levers <db_path> [max_tracks]");
    let max_tracks: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(400);
    let model_dir = std::env::var("CLAP_MODEL_DIR").expect("set CLAP_MODEL_DIR");
    let model_dir = Path::new(&model_dir);

    let db = Database::new(db_path).expect("open db");
    let tracks = db.get_all_tracks().expect("tracks");
    let tags = db.get_all_tags().expect("tags");
    let groups = db.get_tag_groups().expect("groups");
    let group_names: HashMap<i64, String> = groups.into_iter().map(|g| (g.id, g.name)).collect();
    let name_to_id: HashMap<String, i64> =
        tags.iter().map(|t| (t.name.to_lowercase(), t.id)).collect();

    // 1. Candidates: every local, present, tagged track.
    let mut chosen: Vec<(i64, String)> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for tr in &tracks {
        if tr.source != "local" || tr.missing || tr.file_path.is_empty() {
            continue;
        }
        if !Path::new(&tr.file_path).exists() {
            continue;
        }
        let Some(raw) = &tr.comment_raw else { continue };
        if parse_comment_tags(raw).is_empty() {
            continue;
        }
        if seen.insert(tr.id) {
            chosen.push((tr.id, tr.file_path.clone()));
        }
        if chosen.len() >= max_tracks {
            break;
        }
    }
    println!("Candidate tagged tracks present on disk: {}", chosen.len());

    // 2. Embed tracks (reuse the cache eval_diagnose populated).
    let embedded_ids = db.embedded_track_ids(MODEL_VERSION).unwrap();
    let todo: Vec<(i64, String)> =
        chosen.iter().filter(|(id, _)| !embedded_ids.contains(id)).cloned().collect();
    println!("Embedding {} new tracks ({} cached)…", todo.len(), chosen.len() - todo.len());

    let db = Arc::new(Mutex::new(db));
    let queue = Arc::new(Mutex::new(todo.into_iter()));
    let done = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicUsize::new(0));
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
                if d % 25 == 0 {
                    println!("  embedded {d}…");
                }
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    let db = Arc::try_unwrap(db).ok().unwrap().into_inner().unwrap();
    println!("Embedding complete: {} failed\n", failed.load(Ordering::SeqCst));

    // 3. Build both tag-text variants in memory (single vs ensemble).
    let all_emb = db.all_track_embeddings(MODEL_VERSION).unwrap();
    let emb_ids: HashSet<i64> = all_emb.iter().map(|(id, _)| *id).collect();
    let mut text_single: HashMap<i64, Vec<f32>> = HashMap::new();
    let mut text_ens: HashMap<i64, Vec<f32>> = HashMap::new();
    {
        let mut te = TextEmbedder::load(model_dir).expect("load text model");
        for tag in &tags {
            let gname = tag.group_id.and_then(|g| group_names.get(&g)).map(|s| s.as_str());
            if let Some(p) = derive_prompt(&tag.name, gname, tag.description.as_deref()) {
                if let Ok(v) = te.embed_text(&p) {
                    text_single.insert(tag.id, v);
                }
            }
            if let Some(prompts) = derive_prompt_ensemble(&tag.name, gname, tag.description.as_deref())
            {
                let mut acc = vec![0f32; 512];
                let mut c = 0f32;
                for p in &prompts {
                    if let Ok(v) = te.embed_text(p) {
                        for (i, x) in v.iter().enumerate() {
                            acc[i] += x;
                        }
                        c += 1.0;
                    }
                }
                if c > 0.0 {
                    l2(&mut acc);
                    text_ens.insert(tag.id, acc);
                }
            }
        }
    }

    // 4. Positives / applied maps over embedded tracks.
    let tag_infos: Vec<TagInfo> = tags
        .iter()
        .map(|t| TagInfo { id: t.id, name: t.name.clone(), group_id: t.group_id })
        .collect();
    let empty_text: HashMap<i64, Vec<f32>> = HashMap::new();
    let empty_pos: HashMap<i64, Vec<i64>> = HashMap::new();
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
    let emb_index: HashMap<i64, &Vec<f32>> = all_emb.iter().map(|(id, v)| (*id, v)).collect();

    // 5. LOO runner: returns held-out tag's rank under a given text map / positives / params.
    let run = |qid: i64,
               tid: i64,
               tag_text: &HashMap<i64, Vec<f32>>,
               tag_pos: &HashMap<i64, Vec<i64>>,
               params: ScoreParams|
     -> Option<usize> {
        let query = emb_index[&qid];
        let mut applied = track_tags.get(&qid).cloned().unwrap_or_default();
        applied.remove(&tid);
        let mut loo = tag_pos.clone();
        if let Some(v) = loo.get_mut(&tid) {
            v.retain(|x| *x != qid);
        }
        let input = ScoreInput {
            query,
            query_track_id: qid,
            all_tracks: &all_emb,
            tag_text,
            tag_positives: &loo,
            tags: &tag_infos,
            applied: &applied,
            threshold: 0.0,
            max_total: 64,
            max_per_group: 64,
        };
        score_suggestions_with(&input, params).iter().position(|s| s.tag_id == tid)
    };

    let topk = ScoreParams { knn_trust: 8, knn_top_k: 5, knn_mode: KnnMode::TopK };
    let probe = ScoreParams { knn_trust: 8, knn_top_k: 5, knn_mode: KnnMode::MeanDiffProbe };

    // Measurable tags, bucketed by example count.
    let measurable: Vec<(i64, Vec<i64>)> = tags
        .iter()
        .filter_map(|t| {
            let p = positives.get(&t.id).cloned().unwrap_or_default();
            (p.len() >= MIN_EVAL).then_some((t.id, p))
        })
        .collect();

    // Macro-avg prec@3 of a scorer config over a size band.
    let macro_p3 = |tag_text: &HashMap<i64, Vec<f32>>,
                    tag_pos: &HashMap<i64, Vec<i64>>,
                    params: ScoreParams,
                    lo: usize,
                    hi: usize|
     -> f32 {
        let sel: Vec<&(i64, Vec<i64>)> =
            measurable.iter().filter(|(_, p)| p.len() >= lo && p.len() <= hi).collect();
        if sel.is_empty() {
            return f32::NAN;
        }
        let mut acc = 0.0f32;
        for (tid, pos) in &sel {
            let mut hit = 0usize;
            for &qid in pos.iter() {
                if let Some(r) = run(qid, *tid, tag_text, tag_pos, params) {
                    if r < 3 {
                        hit += 1;
                    }
                }
            }
            acc += hit as f32 / pos.len() as f32;
        }
        acc / sel.len() as f32
    };

    let bands = [("all", MIN_EVAL, usize::MAX), ("4–9", 4, 9), ("10+", 10, usize::MAX)];

    println!("=== Lever 1: personalized scorer (k-NN branch only) ===");
    println!("{:<22}{:>9}{:>9}{:>9}", "config", "all", "4–9", "10+");
    for (label, tp) in [("TopK (current)", topk), ("MeanDiffProbe", probe)] {
        let vals: Vec<f32> = bands.iter().map(|(_, lo, hi)| macro_p3(&empty_text, &positives, tp, *lo, *hi)).collect();
        println!("{label:<22}{:>9.3}{:>9.3}{:>9.3}", vals[0], vals[1], vals[2]);
    }

    println!("\n=== Lever 2: zero-shot text anchor (zero-shot only, positives disabled) ===");
    println!("{:<22}{:>9}{:>9}{:>9}", "config", "all", "4–9", "10+");
    for (label, tt) in [("single (current)", &text_single), ("ensemble", &text_ens)] {
        let vals: Vec<f32> = bands.iter().map(|(_, lo, hi)| macro_p3(tt, &empty_pos, topk, *lo, *hi)).collect();
        println!("{label:<22}{:>9.3}{:>9.3}{:>9.3}", vals[0], vals[1], vals[2]);
    }

    println!("\n=== Combined switch policy (text + personalized together) ===");
    println!("{:<34}{:>9}{:>9}{:>9}", "config", "all", "4–9", "10+");
    let combos = [
        ("single + TopK (current ship)", &text_single, topk),
        ("ensemble + TopK", &text_ens, topk),
        ("single + Probe", &text_single, probe),
        ("ensemble + Probe", &text_ens, probe),
    ];
    for (label, tt, tp) in combos {
        let vals: Vec<f32> = bands.iter().map(|(_, lo, hi)| macro_p3(tt, &positives, tp, *lo, *hi)).collect();
        println!("{label:<34}{:>9.3}{:>9.3}{:>9.3}", vals[0], vals[1], vals[2]);
    }

    println!(
        "\nMeasurable tags: {} (n≥{}); bands are macro-avg prec@3 over tags in each example-count range.",
        measurable.len(),
        MIN_EVAL
    );
}
