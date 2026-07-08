//! Tag scoring: personalized k-NN (your own tagged tracks) with a zero-shot
//! (CLAP text) fallback for tags you haven't used much yet.
//!
//! Raw CLAP cosines are not comparable across tags or between the text-anchor
//! and track-to-track spaces, so each signal is calibrated:
//!   - zero-shot: per-tag z-score of cos(track, tag_text) over the whole
//!     library (each text anchor has its own similarity scale).
//!   - k-NN: per-query z-score of the top-k mean similarity to a tag's positive
//!     examples, against the query's own cos-to-all-tracks distribution.
//!
//! We do NOT blend the two: an eval against a real library (see
//! `bin/eval_diagnose`) showed k-NN is far stronger once a tag has ~a dozen
//! examples, and mixing in the (near-random for subjective tags) zero-shot
//! signal only reorders the ranking downward. So each tag uses whichever
//! signal is trustworthy: k-NN when it has enough examples, else zero-shot.
//!
//! All embeddings are L2-normalized, so cosine == dot product.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

/// Tunable knobs for scoring. Defaults chosen by sweeping against a real
/// library (see `bin/eval_diagnose`).
#[derive(Debug, Clone, Copy)]
pub struct ScoreParams {
    /// Examples a tag needs before its personalized k-NN signal is trusted.
    /// At/above this the tag is scored by k-NN alone; below it, by zero-shot.
    pub knn_trust: usize,
    /// Neighbors averaged for the k-NN raw score.
    pub knn_top_k: usize,
}

impl Default for ScoreParams {
    fn default() -> Self {
        // Tuned via bin/eval_diagnose on a real 332-track library: the switch
        // policy plateaus for knn_trust in ~4–8 at top_k=5; 8 sits at the
        // robust end of that plateau (needs a real handful of examples before
        // trusting personalization) without overfitting to the exact peak.
        Self { knn_trust: 8, knn_top_k: 5 }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Suggestion {
    pub tag_id: i64,
    pub name: String,
    pub group_id: Option<i64>,
    pub score: f32,
    /// "zero_shot" | "knn" | "hybrid"
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct TagInfo {
    pub id: i64,
    pub name: String,
    pub group_id: Option<i64>,
}

pub struct ScoreInput<'a> {
    /// The track we're suggesting tags for (L2-normalized).
    pub query: &'a [f32],
    pub query_track_id: i64,
    /// Every embedded track (id, vector), may include the query.
    pub all_tracks: &'a [(i64, Vec<f32>)],
    /// tag_id → text-anchor embedding (absent for zero-shot-excluded tags).
    pub tag_text: &'a HashMap<i64, Vec<f32>>,
    /// tag_id → track ids carrying that tag.
    pub tag_positives: &'a HashMap<i64, Vec<i64>>,
    pub tags: &'a [TagInfo],
    /// Tag ids already applied to the query (excluded from output).
    pub applied: &'a HashSet<i64>,
    pub threshold: f32,
    pub max_total: usize,
    pub max_per_group: usize,
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn sigmoid(z: f32) -> f32 {
    1.0 / (1.0 + (-z).exp())
}

/// Mean and standard deviation (population) of a slice; std floored to avoid /0.
fn mean_std(xs: &[f32]) -> (f32, f32) {
    if xs.is_empty() {
        return (0.0, 1.0);
    }
    let n = xs.len() as f32;
    let mean = xs.iter().sum::<f32>() / n;
    let var = xs.iter().map(|x| (x - mean) * (x - mean)).sum::<f32>() / n;
    (mean, var.sqrt().max(1e-6))
}

/// Compute ranked suggestions for one track with default parameters.
pub fn score_suggestions(input: &ScoreInput) -> Vec<Suggestion> {
    score_suggestions_with(input, ScoreParams::default())
}

/// Compute ranked suggestions for one track. Pure function over the inputs.
pub fn score_suggestions_with(input: &ScoreInput, params: ScoreParams) -> Vec<Suggestion> {
    let index: HashMap<i64, &Vec<f32>> =
        input.all_tracks.iter().map(|(id, v)| (*id, v)).collect();

    // Query's similarity to every other track — the k-NN calibration baseline.
    let bg: Vec<f32> = input
        .all_tracks
        .iter()
        .filter(|(id, _)| *id != input.query_track_id)
        .map(|(_, v)| dot(input.query, v))
        .collect();
    let (bg_mean, bg_std) = mean_std(&bg);

    let mut out: Vec<Suggestion> = Vec::new();

    for tag in input.tags {
        if input.applied.contains(&tag.id) {
            continue;
        }

        // --- zero-shot ---
        let (zero, has_zero) = match input.tag_text.get(&tag.id) {
            Some(text_vec) => {
                let sims: Vec<f32> = input
                    .all_tracks
                    .iter()
                    .map(|(_, v)| dot(text_vec, v))
                    .collect();
                let (mu, sigma) = mean_std(&sims);
                let z = (dot(input.query, text_vec) - mu) / sigma;
                (sigmoid(z), true)
            }
            None => (0.0, false),
        };

        // --- personalized k-NN ---
        let positives: Vec<&Vec<f32>> = input
            .tag_positives
            .get(&tag.id)
            .map(|ids| {
                ids.iter()
                    .filter(|id| **id != input.query_track_id)
                    .filter_map(|id| index.get(id).copied())
                    .collect()
            })
            .unwrap_or_default();
        let n = positives.len();

        let (knn, has_knn) = if n >= params.knn_trust {
            let mut sims: Vec<f32> = positives.iter().map(|p| dot(input.query, p)).collect();
            sims.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
            let k = params.knn_top_k.min(sims.len());
            let raw = sims[..k].iter().sum::<f32>() / k as f32;
            let z = (raw - bg_mean) / bg_std;
            (sigmoid(z), true)
        } else {
            (0.0, false)
        };

        if !has_zero && !has_knn {
            continue;
        }

        // Trust k-NN once a tag has enough examples; otherwise fall back to
        // zero-shot. No blending — see the module doc for why.
        let (score, source) = if has_knn {
            (knn, "knn")
        } else {
            (zero, "zero_shot")
        };

        if score >= input.threshold {
            out.push(Suggestion {
                tag_id: tag.id,
                name: tag.name.clone(),
                group_id: tag.group_id,
                score,
                source: source.to_string(),
            });
        }
    }

    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // Cap per group, then overall.
    let mut per_group: HashMap<Option<i64>, usize> = HashMap::new();
    let mut capped: Vec<Suggestion> = Vec::new();
    for s in out {
        let c = per_group.entry(s.group_id).or_insert(0);
        if *c >= input.max_per_group {
            continue;
        }
        *c += 1;
        capped.push(s);
        if capped.len() >= input.max_total {
            break;
        }
    }
    capped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(mut v: Vec<f32>) -> Vec<f32> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        for x in &mut v {
            *x /= n;
        }
        v
    }

    #[test]
    fn knn_prefers_tag_with_similar_examples() {
        // Query is near cluster A. Tag A has A-like positives; tag B has B-like.
        let a = norm(vec![1.0, 0.0, 0.0]);
        let a2 = norm(vec![0.9, 0.1, 0.0]);
        let a3 = norm(vec![0.95, 0.05, 0.0]);
        let a4 = norm(vec![0.92, 0.08, 0.0]);
        let b = norm(vec![0.0, 1.0, 0.0]);
        let b2 = norm(vec![0.1, 0.9, 0.0]);
        let b3 = norm(vec![0.05, 0.95, 0.0]);
        let b4 = norm(vec![0.08, 0.92, 0.0]);

        let all = vec![
            (1i64, a.clone()),
            (2, a2),
            (3, a3),
            (4, a4),
            (5, b),
            (6, b2),
            (7, b3),
            (8, b4),
        ];
        let tags = vec![
            TagInfo { id: 100, name: "A".into(), group_id: Some(1) },
            TagInfo { id: 200, name: "B".into(), group_id: Some(1) },
        ];
        let mut positives = HashMap::new();
        positives.insert(100i64, vec![2i64, 3, 4]);
        positives.insert(200i64, vec![5i64, 6, 7, 8]);
        let text = HashMap::new();
        let applied = HashSet::new();

        let input = ScoreInput {
            query: &a,
            query_track_id: 1,
            all_tracks: &all,
            tag_text: &text,
            tag_positives: &positives,
            tags: &tags,
            applied: &applied,
            threshold: 0.0,
            max_total: 8,
            max_per_group: 8,
        };
        // Small fixture: lower the trust threshold so k-NN fires on 3-4 examples.
        let params = ScoreParams { knn_trust: 3, knn_top_k: 5 };
        let sugg = score_suggestions_with(&input, params);
        assert_eq!(sugg[0].tag_id, 100, "closest tag should rank first");
        assert!(sugg[0].score > sugg.iter().find(|s| s.tag_id == 200).unwrap().score);
    }

    #[test]
    fn applied_tags_excluded_and_caps_enforced() {
        let q = norm(vec![1.0, 0.0]);
        let all = vec![(1i64, q.clone()), (2, norm(vec![0.9, 0.1]))];
        let tags = vec![
            TagInfo { id: 1, name: "x".into(), group_id: Some(1) },
            TagInfo { id: 2, name: "y".into(), group_id: Some(1) },
        ];
        let positives = HashMap::new();
        let mut text = HashMap::new();
        text.insert(1i64, norm(vec![1.0, 0.0]));
        text.insert(2i64, norm(vec![0.8, 0.2]));
        let mut applied = HashSet::new();
        applied.insert(1i64);

        let input = ScoreInput {
            query: &q,
            query_track_id: 1,
            all_tracks: &all,
            tag_text: &text,
            tag_positives: &positives,
            tags: &tags,
            applied: &applied,
            threshold: 0.0,
            max_total: 8,
            max_per_group: 1,
        };
        let sugg = score_suggestions(&input);
        assert!(sugg.iter().all(|s| s.tag_id != 1), "applied tag excluded");
        assert!(sugg.len() <= 1, "per-group cap enforced");
    }
}
