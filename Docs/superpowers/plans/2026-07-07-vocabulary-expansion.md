# Vocabulary Expansion (New-Tag Suggestions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the AI feature propose brand-new tags that fill gaps in the user's existing tag groups (e.g. suggest "Afternoon" when they use Morning/Evening/Prime Time), surfaced as visually-distinct ghost chips; accepting one creates the real tag in the right group.

**Architecture:** A curated concept map (pure Rust data) matches each user tag-group to a dimension and proposes its missing members as *candidates* stored in a new `tag_candidates` table. Candidates are **virtual** — no `tags` row exists until the user accepts a ghost chip. Approved candidates get a text embedding in a sibling `tag_candidate_embeddings` table (the existing `tag_text_embeddings.tag_id` is a NOT-NULL FK to `tags`, so candidates can't live there) and are scored by the **existing** zero-shot path (`score_suggestions` with empty positives → zero-shot branch). Suggestions come back in a new `new_tags` field; accepting calls the existing `addTag` write path plus one small `finalize_accepted_candidate` command that files the new tag in its group and retires the candidate.

**Tech Stack:** Tauri 2 (Rust, rusqlite, ort/ONNX Runtime, serde), React 19 + TypeScript, lucide-react icons.

**Spec:** `Docs/superpowers/specs/2026-07-07-vocabulary-expansion-design.md`

## Global Constraints

- Work on branch `feature/vocab-expansion` (create from `main` if it doesn't exist).
- Rust verification: `cargo test` and `cargo check` run **from `src-tauri/`**.
- Frontend verification: `npx tsc --noEmit` from the repo root (there is **no** frontend test runner — do not add one).
- New Rust structs crossing to the frontend serialize in **snake_case** (no `#[serde(rename_all)]`), matching the existing `Suggestion`/`SuggestionsResponse` structs. JSON keys are literally `candidate_id`, `group_id`, `group_name`, `new_tags`, etc.
- `MODEL_VERSION` is `"clap-htsat-unfused-q8-v1"` (`analysis/model_manager.rs:19`); always key embeddings by the imported `MODEL_VERSION` const, never the literal.
- Config lives in the `library_config` key/value table via `db.get_config`/`db.set_config`:
  - `vocab_expansion_enabled` — `"true"`/`"false"`, default `"false"` (master toggle **off** by default).
  - `vocab_new_tag_threshold` — float string, default `"0.6"` (higher than the `0.5` normal-suggestion threshold).
- Compile-time constants: `MAX_NEW_TAGS_PER_TRACK = 2`, `MAX_PROPOSE_PER_GROUP = 5`, `MIN_OVERLAP = 2`. Not user-configurable in v1.
- Candidate stays **virtual** until accepted. "Accept" = frontend `addTag(name)` (existing write path, which creates the tag via `sync_tags`) **then** `finalize_accepted_candidate(candidateId)` (groups + describes + retires). Do NOT add a create-tag-with-group backend path.
- The new-tag ghost chip MUST be visually distinct from the normal suggestion chip (which already owns the dashed **accent** border). Use a different treatment (dashed **green** + a `Plus` marker).
- Rust DB methods return `anyhow::Result<T>` (aliased `Result<T>` in `db.rs`); use `?` freely and `rusqlite::OptionalExtension` for single-row `.optional()` reads. Blob helpers `f32_to_blob(&[f32]) -> Vec<u8>` and `blob_to_f32(&[u8]) -> Vec<f32>` already exist in `db.rs`.
- Do not be verbose in commits; conventional-commit style, one line + body if useful.

---

### Task 1: Rust — candidate tables, models, and DB methods

**Files:**
- Modify: `src-tauri/src/models.rs` (add `TagCandidate` after the `TagGroup` struct at line 110-115)
- Modify: `src-tauri/src/db.rs` (migrations inside `Database::new`, ~after line 217; new methods after `set_tag_description` at line 1395 and in the embeddings section; a free `row_to_candidate` fn; tests in `mod tests`)

**Interfaces:**
- Produces (used by Tasks 3–6):
  - `crate::models::TagCandidate { id: i64, name: String, group_id: Option<i64>, group_name: Option<String>, description: Option<String>, status: String, source: String }` (Serialize/Deserialize/Clone)
  - `Database::insert_tag_candidate(&self, name: &str, group_id: Option<i64>, description: Option<&str>, source: &str, created_at: i64) -> Result<()>` — `INSERT OR IGNORE` on `UNIQUE(name, group_id)`
  - `Database::get_tag_candidates(&self, status: Option<&str>) -> Result<Vec<TagCandidate>>`
  - `Database::get_tag_candidate(&self, id: i64) -> Result<Option<TagCandidate>>`
  - `Database::set_tag_candidate_status(&self, id: i64, status: &str) -> Result<()>`
  - `Database::delete_tag_candidate(&self, id: i64) -> Result<()>` (also deletes its embeddings, so it works whether or not FK cascade is enabled)
  - `Database::upsert_tag_candidate_embedding(&self, candidate_id: i64, model_version: &str, prompt: &str, embedding: &[f32], created_at: i64) -> Result<()>`
  - `Database::all_tag_candidate_embeddings(&self, model_version: &str) -> Result<Vec<(i64, Vec<f32>)>>`
  - `Database::candidate_embedded_ids(&self, model_version: &str) -> Result<HashSet<i64>>`
  - `Database::get_tag_id_by_name(&self, name: &str) -> Result<Option<i64>>` (case-insensitive)

- [ ] **Step 1: Add the `TagCandidate` model**

In `src-tauri/src/models.rs`, immediately after the `TagGroup` struct (ends line 115), add:

```rust
/// A proposed brand-new tag (vocabulary expansion). Virtual until accepted: no
/// `tags` row exists for it until the user accepts a ghost chip on a track.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TagCandidate {
    pub id: i64,
    pub name: String,
    pub group_id: Option<i64>,
    /// Joined from `tag_groups` for display; not stored on the candidate row.
    pub group_name: Option<String>,
    /// Curated zero-shot prompt override (may be None → group template is used).
    pub description: Option<String>,
    /// 'proposed' | 'approved' | 'dismissed'
    pub status: String,
    /// 'concept_map' (future: 'llm')
    pub source: String,
}
```

- [ ] **Step 2: Add the two migrations**

In `src-tauri/src/db.rs`, inside `Database::new`, immediately after the `tag_text_embeddings` `CREATE TABLE` block (ends ~line 217), add:

```rust
        // Vocabulary expansion: proposed brand-new tags derived from the shape of
        // the existing tag cloud. Virtual until accepted (no `tags` row yet).
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS tag_candidates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                group_id INTEGER REFERENCES tag_groups(id) ON DELETE CASCADE,
                description TEXT,
                status TEXT NOT NULL DEFAULT 'proposed',
                source TEXT NOT NULL DEFAULT 'concept_map',
                created_at INTEGER NOT NULL,
                UNIQUE(name, group_id)
            )",
            [],
        );
        // Candidate text embeddings live in their own table because
        // tag_text_embeddings.tag_id is a NOT-NULL FK to tags(id).
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS tag_candidate_embeddings (
                candidate_id INTEGER NOT NULL REFERENCES tag_candidates(id) ON DELETE CASCADE,
                model_version TEXT NOT NULL,
                prompt TEXT NOT NULL,
                dims INTEGER NOT NULL,
                embedding BLOB NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (candidate_id, model_version)
            )",
            [],
        );
```

- [ ] **Step 3: Write the failing DB tests**

In `src-tauri/src/db.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn tag_candidate_roundtrip_and_status() {
        let db = Database::new(":memory:").unwrap();
        let g = db.create_tag_group("Time of Day").unwrap();
        db.insert_tag_candidate("Afternoon", Some(g.id), Some("an afternoon music track"), "concept_map", 111).unwrap();
        // Duplicate (same name+group) is ignored by UNIQUE(name, group_id).
        db.insert_tag_candidate("Afternoon", Some(g.id), None, "concept_map", 222).unwrap();
        let all = db.get_tag_candidates(None).unwrap();
        assert_eq!(all.len(), 1);
        let c = &all[0];
        assert_eq!(c.name, "Afternoon");
        assert_eq!(c.group_id, Some(g.id));
        assert_eq!(c.group_name.as_deref(), Some("Time of Day"));
        assert_eq!(c.status, "proposed");
        db.set_tag_candidate_status(c.id, "approved").unwrap();
        assert_eq!(db.get_tag_candidates(Some("approved")).unwrap().len(), 1);
        assert_eq!(db.get_tag_candidates(Some("proposed")).unwrap().len(), 0);
        assert_eq!(db.get_tag_candidate(c.id).unwrap().unwrap().status, "approved");
        db.delete_tag_candidate(c.id).unwrap();
        assert!(db.get_tag_candidate(c.id).unwrap().is_none());
    }

    #[test]
    fn tag_candidate_embedding_roundtrip_and_cleanup() {
        let db = Database::new(":memory:").unwrap();
        let g = db.create_tag_group("Time of Day").unwrap();
        db.insert_tag_candidate("Afternoon", Some(g.id), None, "concept_map", 1).unwrap();
        let id = db.get_tag_candidates(None).unwrap()[0].id;
        db.upsert_tag_candidate_embedding(id, "m1", "key", &[0.1, 0.2, 0.3], 5).unwrap();
        let all = db.all_tag_candidate_embeddings("m1").unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].0, id);
        assert_eq!(all[0].1.len(), 3);
        assert!(db.candidate_embedded_ids("m1").unwrap().contains(&id));
        assert!(db.candidate_embedded_ids("other").unwrap().is_empty());
        // Deleting the candidate removes its embeddings regardless of FK pragma.
        db.delete_tag_candidate(id).unwrap();
        assert!(db.all_tag_candidate_embeddings("m1").unwrap().is_empty());
    }

    #[test]
    fn get_tag_id_by_name_is_case_insensitive() {
        let db = Database::new(":memory:").unwrap();
        db.conn.execute("INSERT INTO tags (name, usage_count) VALUES ('Afternoon', 0)", []).unwrap();
        assert!(db.get_tag_id_by_name("afternoon").unwrap().is_some());
        assert!(db.get_tag_id_by_name("AFTERNOON").unwrap().is_some());
        assert!(db.get_tag_id_by_name("nope").unwrap().is_none());
    }
```

- [ ] **Step 4: Run tests to verify they fail**

Run (from `src-tauri/`): `cargo test tag_candidate get_tag_id_by_name`
Expected: FAIL to compile — `no method named insert_tag_candidate found for struct Database` (and siblings).

- [ ] **Step 5: Implement the DB methods**

In `src-tauri/src/db.rs`, add these methods inside `impl Database` (place after `set_tag_description`, line 1395). The `HashSet` is `std::collections::HashSet`:

```rust
    // -----------------------------------------------------------------------
    // Tag candidates (vocabulary expansion)
    // -----------------------------------------------------------------------

    pub fn insert_tag_candidate(
        &self,
        name: &str,
        group_id: Option<i64>,
        description: Option<&str>,
        source: &str,
        created_at: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO tag_candidates
                (name, group_id, description, status, source, created_at)
             VALUES (?1, ?2, ?3, 'proposed', ?4, ?5)",
            params![name, group_id, description, source, created_at],
        )?;
        Ok(())
    }

    pub fn get_tag_candidates(&self, status: Option<&str>) -> Result<Vec<crate::models::TagCandidate>> {
        let mut sql = String::from(
            "SELECT c.id, c.name, c.group_id, g.name, c.description, c.status, c.source
             FROM tag_candidates c LEFT JOIN tag_groups g ON g.id = c.group_id",
        );
        if status.is_some() {
            sql.push_str(" WHERE c.status = ?1");
        }
        sql.push_str(" ORDER BY c.group_id, c.name");
        let mut stmt = self.conn.prepare(&sql)?;
        let mut out = Vec::new();
        if let Some(s) = status {
            let rows = stmt.query_map(params![s], row_to_candidate)?;
            for r in rows { out.push(r?); }
        } else {
            let rows = stmt.query_map([], row_to_candidate)?;
            for r in rows { out.push(r?); }
        }
        Ok(out)
    }

    pub fn get_tag_candidate(&self, id: i64) -> Result<Option<crate::models::TagCandidate>> {
        use rusqlite::OptionalExtension;
        let c = self.conn.query_row(
            "SELECT c.id, c.name, c.group_id, g.name, c.description, c.status, c.source
             FROM tag_candidates c LEFT JOIN tag_groups g ON g.id = c.group_id
             WHERE c.id = ?1",
            params![id],
            row_to_candidate,
        ).optional()?;
        Ok(c)
    }

    pub fn set_tag_candidate_status(&self, id: i64, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE tag_candidates SET status = ?1 WHERE id = ?2",
            params![status, id],
        )?;
        Ok(())
    }

    pub fn delete_tag_candidate(&self, id: i64) -> Result<()> {
        // Delete embeddings explicitly so cleanup does not depend on the
        // foreign-keys pragma being enabled.
        self.conn.execute("DELETE FROM tag_candidate_embeddings WHERE candidate_id = ?1", params![id])?;
        self.conn.execute("DELETE FROM tag_candidates WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn upsert_tag_candidate_embedding(
        &self,
        candidate_id: i64,
        model_version: &str,
        prompt: &str,
        embedding: &[f32],
        created_at: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO tag_candidate_embeddings
                (candidate_id, model_version, prompt, dims, embedding, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![candidate_id, model_version, prompt, embedding.len() as i64, f32_to_blob(embedding), created_at],
        )?;
        Ok(())
    }

    pub fn all_tag_candidate_embeddings(&self, model_version: &str) -> Result<Vec<(i64, Vec<f32>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT candidate_id, embedding FROM tag_candidate_embeddings WHERE model_version = ?1",
        )?;
        let rows = stmt.query_map(params![model_version], |row| {
            let id: i64 = row.get(0)?;
            let blob: Vec<u8> = row.get(1)?;
            Ok((id, blob_to_f32(&blob)))
        })?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    pub fn candidate_embedded_ids(&self, model_version: &str) -> Result<std::collections::HashSet<i64>> {
        let mut stmt = self.conn.prepare(
            "SELECT candidate_id FROM tag_candidate_embeddings WHERE model_version = ?1",
        )?;
        let rows = stmt.query_map(params![model_version], |row| row.get::<_, i64>(0))?;
        let mut ids = std::collections::HashSet::new();
        for r in rows { ids.insert(r?); }
        Ok(ids)
    }

    pub fn get_tag_id_by_name(&self, name: &str) -> Result<Option<i64>> {
        use rusqlite::OptionalExtension;
        let id: Option<i64> = self.conn.query_row(
            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
            params![name],
            |row| row.get(0),
        ).optional()?;
        Ok(id)
    }
```

Then add this **free function** near the other module-level helpers in `db.rs` (e.g. beside `f32_to_blob` / `blob_to_f32`):

```rust
/// Map a joined tag_candidates row to the model. Column order:
/// id, name, group_id, group_name, description, status, source.
fn row_to_candidate(row: &rusqlite::Row) -> rusqlite::Result<crate::models::TagCandidate> {
    Ok(crate::models::TagCandidate {
        id: row.get(0)?,
        name: row.get(1)?,
        group_id: row.get(2)?,
        group_name: row.get(3)?,
        description: row.get(4)?,
        status: row.get(5)?,
        source: row.get(6)?,
    })
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run (from `src-tauri/`): `cargo test tag_candidate get_tag_id_by_name`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/db.rs
git commit -m "feat(vocab): tag_candidates schema + DB methods"
```

---

### Task 2: Rust — concept map + proposal logic

**Files:**
- Create: `src-tauri/src/analysis/concept_map.rs`
- Modify: `src-tauri/src/analysis/mod.rs` (add `pub mod concept_map;` after line 7's `pub mod audio;` block)

**Interfaces:**
- Produces (used by Task 3):
  - `concept_map::ProposedCandidate { name: String, group_id: i64, description: Option<String> }`
  - `concept_map::propose(groups: &[(i64, String)], tags_by_group: &HashMap<i64, Vec<String>>, existing_names: &HashSet<String>) -> Vec<ProposedCandidate>` — `existing_names` are **lowercased** tag names for case-insensitive dedupe.

- [ ] **Step 1: Declare the module**

In `src-tauri/src/analysis/mod.rs`, add after line 7 (`pub mod audio;`):

```rust
pub mod concept_map;
```

- [ ] **Step 2: Write the concept map with failing tests**

Create `src-tauri/src/analysis/concept_map.rs`:

```rust
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
```

- [ ] **Step 3: Run tests to verify they pass**

Run (from `src-tauri/`): `cargo test concept_map`
Expected: PASS (4 tests). If it fails to compile on `let Some(dim) = … else { continue };`, the toolchain predates let-else (Rust 1.65); rewrite as `let dim = match match_dimension(gname, group_tags) { Some(d) => d, None => continue };`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/analysis/concept_map.rs src-tauri/src/analysis/mod.rs
git commit -m "feat(vocab): curated concept map + proposal matching"
```

---

### Task 3: Rust — scan + candidate CRUD commands

**Files:**
- Modify: `src-tauri/src/analysis/commands.rs` (add commands after `set_tag_description`, ~line 607; extend imports)
- Modify: `src-tauri/src/lib.rs` (register commands in `generate_handler!`, line 235)

**Interfaces:**
- Consumes: `concept_map::propose` (Task 2); `Database::{get_tag_groups, get_all_tags, insert_tag_candidate, get_tag_candidates, set_tag_candidate_status, delete_tag_candidate}` (Task 1); `now_ts()` (commands.rs:35).
- Produces (frontend contract, Tasks 7–8):
  - `scan_tag_candidates() -> Vec<TagCandidate>`
  - `get_tag_candidates(status: Option<String>) -> Vec<TagCandidate>` (Tauri arg `status`)
  - `approve_tag_candidate(candidateId)` / `dismiss_tag_candidate(candidateId)` / `delete_tag_candidate(candidateId)` → `()`

- [ ] **Step 1: Extend imports**

In `src-tauri/src/analysis/commands.rs`, change line 25 from:

```rust
use crate::models::parse_comment_tags;
```

to:

```rust
use crate::models::{parse_comment_tags, TagCandidate};
```

- [ ] **Step 2: Add the commands**

In `src-tauri/src/analysis/commands.rs`, after `set_tag_description` (ends line 607), add:

```rust
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
```

- [ ] **Step 3: Register the commands**

In `src-tauri/src/lib.rs`, change line 235 from:

```rust
            analysis::commands::set_suggestion_threshold
```

to:

```rust
            analysis::commands::set_suggestion_threshold,
            analysis::commands::scan_tag_candidates,
            analysis::commands::get_tag_candidates,
            analysis::commands::approve_tag_candidate,
            analysis::commands::dismiss_tag_candidate,
            analysis::commands::delete_tag_candidate
```

- [ ] **Step 4: Verify it compiles**

Run (from `src-tauri/`): `cargo check`
Expected: compiles clean (pre-existing unrelated warnings OK). `unused import: TagCandidate` will disappear once used above — if it warns, confirm the commands were added.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/analysis/commands.rs src-tauri/src/lib.rs
git commit -m "feat(vocab): scan + candidate review commands"
```

---

### Task 4: Rust — embed approved candidates (text-only)

**Files:**
- Modify: `src-tauri/src/analysis/commands.rs` (add command after the Task 3 commands)
- Modify: `src-tauri/src/lib.rs` (register)

**Interfaces:**
- Consumes: `TextEmbedder::{load, embed_text}` (clap.rs), `EMBED_DIM`, `l2_normalize` (commands.rs:40), `derive_prompt_ensemble` (prompts.rs), `model_manager::{status, model_dir, MODEL_VERSION}`, `ModelStatus`, `Database::{candidate_embedded_ids, get_tag_groups, get_tag_candidates, upsert_tag_candidate_embedding}`, `TagPromptJob` (commands.rs:155), `now_ts()`.
- Produces: `embed_tag_candidates() -> ()` (arg-less; loads the text tower, embeds every approved candidate lacking a `MODEL_VERSION` embedding).

- [ ] **Step 1: Add the command**

In `src-tauri/src/analysis/commands.rs`, after the Task 3 commands, add:

```rust
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
        let db = app.state::<AppState>().db.lock().map_err(|_| "Failed to lock DB")?;
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
            for p in &job.prompts {
                if let Ok(v) = text.embed_text(p) {
                    for (k, x) in v.iter().enumerate() {
                        acc[k] += x;
                    }
                    n += 1.0;
                }
            }
            if n > 0.0 {
                l2_normalize(&mut acc);
                if let Ok(db) = app2.state::<AppState>().db.lock() {
                    let _ = db.upsert_tag_candidate_embedding(job.tag_id, MODEL_VERSION, &job.key, &acc, now_ts());
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("embed task join: {e}"))?
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, extend the analysis list (after `delete_tag_candidate` from Task 3) — add a comma to the previous last line and append:

```rust
            analysis::commands::embed_tag_candidates
```

- [ ] **Step 3: Verify it compiles**

Run (from `src-tauri/`): `cargo check`
Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/analysis/commands.rs src-tauri/src/lib.rs
git commit -m "feat(vocab): text-only embedding of approved candidates"
```

---

### Task 5: Rust — vocab settings + new-tag scoring in `get_tag_suggestions`

**Files:**
- Modify: `src-tauri/src/analysis/commands.rs` (add `NewTagSuggestion`, constants, extend `SuggestionsResponse`, rewrite `get_tag_suggestions`, add `score_new_tags` + settings commands)
- Modify: `src-tauri/src/lib.rs` (register settings commands)

**Interfaces:**
- Consumes: `score_suggestions`, `ScoreInput`, `TagInfo` (all already imported at commands.rs:22); `Database::{get_tag_candidates, all_tag_candidate_embeddings, get_config, set_config}`; `TagCandidate` (Task 3 import).
- Produces (frontend contract, Task 8):
  - `SuggestionsResponse` gains `new_tags: Vec<NewTagSuggestion>`
  - `NewTagSuggestion { candidate_id: i64, name: String, group_id: Option<i64>, score: f32 }`
  - `get_vocab_settings() -> VocabSettings { enabled: bool, threshold: f32 }`
  - `set_vocab_settings(enabled: bool, threshold: f32) -> ()`

- [ ] **Step 1: Add constants + the `NewTagSuggestion` struct**

In `src-tauri/src/analysis/commands.rs`, near the existing consts (after line 33's `MAX_WORKERS`), add:

```rust
/// Higher default confidence bar for brand-new tags (vs 0.5 for known tags).
const DEFAULT_VOCAB_THRESHOLD: f32 = 0.6;
/// Never surface more than this many new-tag ghost chips on one track.
const MAX_NEW_TAGS_PER_TRACK: usize = 2;
```

Add the response struct near `SuggestionsResponse` (line 524):

```rust
#[derive(Serialize)]
pub struct NewTagSuggestion {
    pub candidate_id: i64,
    pub name: String,
    pub group_id: Option<i64>,
    pub score: f32,
}
```

- [ ] **Step 2: Extend `SuggestionsResponse`**

In `src-tauri/src/analysis/commands.rs`, change the struct (lines 524-529) to:

```rust
#[derive(Serialize)]
pub struct SuggestionsResponse {
    /// False when the track has no embedding yet (UI shows "analyze this track").
    pub analyzed: bool,
    pub suggestions: Vec<Suggestion>,
    /// Brand-new tags proposed via vocabulary expansion (may be empty / disabled).
    pub new_tags: Vec<NewTagSuggestion>,
}
```

- [ ] **Step 3: Rewrite `get_tag_suggestions` to add the candidate pass**

Replace the whole `get_tag_suggestions` function (lines 531-596) with:

```rust
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
        score_new_tags(&query, track_id, &all_tracks, &cand_rows, &cand_emb, vocab_threshold)
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
    threshold: f32,
) -> Vec<NewTagSuggestion> {
    if cands.is_empty() || cand_emb.is_empty() {
        return Vec::new();
    }
    let emb_map: HashMap<i64, Vec<f32>> = cand_emb.iter().cloned().collect();
    let infos: Vec<TagInfo> = cands
        .iter()
        .filter(|c| emb_map.contains_key(&c.id))
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
```

- [ ] **Step 4: Add the settings commands**

In `src-tauri/src/analysis/commands.rs`, after `set_suggestion_threshold` (end of file, line 631), add:

```rust
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
```

- [ ] **Step 5: Register the settings commands**

In `src-tauri/src/lib.rs`, extend the analysis list (after `embed_tag_candidates`) — add a comma and append:

```rust
            analysis::commands::get_vocab_settings,
            analysis::commands::set_vocab_settings
```

- [ ] **Step 6: Verify it compiles + run all Rust tests**

Run (from `src-tauri/`): `cargo check` then `cargo test`
Expected: compiles clean; all existing tests plus Tasks 1–2 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/analysis/commands.rs src-tauri/src/lib.rs
git commit -m "feat(vocab): score approved candidates as new-tag suggestions"
```

---

### Task 6: Rust — finalize (accept) command

**Files:**
- Modify: `src-tauri/src/analysis/commands.rs` (add command)
- Modify: `src-tauri/src/lib.rs` (register)

**Interfaces:**
- Consumes: `Database::{get_tag_candidate, get_tag_id_by_name, set_tag_group, set_tag_description, delete_tag_candidate}`.
- Produces (frontend contract, Task 8): `finalize_accepted_candidate(candidateId) -> i64` — call **after** the tag name has been written to the track (via the existing `addTag`/`write_tags` path). Resolves the freshly-created tag id, files it in the candidate's group, copies the curated description, and retires the candidate. Returns the new tag id.

- [ ] **Step 1: Add the command**

In `src-tauri/src/analysis/commands.rs`, after the Task 5 settings commands, add:

```rust
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
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, extend the analysis list (after `set_vocab_settings`) — add a comma and append:

```rust
            analysis::commands::finalize_accepted_candidate
```

- [ ] **Step 3: Verify it compiles**

Run (from `src-tauri/`): `cargo check`
Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/analysis/commands.rs src-tauri/src/lib.rs
git commit -m "feat(vocab): finalize_accepted_candidate command"
```

---

### Task 7: Frontend — Vocabulary-expansion settings card

**Files:**
- Modify: `src/types.ts` (add `TagCandidate`)
- Modify: `src/components/settings/AnalysisTab.tsx` (new card inside the `{ready && …}` fragment; imports; state; handlers)

**Interfaces:**
- Consumes (Tasks 3–5): `get_vocab_settings`, `set_vocab_settings`, `scan_tag_candidates`, `get_tag_candidates`, `approve_tag_candidate`, `dismiss_tag_candidate`, `embed_tag_candidates`.
- Produces: `TagCandidate` TS type (also used by nothing else; local to settings).

- [ ] **Step 1: Add the `TagCandidate` type**

In `src/types.ts`, after the `TagGroup` interface (line 53-57), add:

```ts
export interface TagCandidate {
  id: number;
  name: string;
  group_id?: number | null;
  group_name?: string | null;
  description?: string | null;
  status: string;
  source: string;
}
```

- [ ] **Step 2: Extend imports in AnalysisTab**

In `src/components/settings/AnalysisTab.tsx`, ensure these lucide icons are imported (add any missing to the existing `lucide-react` import): `Wand2, Check, X, Loader2, Sparkles`. Add the type import at the top with the other imports:

```tsx
import { TagCandidate } from '../../types';
```

- [ ] **Step 3: Add state + handlers**

In `src/components/settings/AnalysisTab.tsx`, inside the component body (near the existing `threshold` state), add:

```tsx
  const [vocabEnabled, setVocabEnabled] = useState(false);
  const [vocabThreshold, setVocabThreshold] = useState(0.6);
  const [proposed, setProposed] = useState<TagCandidate[]>([]);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    invoke<{ enabled: boolean; threshold: number }>('get_vocab_settings')
      .then((v) => { setVocabEnabled(v.enabled); setVocabThreshold(v.threshold); })
      .catch(() => {});
    invoke<TagCandidate[]>('get_tag_candidates', { status: 'proposed' })
      .then(setProposed)
      .catch(() => {});
  }, []);

  const saveVocab = (enabled: boolean, threshold: number) => {
    setVocabEnabled(enabled);
    setVocabThreshold(threshold);
    invoke('set_vocab_settings', { enabled, threshold }).catch(() => {});
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const all = await invoke<TagCandidate[]>('scan_tag_candidates');
      setProposed(all.filter((c) => c.status === 'proposed'));
    } finally {
      setScanning(false);
    }
  };

  const handleApprove = async (id: number) => {
    await invoke('approve_tag_candidate', { candidateId: id });
    setProposed((p) => p.filter((c) => c.id !== id));
    invoke('embed_tag_candidates').catch(() => {}); // fire-and-forget text embed
  };

  const handleDismiss = async (id: number) => {
    await invoke('dismiss_tag_candidate', { candidateId: id });
    setProposed((p) => p.filter((c) => c.id !== id));
  };
```

- [ ] **Step 4: Add the card JSX**

In `src/components/settings/AnalysisTab.tsx`, inside the existing `{ready && ( … )}` fragment (after the threshold card), add this card. It reuses the file's `cardStyle` and `btnStyle`; the small style objects are inlined to match the file's convention:

```tsx
        <div style={cardStyle}>
          <h4 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', fontWeight: 600, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Wand2 size={14} /> Vocabulary expansion
          </h4>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 0 10px' }}>
            Propose brand-new tags that fill gaps in your groups — e.g. “Afternoon”
            when you already use Morning and Evening. Suggested new tags appear as
            distinct ghost chips; accepting one creates the tag.
          </p>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={vocabEnabled}
              onChange={(e) => saveVocab(e.target.checked, vocabThreshold)}
              style={{ accentColor: 'var(--accent-color)' }}
            />
            <span>Suggest new tags</span>
          </label>

          {vocabEnabled && (
            <>
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  New-tag confidence: {vocabThreshold.toFixed(2)}
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={vocabThreshold}
                  onChange={(e) => setVocabThreshold(parseFloat(e.target.value))}
                  onMouseUp={() => saveVocab(vocabEnabled, vocabThreshold)}
                  style={{ width: '100%', accentColor: 'var(--accent-color)' }}
                />
              </div>

              <button
                className="btn"
                style={{ ...btnStyle, marginTop: 12 }}
                onClick={handleScan}
                disabled={scanning}
              >
                {scanning ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />}
                Scan my tags for new ideas
              </button>

              {proposed.length > 0 && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {proposed.map((c) => (
                    <div
                      key={c.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: 'var(--bg-secondary)', borderRadius: 6 }}
                    >
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{c.name}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{c.group_name ?? 'Ungrouped'}</span>
                      <span style={{ flex: 1 }} />
                      <button className="btn" style={{ ...btnStyle, padding: '4px 8px' }} title="Approve" onClick={() => handleApprove(c.id)}>
                        <Check size={13} />
                      </button>
                      <button className="btn" style={{ ...btnStyle, padding: '4px 8px' }} title="Dismiss" onClick={() => handleDismiss(c.id)}>
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
```

> If `cardStyle` / `btnStyle` are not module-scoped in this file (they're defined near the top per the existing threshold/analyze cards), reference them exactly as the sibling cards do. If `useEffect`/`useState` aren't already imported, add them to the existing `react` import.

- [ ] **Step 5: Typecheck**

Run (from repo root): `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Manual verification**

`npm run tauri dev`, open Settings → AI Tags (model must be downloaded → `ready`). Toggle "Suggest new tags" on, click "Scan my tags for new ideas", confirm proposed tags appear with their target group, and Approve/Dismiss remove rows.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/components/settings/AnalysisTab.tsx
git commit -m "feat(vocab): settings card — toggle, scan, review"
```

---

### Task 8: Frontend — new-tag ghost chips in TagEditor

**Files:**
- Modify: `src/components/TagEditor.tsx` (types, state, fetch, render, accept handler, style)

**Interfaces:**
- Consumes (Task 5/6): `get_tag_suggestions` now returns `new_tags`; `finalize_accepted_candidate(candidateId) -> number`.
- Reuses existing in-file: `addTag(name)` (line 346), `fetchSuggestions(trackId)` (line 50), `onUpdate` prop, `applied` set, `styles`.

- [ ] **Step 1: Extend the suggestion types**

In `src/components/TagEditor.tsx`, change the interfaces (lines 17-28 region) to add `NewTagSuggestion` and the `new_tags` field:

```tsx
interface Suggestion { tag_id: number; name: string; group_id?: number | null; score: number; source: string; }
interface NewTagSuggestion { candidate_id: number; name: string; group_id?: number | null; score: number; }
interface SuggestionsResponse { analyzed: boolean; suggestions: Suggestion[]; new_tags: NewTagSuggestion[]; }
```

- [ ] **Step 2: Add state**

In `src/components/TagEditor.tsx`, beside the existing suggestion state (lines 43-46), add:

```tsx
  const [newTags, setNewTags] = useState<NewTagSuggestion[]>([]);
  const [dismissedNew, setDismissedNew] = useState<Set<number>>(new Set());
```

- [ ] **Step 3: Populate + clear `newTags`**

In `fetchSuggestions` (lines 50-60), where it sets `suggestions` from the response, also set new tags:

```tsx
      setNewTags(res.new_tags ?? []);
```

In the effect that clears suggestions on multi/none selection (lines 63-71), also clear:

```tsx
      setNewTags([]);
```

(On error, `setNewTags([])` alongside the existing empty-set.)

- [ ] **Step 4: Add the accept handler**

In `src/components/TagEditor.tsx`, near `acceptSuggestion` (line 91), add:

```tsx
  const acceptNewTag = async (c: NewTagSuggestion) => {
    // Optimistically hide the chip.
    setDismissedNew((prev) => new Set(prev).add(c.candidate_id));
    // Reuse the normal write path — this creates the tag via sync_tags.
    await addTag(c.name);
    try {
      // File it in its group + copy the curated description + retire the candidate.
      await invoke('finalize_accepted_candidate', { candidateId: c.candidate_id });
    } catch {
      // Tag was still created (just uncategorized) — non-fatal.
    }
    onUpdate?.();
    if (track) fetchSuggestions(track.id);
  };
```

> `invoke` and `onUpdate` are already in scope in this file. If `onUpdate` is destructured under a different prop name, use that name.

- [ ] **Step 5: Add the distinct chip style**

In `src/components/TagEditor.tsx`, in the `styles` object (near `ghostChip` at line 621), add a green-dashed variant:

```tsx
    newTagChip: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '3px 9px',
      border: '1px dashed #22c55e',
      background: 'transparent',
      color: 'var(--text-secondary)',
      borderRadius: '10px',
      fontWeight: 500,
      fontSize: '12px',
      cursor: 'pointer',
    } as React.CSSProperties,
    newTagBadge: {
      fontSize: '9px',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      color: '#22c55e',
      fontWeight: 700,
    } as React.CSSProperties,
```

- [ ] **Step 6: Render the new-tag chips**

In `src/components/TagEditor.tsx`, inside the suggestion render block (within the `!isMultiSelect` gate, after the existing suggestion chips ~line 512), add a computed visible list and a chip row. Import `Plus` from `lucide-react` if not present:

```tsx
              {(() => {
                const visibleNew = newTags.filter(
                  (c) => !dismissedNew.has(c.candidate_id) && !applied.has(c.name.toLowerCase())
                );
                if (visibleNew.length === 0) return null;
                return (
                  <div style={styles.suggestRow}>
                    <span style={styles.suggestLabel}>
                      <Plus size={11} /> New tags
                    </span>
                    {visibleNew.map((c) => (
                      <span
                        key={c.candidate_id}
                        style={styles.newTagChip}
                        title={`${Math.round(c.score * 100)}% match — click to add “${c.name}”`}
                        onClick={() => acceptNewTag(c)}
                      >
                        {c.name}
                        <span style={styles.newTagBadge}>new</span>
                        <span style={styles.ghostPct}>{Math.round(c.score * 100)}%</span>
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            setDismissedNew((prev) => new Set(prev).add(c.candidate_id));
                          }}
                          style={{ marginLeft: 2, opacity: 0.6 }}
                        >
                          ×
                        </span>
                      </span>
                    ))}
                  </div>
                );
              })()}
```

> `styles.suggestRow`, `styles.suggestLabel`, `styles.ghostPct` already exist (reused from the normal suggestion block). If `applied` is a `Set<string>` of lowercased names (per the existing `visible` filter at line 489), this matches; otherwise mirror whatever the existing suggestion filter uses.

- [ ] **Step 7: Typecheck**

Run (from repo root): `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 8: Manual verification**

With the model downloaded, vocab enabled, at least one candidate approved+embedded, and a matching track analyzed: select the track → a green-dashed `Name new NN%` chip appears → click it → the tag is written to the track, filed in the candidate's group (check TagDeck), and the candidate no longer reappears. Confirm the track's `comment_raw` and file Comment frame include the new tag.

- [ ] **Step 9: Commit**

```bash
git add src/components/TagEditor.tsx
git commit -m "feat(vocab): distinct new-tag ghost chips + accept flow"
```

---

### Task 9: Docs + changelog

**Files:**
- Modify: `Docs/HowAITagSuggestionsWork.md`
- Modify: `Docs/CHANGELOG.md`

- [ ] **Step 1: Document the feature**

In `Docs/HowAITagSuggestionsWork.md`, add a new section after "Ways It Could Get Better" (after line 19). Match the file's plain, explanatory voice:

```markdown
## Growing Your Vocabulary (Optional)

Normally the feature only ever suggests tags you already use. There's an opt-in
setting (AI Tags in Settings) that lets it grow your vocabulary outward from the
shape of your tag cloud. If you already tag by time of day — Morning, Evening,
Prime Time — it notices the pattern and can propose the gap: Afternoon, say, when
a track sounds like it. You scan your tags, approve the ideas you like, and from
then on approved new tags show up as their own distinct ghost chips (with a
green dashed outline and a “new” marker) on tracks that fit. Accepting one both
creates the tag in the right group and applies it. It's off by default and uses
a stricter confidence bar than ordinary suggestions, because inventing a new tag
is a bigger step than reusing one you already have. The ideas come from a small
built-in map of common musical dimensions; nothing about your library leaves your
Mac.
```

- [ ] **Step 2: Changelog entry**

In `Docs/CHANGELOG.md`, under the `Unreleased` → `Added` section (create the heading if absent), add:

```markdown
- **New-tag suggestions (vocabulary expansion).** Opt-in setting that proposes
  brand-new tags filling gaps in your existing groups (e.g. "Afternoon" alongside
  Morning/Evening), scored on-device via the zero-shot path. Scan and approve
  candidates in Settings → AI Tags; approved tags appear as distinct green ghost
  chips and are created in the right group on accept. Off by default, with a
  separate higher confidence threshold.
```

- [ ] **Step 3: Commit**

```bash
git add Docs/HowAITagSuggestionsWork.md Docs/CHANGELOG.md
git commit -m "docs(vocab): document vocabulary expansion + changelog"
```

---

## Self-Review

**Spec coverage:**
- Concept map + matching → Task 2. Candidate tables (virtual until accepted) → Task 1. Separate candidate embedding table (FK constraint) → Task 1. Scan/review commands → Task 3. Text-only candidate embedding → Task 4. New-tag scoring reusing zero-shot + `new_tags` response + vocab settings (enabled/threshold) → Task 5. Accept (finalize) command → Task 6. Settings card (toggle, confidence, scan, review) → Task 7. Distinct ghost chips + accept flow → Task 8. Docs/changelog → Task 9. Off-by-default + higher threshold → constants/config in Task 5 + Global Constraints. All spec sections map to a task.

**Type consistency:**
- `TagCandidate` fields identical across `models.rs` (Task 1), `row_to_candidate` column order (Task 1), and `types.ts` (Task 7): id, name, group_id, group_name, description, status, source.
- `NewTagSuggestion` identical in Rust (Task 5) and TS (Task 8): candidate_id, name, group_id, score — snake_case JSON.
- `SuggestionsResponse.new_tags` added in Rust (Task 5) and TS (Task 8) together; both early-return and success paths set it (Task 5 Step 3).
- Command arg names: Tauri camelCase `candidateId`/`status`/`enabled`/`threshold` ↔ Rust snake_case `candidate_id`/`status`/`enabled`/`threshold` (Tasks 3–7).
- `finalize_accepted_candidate` returns `i64` (Rust) / `number` (TS accept handler ignores the value but the contract holds).

**Placeholder scan:** No TBD/TODO; every code step contains complete, compiling content. The only conditional notes ("if `cardStyle` isn't module-scoped", "if `onUpdate` is named differently") are guardrails for reading the existing file, not missing content.

**Ordering:** Tasks 1→2 provide DB + concept map before commands (3–6) consume them; frontend (7–8) consumes the finished command surface; docs (9) last. Each task ends green (`cargo test`/`cargo check`/`npx tsc`) and independently reviewable.
