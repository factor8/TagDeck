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

/// Derive an ENSEMBLE of prompt wordings for a tag. Averaging the text-tower
/// embeddings of several phrasings gives a steadier zero-shot anchor than any
/// single sentence — it smooths over CLAP's sensitivity to exact wording, which
/// matters most for the rarely-used tags that never accumulate k-NN examples.
///
/// An explicit user `description` is respected verbatim (single-element), since
/// the user chose those exact words. Returns `None` for the same cases as
/// `derive_prompt` (non-audio group with no description, or an empty name).
pub fn derive_prompt_ensemble(
    tag_name: &str,
    group_name: Option<&str>,
    description: Option<&str>,
) -> Option<Vec<String>> {
    if let Some(desc) = description {
        let desc = desc.trim();
        if !desc.is_empty() {
            return Some(vec![desc.to_string()]);
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
    let prompts: Vec<String> = match group_name.map(|g| g.to_lowercase()).as_deref() {
        Some("genre") => vec![
            format!("a {name} electronic music track"),
            format!("{name} music"),
            format!("a song in the {name} genre"),
            format!("this track sounds like {name}"),
        ],
        Some("vibe") => vec![
            format!("a piece of music with a {name} mood"),
            format!("a {name} sounding song"),
            format!("{name} music"),
            format!("this track feels {name}"),
        ],
        Some("instruments") => vec![
            format!("a music recording featuring {name}"),
            format!("a song with {name} in it"),
            format!("the sound of {name} in a track"),
        ],
        Some("time of day") => vec![
            format!("music that fits {name}"),
            format!("a song for {name}"),
            format!("{name} music"),
        ],
        Some("beat") => vec![
            format!("a music track with a {name} rhythm"),
            format!("a {name} beat"),
            format!("{name} rhythm music"),
        ],
        _ => vec![format!("a {name} music track"), format!("{name} music")],
    };
    Some(prompts)
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

    #[test]
    fn ensemble_multiple_wordings_and_desc_override() {
        let e = derive_prompt_ensemble("Sinister", Some("Vibe"), None).unwrap();
        assert!(e.len() >= 2);
        assert!(e.iter().all(|p| p.contains("sinister")));
        // first wording matches the single-prompt template for continuity
        assert_eq!(e[0], "a piece of music with a sinister mood");
        // explicit description collapses to a single verbatim prompt
        let d = derive_prompt_ensemble("Wrecker", Some("Vibe"), Some("aggressive bass")).unwrap();
        assert_eq!(d, vec!["aggressive bass".to_string()]);
        // non-audio group still excluded
        assert!(derive_prompt_ensemble("Ty Doza", Some("People"), None).is_none());
    }
}
