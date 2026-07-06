//! Pure fuzzy-matching between Spotify ghosts and local files.
//! No IO here — everything is unit-testable.

pub const AUTO_MERGE_THRESHOLD: f64 = 0.90;
pub const REVIEW_THRESHOLD: f64 = 0.60;
const DURATION_TOLERANCE_SECS: f64 = 3.0;

/// Lowercase, strip punctuation, drop "feat./ft./featuring …" credits and
/// remaster/version suffixes. Keeps mix names ("extended mix") — those
/// distinguish genuinely different recordings.
pub fn normalize(s: &str) -> String {
    let lower = s.to_lowercase();

    // Cut "feat."/"ft."/"featuring" and everything after.
    let lower = ["feat.", "feat ", "ft.", "ft ", "featuring"]
        .iter()
        .fold(lower, |acc, marker| match acc.find(marker) {
            Some(idx) => acc[..idx].to_string(),
            None => acc,
        });

    // Remove parenthesized/bracketed chunks that are remaster/version noise.
    let mut out = String::with_capacity(lower.len());
    let mut depth = 0usize;
    let mut chunk = String::new();
    for c in lower.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                chunk.clear();
            }
            ')' | ']' => {
                if depth > 0 {
                    depth -= 1;
                    if !is_version_noise(&chunk) {
                        out.push(' ');
                        out.push_str(&chunk);
                    }
                    chunk.clear();
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

    // Remove "- 2014 remastered version"-style dash suffixes.
    let out = match out.find(" - ") {
        Some(idx) if is_version_noise(&out[idx + 3..]) => out[..idx].to_string(),
        _ => out,
    };

    // Strip punctuation, collapse whitespace.
    out.chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_version_noise(s: &str) -> bool {
    let s = s.trim();
    ["remaster", "remastered", "re-master", "deluxe", "bonus", "single version", "album version", "radio edit"]
        .iter()
        .any(|k| s.contains(k))
        || s.chars().filter(|c| c.is_ascii_digit()).count() == 4 && s.len() <= 24 // "2011 remaster"-ish
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
    if dur_delta > DURATION_TOLERANCE_SECS {
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
}
