//! Tag → text-prompt derivation for zero-shot CLAP scoring.
//!
//! A tag's prompt is what gets embedded by the text tower and compared against
//! track audio embeddings. Users can override any tag's prompt via
//! `tags.description`; otherwise we template by group so the phrasing matches
//! how CLAP was trained ("a {genre} music track", "a {mood} mood", …).

/// Groups that are not audio properties and so are excluded from zero-shot
/// scoring entirely (they can still surface via personalized k-NN).
pub const NON_AUDIO_GROUPS: [&str; 1] = ["People"];

/// Derive the zero-shot prompt for a tag. Returns `None` when the tag should be
/// excluded from zero-shot (non-audio group and no explicit description).
pub fn derive_prompt(
    tag_name: &str,
    group_name: Option<&str>,
    description: Option<&str>,
) -> Option<String> {
    if let Some(desc) = description {
        let desc = desc.trim();
        if !desc.is_empty() {
            return Some(desc.to_string());
        }
    }

    if let Some(group) = group_name {
        if NON_AUDIO_GROUPS.iter().any(|g| g.eq_ignore_ascii_case(group)) {
            return None;
        }
    }

    let name = tag_name.trim().to_lowercase();
    if name.is_empty() {
        return None;
    }
    let prompt = match group_name.map(|g| g.to_lowercase()).as_deref() {
        Some("genre") => format!("a {name} electronic music track"),
        Some("vibe") => format!("a piece of music with a {name} mood"),
        Some("instruments") => format!("a music recording featuring {name}"),
        Some("time of day") => format!("music that fits {name}"),
        Some("beat") => format!("a music track with a {name} rhythm"),
        _ => format!("a {name} music track"),
    };
    Some(prompt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn description_overrides_template() {
        let p = derive_prompt("Wrecker", Some("Vibe"), Some("an aggressive heavy bass drop"));
        assert_eq!(p.as_deref(), Some("an aggressive heavy bass drop"));
    }

    #[test]
    fn people_group_excluded() {
        assert_eq!(derive_prompt("Ty Doza", Some("People"), None), None);
        // …unless the user gives an explicit prompt.
        assert!(derive_prompt("Ty Doza", Some("People"), Some("a rap vocal")).is_some());
    }

    #[test]
    fn group_templates() {
        assert_eq!(
            derive_prompt("Dubstep", Some("Genre"), None).as_deref(),
            Some("a dubstep electronic music track")
        );
        assert_eq!(
            derive_prompt("Sinister", Some("Vibe"), None).as_deref(),
            Some("a piece of music with a sinister mood")
        );
        assert_eq!(
            derive_prompt("Piano", Some("Instruments"), None).as_deref(),
            Some("a music recording featuring piano")
        );
    }
}
