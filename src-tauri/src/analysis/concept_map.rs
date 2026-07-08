//! Curated "concept map" for vocabulary expansion.
//!
//! Each [`Dimension`] is a common way people organize music (time of day,
//! season, energy…) with a canonical member list. `propose` matches the user's
//! own tag groups to a dimension — by group-name alias, else by member overlap —
//! and proposes that dimension's *missing* members as brand-new tag candidates.
//!
//! This is the on-device base implementation. A future LLM proposer can produce
//! the same `Vec<ProposedCandidate>` behind this interface, feeding only tag
//! names outward (never audio or files).

use std::collections::{HashMap, HashSet};

pub struct Member {
    pub name: &'static str,
    /// Optional zero-shot prompt override when the group template is weak.
    pub prompt: Option<&'static str>,
}

pub struct Dimension {
    /// Lowercase group-name aliases that map directly to this dimension.
    pub aliases: &'static [&'static str],
    pub members: &'static [Member],
}

pub struct ProposedCandidate {
    pub name: String,
    pub group_id: i64,
    pub description: Option<String>,
}

const MAX_PROPOSE_PER_GROUP: usize = 5;
const MIN_OVERLAP: usize = 2;

macro_rules! m {
    ($n:expr) => { Member { name: $n, prompt: None } };
    ($n:expr, $p:expr) => { Member { name: $n, prompt: Some($p) } };
}

pub static DIMENSIONS: &[Dimension] = &[
    Dimension {
        aliases: &["time of day", "times", "daypart", "dayparts", "time"],
        members: &[
            m!("Morning"),
            m!("Afternoon"),
            m!("Evening"),
            m!("Night"),
            m!("Late Night", "a late-night, after-hours music track"),
            m!("Dawn", "an early-morning, dawn music track"),
            m!("Dusk", "a dusk, twilight music track"),
        ],
    },
    Dimension {
        aliases: &["season", "seasons"],
        members: &[
            m!("Spring", "a fresh, spring-like music track"),
            m!("Summer", "a bright, summery music track"),
            m!("Autumn", "an autumnal, mellow music track"),
            m!("Winter", "a cold, wintry music track"),
        ],
    },
    Dimension {
        aliases: &["energy", "intensity", "drive"],
        members: &[
            m!("Chill", "a chilled-out, relaxed music track"),
            m!("Mellow", "a mellow, easygoing music track"),
            m!("Driving", "a driving, propulsive music track"),
            m!("Energetic", "a high-energy, energetic music track"),
            m!("Aggressive", "an aggressive, intense music track"),
            m!("Peaceful", "a peaceful, calm music track"),
        ],
    },
    Dimension {
        aliases: &["era", "decade", "decades", "period", "vintage"],
        members: &[
            m!("70s", "a 1970s-style music track"),
            m!("80s", "an 80s-style, retro synth music track"),
            m!("90s", "a 90s-style music track"),
            m!("2000s", "a 2000s-style music track"),
            m!("2010s", "a 2010s-style music track"),
        ],
    },
    Dimension {
        aliases: &["activity", "setting", "context", "occasion"],
        members: &[
            m!("Workout", "an energetic workout music track"),
            m!("Study", "a calm, focus-friendly study music track"),
            m!("Party", "an upbeat party music track"),
            m!("Focus", "a steady, focused music track"),
            m!("Sleep", "a soft, sleepy ambient music track"),
        ],
    },
    Dimension {
        aliases: &["instruments", "instrumentation"],
        members: &[
            m!("Piano"),
            m!("Guitar"),
            m!("Synth"),
            m!("Strings"),
            m!("Brass"),
            m!("Saxophone"),
            m!("Drums"),
            m!("Bass"),
        ],
    },
    Dimension {
        aliases: &["genre", "genres", "style", "styles"],
        members: &[
            m!("House"),
            m!("Techno"),
            m!("Trance"),
            m!("Drum & Bass"),
            m!("Ambient"),
            m!("Downtempo"),
            m!("Garage"),
            m!("Electro"),
        ],
    },
];

fn match_dimension(group_name: &str, group_tags: &[String]) -> Option<&'static Dimension> {
    let gl = group_name.to_lowercase();
    // 1) Direct alias match.
    for dim in DIMENSIONS {
        if dim.aliases.iter().any(|a| a.eq_ignore_ascii_case(&gl)) {
            return Some(dim);
        }
    }
    // 2) Fallback: the dimension whose members most overlap the group's tags.
    let tags_lower: HashSet<String> = group_tags.iter().map(|t| t.to_lowercase()).collect();
    let mut best: Option<(&'static Dimension, usize)> = None;
    for dim in DIMENSIONS {
        let overlap = dim
            .members
            .iter()
            .filter(|mem| tags_lower.contains(&mem.name.to_lowercase()))
            .count();
        if overlap >= MIN_OVERLAP && best.map(|(_, b)| overlap > b).unwrap_or(true) {
            best = Some((dim, overlap));
        }
    }
    best.map(|(d, _)| d)
}

/// Propose missing dimension members for each user group. `existing_names` must
/// be lowercased. Skips names already present anywhere in the vocabulary and caps
/// proposals per group.
pub fn propose(
    groups: &[(i64, String)],
    tags_by_group: &HashMap<i64, Vec<String>>,
    existing_names: &HashSet<String>,
) -> Vec<ProposedCandidate> {
    let mut out = Vec::new();
    let empty: Vec<String> = Vec::new();
    for (gid, gname) in groups {
        let group_tags = tags_by_group.get(gid).unwrap_or(&empty);
        let Some(dim) = match_dimension(gname, group_tags) else { continue };
        let mut added = 0usize;
        for mem in dim.members {
            if added >= MAX_PROPOSE_PER_GROUP {
                break;
            }
            if existing_names.contains(&mem.name.to_lowercase()) {
                continue;
            }
            out.push(ProposedCandidate {
                name: mem.name.to_string(),
                group_id: *gid,
                description: mem.prompt.map(|s| s.to_string()),
            });
            added += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_lowercase()).collect()
    }

    #[test]
    fn proposes_missing_members_by_alias() {
        let groups = vec![(7i64, "Time of Day".to_string())];
        let mut by_group = HashMap::new();
        by_group.insert(7i64, vec!["Morning".into(), "Evening".into(), "Prime Time".into()]);
        let existing = set(&["morning", "evening", "prime time", "dubstep"]);
        let out = propose(&groups, &by_group, &existing);
        let names: Vec<&str> = out.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"Afternoon"));
        assert!(names.contains(&"Night"));
        assert!(!names.contains(&"Morning")); // already present → skipped
        assert!(out.iter().all(|c| c.group_id == 7));
    }

    #[test]
    fn matches_by_member_overlap_when_group_name_differs() {
        let groups = vec![(3i64, "My Times".to_string())]; // not an alias
        let mut by_group = HashMap::new();
        by_group.insert(3i64, vec!["Morning".into(), "Night".into()]);
        let existing = set(&["morning", "night"]);
        let out = propose(&groups, &by_group, &existing);
        assert!(out.iter().any(|c| c.name == "Afternoon"));
    }

    #[test]
    fn unmatched_group_yields_nothing() {
        let groups = vec![(1i64, "People".to_string())];
        let by_group = HashMap::new();
        assert!(propose(&groups, &by_group, &set(&[])).is_empty());
    }

    #[test]
    fn respects_per_group_cap_and_carries_prompt_override() {
        let groups = vec![(9i64, "Energy".to_string())];
        let by_group = HashMap::new();
        let out = propose(&groups, &by_group, &set(&[]));
        assert!(out.len() <= 5);
        assert!(out.iter().any(|c| c.name == "Chill" && c.description.is_some()));
    }
}
