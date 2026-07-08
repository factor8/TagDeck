//! Diagnostic harness: full-vocabulary leave-one-out eval that DECOMPOSES the
//! score into its zero-shot and k-NN halves, so we can see *where* suggestion
//! quality comes from (and where it's failing).
//!
//! For every tag with enough examples we report prec@3 / recall@8 under three
//! scorers on the identical held-out query:
//!   - blended  : the shipping hybrid (score_suggestions as-is)
//!   - zeroshot : k-NN disabled (empty positives) — pure CLAP text↔audio
//!   - knn      : zero-shot disabled (empty text) — pure personalized similarity
//!
//! Usage:
//!   CLAP_MODEL_DIR=<onnx_dir> cargo run --release --bin eval_diagnose -- <db_path> [max_tracks]
//!
//! Embeddings are cached in <db_path> keyed by model_version, so re-runs skip
//! already-embedded tracks. For a q8-vs-fp32 A/B, point at a DIFFERENT onnx dir
//! and a FRESH db copy (with the embedding tables cleared).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tagdeck_lib::analysis::audio::decode_to_mono_48k;
use tagdeck_lib::analysis::clap::{AudioEmbedder, TextEmbedder};
use tagdeck_lib::analysis::model_manager::MODEL_VERSION;
use tagdeck_lib::analysis::prompts::derive_prompt;
use tagdeck_lib::analysis::scoring::{score_suggestions_with, ScoreInput, ScoreParams, TagInfo};
use tagdeck_lib::db::Database;
use tagdeck_lib::models::parse_comment_tags;

/// Minimum positive examples for a tag to be measurable via leave-one-out.
const MIN_EVAL: usize = 4;

struct Row {
    name: String,
    group: String,
    n: usize,
    baseline: f32,
    blended_p3: f32,
    zeroshot_p3: f32,
    knn_p3: f32,
    blended_r8: f32,
    has_prompt: bool,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let db_path = args.get(1).expect("usage: eval_diagnose <db_path> [max_tracks]");
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

    // 1. Candidates: every local, present, tagged track — no stratification.
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

    // 2. Tag prompts (skip existing).
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

    // 3. Embed tracks (skip already-embedded).
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

    // 4. Build eval structures over embedded tracks.
    let all_emb = db.all_track_embeddings(MODEL_VERSION).unwrap();
    let emb_ids: HashSet<i64> = all_emb.iter().map(|(id, _)| *id).collect();
    let emb_index: HashMap<i64, &Vec<f32>> = all_emb.iter().map(|(id, v)| (*id, v)).collect();
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

    // 5. Per-tag leave-one-out under the three scorers.
    let total = all_emb.len();
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
    let def = ScoreParams::default();

    let mut rows: Vec<Row> = Vec::new();
    let mut vocab_measurable = 0usize;
    let mut vocab_too_few = 0usize;
    for tag in &tags {
        let tid = tag.id;
        let gname = tag
            .group_id
            .and_then(|g| group_names.get(&g))
            .cloned()
            .unwrap_or_else(|| "-".into());
        let pos: Vec<i64> = positives.get(&tid).cloned().unwrap_or_default();
        if pos.len() < MIN_EVAL {
            if !pos.is_empty() {
                vocab_too_few += 1;
            }
            continue;
        }
        vocab_measurable += 1;
        let n = pos.len();
        let baseline = n as f32 / total as f32;
        let (mut b3, mut z3, mut k3, mut b8) = (0usize, 0usize, 0usize, 0usize);
        for &qid in &pos {
            if let Some(r) = run(qid, tid, &text, &positives, def) {
                if r < 3 { b3 += 1; }
                if r < 8 { b8 += 1; }
            }
            if let Some(r) = run(qid, tid, &text, &empty_pos, def) {
                if r < 3 { z3 += 1; }
            }
            if let Some(r) = run(qid, tid, &empty_text, &positives, def) {
                if r < 3 { k3 += 1; }
            }
        }
        let nf = n as f32;
        rows.push(Row {
            name: tag.name.clone(),
            group: gname,
            n,
            baseline,
            blended_p3: b3 as f32 / nf,
            zeroshot_p3: z3 as f32 / nf,
            knn_p3: k3 as f32 / nf,
            blended_r8: b8 as f32 / nf,
            has_prompt: text.contains_key(&tid),
        });
    }

    rows.sort_by(|a, b| b.n.cmp(&a.n));

    println!("=== Full-vocab leave-one-out (embedded tracks = {total}) ===");
    println!(
        "{:<18}{:<14}{:>4}{:>9}{:>9}{:>9}{:>9}{:>9}",
        "tag", "group", "n", "base", "blend@3", "zsh@3", "knn@3", "blend@8"
    );
    for r in &rows {
        let zsh = if r.has_prompt { format!("{:.2}", r.zeroshot_p3) } else { "  -".into() };
        println!(
            "{:<18}{:<14}{:>4}{:>9.3}{:>9.2}{:>9}{:>9.2}{:>9.2}",
            trunc(&r.name, 17),
            trunc(&r.group, 13),
            r.n,
            r.baseline,
            r.blended_p3,
            zsh,
            r.knn_p3,
            r.blended_r8
        );
    }

    // 6. Summaries.
    let bucket = |lo: usize, hi: usize| -> Option<(f32, f32, f32, usize)> {
        let sel: Vec<&Row> = rows.iter().filter(|r| r.n >= lo && r.n <= hi).collect();
        if sel.is_empty() {
            return None;
        }
        let c = sel.len() as f32;
        let b = sel.iter().map(|r| r.blended_p3).sum::<f32>() / c;
        let z = sel.iter().filter(|r| r.has_prompt).map(|r| r.zeroshot_p3).sum::<f32>()
            / sel.iter().filter(|r| r.has_prompt).count().max(1) as f32;
        let k = sel.iter().map(|r| r.knn_p3).sum::<f32>() / c;
        Some((b, z, k, sel.len()))
    };
    println!("\n=== Macro-avg prec@3 by example count ===");
    println!("{:<12}{:>7}{:>9}{:>9}{:>9}", "bucket", "tags", "blend", "zeroshot", "knn");
    for (label, lo, hi) in [("4–9", 4, 9), ("10–29", 10, 29), ("30+", 30, usize::MAX)] {
        if let Some((b, z, k, cnt)) = bucket(lo, hi) {
            println!("{label:<12}{cnt:>7}{b:>9.2}{z:>9.2}{k:>9.2}");
        }
    }
    if let Some((b, z, k, cnt)) = bucket(MIN_EVAL, usize::MAX) {
        println!("{:<12}{cnt:>7}{b:>9.2}{z:>9.2}{k:>9.2}", "ALL");
    }
    println!(
        "\nVocabulary: {} tags total · {} measurable (n≥{}) · {} tagged-but-too-few (1–{}) → these rely on zero-shot and can't be LOO-measured",
        tags.len(),
        vocab_measurable,
        MIN_EVAL,
        vocab_too_few,
        MIN_EVAL - 1
    );

    // 7. Blend-parameter sweep: which (knn_min, shrinkage) maximizes blended
    //    prec@3? Reuses the cached embeddings, so this is pure CPU. Reports the
    //    macro-avg over all measurable tags plus the low-count band, since the
    //    long tail is where the blend matters most.
    let measurable: Vec<(i64, Vec<i64>)> = tags
        .iter()
        .filter_map(|t| {
            let p = positives.get(&t.id).cloned().unwrap_or_default();
            (p.len() >= MIN_EVAL).then_some((t.id, p))
        })
        .collect();
    let macro_blend = |params: ScoreParams, lo: usize, hi: usize| -> f32 {
        let sel: Vec<&(i64, Vec<i64>)> =
            measurable.iter().filter(|(_, p)| p.len() >= lo && p.len() <= hi).collect();
        if sel.is_empty() {
            return f32::NAN;
        }
        let mut acc = 0.0f32;
        for (tid, pos) in &sel {
            let mut hit = 0usize;
            for &qid in pos.iter() {
                if let Some(r) = run(qid, *tid, &text, &positives, params) {
                    if r < 3 {
                        hit += 1;
                    }
                }
            }
            acc += hit as f32 / pos.len() as f32;
        }
        acc / sel.len() as f32
    };

    println!("\n=== k-NN trust-threshold sweep (switch policy, macro-avg prec@3) ===");
    println!("{:<10}{:<9}{:>9}{:>9}{:>9}", "knn_trust", "top_k", "all", "4–9", "10+");
    let mut best = (f32::MIN, ScoreParams::default());
    for &top_k in &[5usize, 10] {
        for &knn_trust in &[4usize, 6, 8, 10, 12, 15, 20] {
            let p = ScoreParams { knn_trust, knn_top_k: top_k, ..ScoreParams::default() };
            let all = macro_blend(p, MIN_EVAL, usize::MAX);
            let low = macro_blend(p, 4, 9);
            let high = macro_blend(p, 10, usize::MAX);
            if all > best.0 {
                best = (all, p);
            }
            println!("{knn_trust:<10}{top_k:<9}{all:>9.3}{low:>9.3}{high:>9.3}");
        }
    }
    println!(
        "\nBest: knn_trust={} top_k={} → macro prec@3 = {:.3} (current default is knn_trust=12 top_k=10)",
        best.1.knn_trust, best.1.knn_top_k, best.0
    );
}

fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    }
}
