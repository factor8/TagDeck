//! Pure fuzzy-matching between Spotify ghosts and local files.
//! No IO here — everything is unit-testable.

pub const AUTO_MERGE_THRESHOLD: f64 = 0.90;
pub const REVIEW_THRESHOLD: f64 = 0.60;
const DURATION_TOLERANCE_SECS: f64 = 3.0;

/// Lowercase, strip punctuation, drop "feat./ft./featuring …" credits
/// (inline or bracketed, e.g. "(feat. X)") and remaster/version suffixes.
/// Keeps mix names ("extended mix") — those distinguish genuinely different
/// recordings.
pub fn normalize(s: &str) -> String {
    let lower = s.to_lowercase();

    // Cut "feat"/"ft"/"featuring" at a word boundary and drop everything
    // after — but only when the *whole token* (modulo a trailing '.') is the
    // marker, so words that merely contain "ft"/"feat" as a substring
    // ("Left Alone", "Daft Punk", "Defeat of Napoleon") survive intact.
    // Bracketed credits like "(feat. X)" glue the '(' onto the token, so
    // they don't match here — the bracket pass below handles those.
    let lower = {
        let mut tokens: Vec<&str> = Vec::new();
        for token in lower.split_whitespace() {
            if is_feat_marker(token) {
                break;
            }
            tokens.push(token);
        }
        tokens.join(" ")
    };

    // Remove parenthesized/bracketed chunks that are remaster/version noise
    // or featuring credits ("(feat. X)"). Nested brackets accumulate into
    // the same outermost chunk (a space is pushed in place of the inner
    // delimiter) so an inner bracket can't wipe out outer-chunk text already
    // collected; the whole outermost chunk is judged only once it fully
    // closes.
    let mut out = String::with_capacity(lower.len());
    let mut depth = 0usize;
    let mut chunk = String::new();
    for c in lower.chars() {
        match c {
            '(' | '[' => {
                if depth == 0 {
                    chunk.clear();
                } else {
                    chunk.push(' ');
                }
                depth += 1;
            }
            ')' | ']' => {
                if depth > 0 {
                    depth -= 1;
                    if depth == 0 {
                        if !is_droppable_bracket_chunk(&chunk) {
                            out.push(' ');
                            out.push_str(&chunk);
                        }
                        chunk.clear();
                    } else {
                        chunk.push(' ');
                    }
                }
            }
            _ => {
                if depth > 0 {
                    chunk.push(c);
                } else {
                    out.push(c);
                }
            }
        }
    }
    // An unterminated bracket left the tail sitting in `chunk` — it was
    // dropped on the floor before; now it gets the same droppable check and
    // is flushed back in when it's meaningful ("Song (feat. Someone" still
    // loses the credit, "Prelude (Part 1" keeps its tail).
    if depth > 0 && !is_droppable_bracket_chunk(&chunk) {
        out.push(' ');
        out.push_str(&chunk);
    }

    // Remove "- 2014 remastered version"-style dash suffixes. Split on every
    // " - " so each segment is judged independently — a noise keyword in one
    // segment ("Remastered") no longer eats distinguishing content in an
    // earlier segment ("Part 1" vs "Part 2"). Segment 0 is the title itself
    // and is kept unconditionally: "Bonus Track - Live" must not lose its
    // head, and two noise-titled tracks must never both collapse to "" (a
    // both-empty pair scores similarity 1.0).
    let out = out
        .split(" - ")
        .enumerate()
        .filter(|&(i, segment)| i == 0 || !is_version_noise(segment))
        .map(|(_, segment)| segment)
        .collect::<Vec<_>>()
        .join(" - ");

    // Strip punctuation, collapse whitespace.
    out.chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// True when a whole token (modulo one trailing '.') is a featuring marker.
fn is_feat_marker(token: &str) -> bool {
    let t = token.trim_end_matches('.');
    t == "feat" || t == "ft" || t == "featuring"
}

fn is_version_noise(s: &str) -> bool {
    let s = s.trim();
    // A bare 4-digit year is NOT noise on its own (different live dates/mixes
    // must stay distinguishable) — only a real noise keyword marks a segment
    // as removable, year or no year.
    ["remaster", "remastered", "re-master", "deluxe", "bonus", "single version", "album version", "radio edit"]
        .iter()
        .any(|k| s.contains(k))
}

/// A bracketed chunk is dropped when it's version noise OR a featuring
/// credit — i.e. its first token is "feat"/"ft"/"featuring" (Spotify's
/// canonical "(feat. X)" format). First-token-only keeps meaningful chunks
/// like "[extended mix]" or "(live 1999)" intact.
fn is_droppable_bracket_chunk(chunk: &str) -> bool {
    is_version_noise(chunk)
        || chunk
            .split_whitespace()
            .next()
            .is_some_and(is_feat_marker)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() { return b.len(); }
    if b.is_empty() { return a.len(); }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

/// 0..1 string similarity on normalized inputs: max of edit-distance ratio
/// and token-overlap (Jaccard), so word reordering isn't punished.
pub fn similarity(a: &str, b: &str) -> f64 {
    let a = normalize(a);
    let b = normalize(b);
    if a.is_empty() && b.is_empty() { return 1.0; }
    if a.is_empty() || b.is_empty() { return 0.0; }
    let max_len = a.chars().count().max(b.chars().count()) as f64;
    let edit = 1.0 - levenshtein(&a, &b) as f64 / max_len;
    let ta: std::collections::HashSet<&str> = a.split(' ').collect();
    let tb: std::collections::HashSet<&str> = b.split(' ').collect();
    let jaccard = ta.intersection(&tb).count() as f64 / ta.union(&tb).count() as f64;
    edit.max(jaccard)
}

/// Combined confidence that a local file is the same recording as a ghost.
/// Duration outside the tolerance window is a hard zero.
pub fn match_score(
    ghost_artist: &str,
    ghost_title: &str,
    ghost_duration_secs: f64,
    local_artist: &str,
    local_title: &str,
    local_duration_secs: f64,
) -> f64 {
    let dur_delta = (ghost_duration_secs - local_duration_secs).abs();
    if dur_delta.is_nan() || dur_delta > DURATION_TOLERANCE_SECS {
        return 0.0;
    }
    let duration_score = 1.0 - (dur_delta / DURATION_TOLERANCE_SECS);
    0.5 * similarity(ghost_title, local_title)
        + 0.35 * similarity(ghost_artist, local_artist)
        + 0.15 * duration_score
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_noise() {
        assert_eq!(normalize("Song Title (2011 Remaster)"), "song title");
        assert_eq!(normalize("Track [Extended Mix]"), "track extended mix"); // mix names are meaningful
        assert_eq!(normalize("Artist feat. Someone"), "artist");
        assert_eq!(normalize("Artist ft. Someone"), "artist");
        assert_eq!(normalize("Hello,  World!"), "hello world");
        assert_eq!(normalize("Song - 2014 Remastered Version"), "song");
    }

    #[test]
    fn identical_tracks_score_high() {
        let s = match_score("Daft Punk", "One More Time", 320.0, "Daft Punk", "One More Time", 321.5);
        assert!(s >= AUTO_MERGE_THRESHOLD, "score was {}", s);
    }

    #[test]
    fn remaster_suffix_still_matches() {
        let s = match_score("Daft Punk", "One More Time", 320.0,
                            "Daft Punk", "One More Time (2011 Remaster)", 320.8);
        assert!(s >= AUTO_MERGE_THRESHOLD, "score was {}", s);
    }

    #[test]
    fn duration_gate_kills_mismatch() {
        let s = match_score("Daft Punk", "One More Time", 320.0, "Daft Punk", "One More Time", 200.0);
        assert_eq!(s, 0.0);
    }

    #[test]
    fn different_song_scores_low() {
        let s = match_score("Daft Punk", "One More Time", 320.0, "Daft Punk", "Around the World", 321.0);
        assert!(s < REVIEW_THRESHOLD, "score was {}", s);
    }

    #[test]
    fn similar_but_uncertain_lands_in_review_band() {
        // Same title, different-but-overlapping artist credit → mid confidence
        let s = match_score("Calvin Harris, Dua Lipa", "One Kiss", 214.0, "Calvin Harris", "One Kiss", 214.5);
        assert!(s >= REVIEW_THRESHOLD && s < 1.0, "score was {}", s);
    }

    // --- Regression tests for review findings (false-positive collision risks
    // ahead of Task 13's auto-merge-at->=0.90 write path). ---

    #[test]
    fn feat_cut_requires_word_boundary() {
        // Critical 1: substring search for "ft "/"feat " truncated on any word
        // containing that substring, not just the featured-artist marker.
        assert_eq!(normalize("Left Alone"), "left alone");
        assert_eq!(normalize("Daft Punk"), "daft punk");
        assert_eq!(normalize("Defeat of Napoleon"), "defeat of napoleon");
        // Still cuts the real marker at a word boundary.
        assert_eq!(normalize("Artist feat. Someone"), "artist");
        assert_eq!(normalize("Artist ft. Someone"), "artist");
    }

    #[test]
    fn live_year_not_treated_as_noise() {
        // Critical 2: a bare 4-digit run was noise regardless of context, so
        // different live recordings (and dated mixes) collapsed together.
        assert_ne!(normalize("Song (Live 1999)"), normalize("Song (Live 2005)"));
        assert_eq!(normalize("Song (Live 1999)"), "song live 1999");
        assert_eq!(normalize("Song (1999 Mix)"), "song 1999 mix");
        // Keyword-bearing years are still eaten.
        assert_eq!(normalize("Song Title (2011 Remaster)"), "song title");
    }

    #[test]
    fn dash_segments_filtered_independently() {
        // Critical 3: is_version_noise ran on the whole dash-tail as one
        // blob, so any noise keyword anywhere in it ate distinguishing
        // content earlier in the tail (e.g. "Part 1" vs "Part 2").
        assert_eq!(normalize("A Tale - Part 1 - Remastered"), "a tale part 1");
        assert_eq!(normalize("A Tale - Part 2 - Remastered"), "a tale part 2");
        assert_ne!(
            normalize("A Tale - Part 1 - Remastered"),
            normalize("A Tale - Part 2 - Remastered")
        );
        // Still eats a genuine dash-suffix.
        assert_eq!(normalize("Song - 2014 Remastered Version"), "song");
    }

    #[test]
    fn unclosed_bracket_flushes_pending_chunk() {
        // Critical 4: an unterminated '(' left `chunk` accumulating forever
        // and it was dropped on the floor instead of being flushed.
        assert_eq!(normalize("Prelude (Part 1"), "prelude part 1");
        assert_eq!(normalize("Song (2011 Remaster"), "song");
    }

    #[test]
    fn nested_bracket_preserves_outer_word() {
        // Important 6: '(' | '[' unconditionally cleared `chunk`, so an
        // inner bracket destroyed already-accumulated outer-chunk text.
        assert_eq!(
            normalize("Song (Live (Acoustic) Version)"),
            "song live acoustic version"
        );
    }

    // --- Regression tests for Fix-1 fallout (re-review findings A and B). ---

    #[test]
    fn bracketed_feat_credit_stripped() {
        // Finding A: the word-boundary feat-cut tokenizes on whitespace, so
        // the token "(feat." trims to "(feat" != "feat" and never matches;
        // Spotify's canonical bracketed credit then survived normalization,
        // tanking scores against local rips without the credit.
        assert_eq!(normalize("Song (feat. Someone)"), "song");
        assert_eq!(normalize("Song [ft. X]"), "song");
        assert_eq!(normalize("Song (feat. Someone"), "song"); // unclosed
        // Blast-radius pin: canonical Spotify title vs uncredited local rip
        // must stay auto-mergeable.
        let s = match_score(
            "B.o.B", "Airplanes (feat. Hayley Williams)", 240.0,
            "B.o.B", "Airplanes", 240.5,
        );
        assert!(s >= AUTO_MERGE_THRESHOLD, "score was {}", s);
    }

    #[test]
    fn dash_filter_never_drops_head_segment() {
        // Finding B: the per-segment dash filter dropped ANY noise segment,
        // including segment 0 — erasing the title itself ("Bonus Track -
        // Live" -> "live") and opening a new both-empty => similarity 1.0
        // false-positive path ("The Deluxe Life - Radio Edit" -> "").
        assert_eq!(normalize("Bonus Track - Live"), "bonus track live");
        assert_eq!(normalize("The Deluxe Life - Radio Edit"), "the deluxe life");
    }

    #[test]
    fn duration_nan_is_hard_zero() {
        // Important 5: NaN > DURATION_TOLERANCE_SECS is false, so a NaN
        // duration delta slipped past the hard gate and propagated NaN
        // through the final weighted score instead of returning 0.0.
        let s = match_score(
            "Daft Punk", "One More Time", f64::NAN,
            "Daft Punk", "One More Time", 320.0,
        );
        assert_eq!(s, 0.0);
    }
}
