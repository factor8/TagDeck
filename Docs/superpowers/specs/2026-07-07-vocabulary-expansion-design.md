# Vocabulary Expansion (New-Tag Suggestions) — Design Spec

**Date:** 2026-07-07
**Status:** Approved

## Overview

Today the AI tag-suggestion feature works over a **closed vocabulary**: it can only ever suggest tags the user already uses. This feature lets the model **grow the vocabulary outward** from the shape of the existing tag cloud. If the user has `Morning`, `Evening`, and `Prime Time` in a "Time of Day" group, the feature infers a time-of-day dimension with a gap and proposes **`Afternoon`** as a brand-new tag when a track sounds like it — even though `Afternoon` has never been applied to any track.

The scoring half already exists: the zero-shot path can score an arbitrary text concept ("music that fits the afternoon") against a track's audio embedding. The genuinely new machinery is narrow:

1. **Generate candidates** from a curated concept map keyed off the user's existing groups.
2. **Review/approve** candidates in the AI settings tab.
3. **Surface** approved candidates as visually-distinct ghost chips on matching tracks; **accepting** one creates the real tag in its group.

Everything downstream of "approved candidate with a text embedding" reuses the shipped zero-shot pipeline.

## Decisions (locked with user)

- **Idea source:** curated concept map now; architected so an LLM proposer can slot in behind the same interface later (feeds only tag names outward, never audio/files). Pairs with planned multi-model Settings work.
- **Surfacing:** a deliberate "scan my tag cloud" pass proposes candidates → the user approves which become **eligible** → approved candidates appear as inline ghost chips on matching tracks.
- **Approve semantics:** approving keeps a candidate **virtual** — it does NOT create a `tags` row. The real tag is created only when the user **accepts** the ghost chip on a track. Keeps the tag cloud tidy (no empty tags).
- **Master toggle:** off by default (respects the closed-vocabulary contract; opt-in).
- **Confidence:** new-tag ghost chips use a **separate, higher** threshold than normal suggestions (a wrong brand-new tag is costlier than a wrong familiar one).

## Behavior model

- **Scan** (manual, in AI settings): deterministic, no model needed. For each of the user's tag groups, match it to a concept-map *dimension* (by group-name alias, else by ≥2 member overlap), and propose that dimension's **missing** members as `proposed` candidates. Case-insensitively dedupes against every existing tag name and every existing candidate. Capped per group.
- **Review:** proposed candidates are listed with their target group; the user **approves** or **dismisses** each. Approving marks the candidate `approved` and triggers a lightweight **text-only** embed (loads the text tower, not audio).
- **Suggest:** when the master toggle is on, `get_tag_suggestions` runs a second zero-shot scoring pass over approved+embedded candidates, applies the higher new-tag threshold, caps to ≤2 per track, and returns them in a separate `new_tags` list.
- **Accept:** clicking a new-tag ghost chip calls one backend command that (a) applies the tag name to the track, (b) resolves the freshly-created tag id, (c) files it under the candidate's group, (d) copies the candidate's description as the tag's zero-shot prompt override, (e) retires the candidate. From then on it is an ordinary tag and graduates to learned-from-you as examples accrue.
- **Dismiss (chip):** session-local hide, keyed by candidate id (mirrors existing suggestion dismissal keyed by tag id).

## Data model (Rust / SQLite)

Two new tables, added inline in `Database::new` (the app has no migration framework — idempotent `CREATE TABLE IF NOT EXISTS`).

```sql
CREATE TABLE IF NOT EXISTS tag_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    group_id INTEGER REFERENCES tag_groups(id) ON DELETE CASCADE,
    description TEXT,                       -- optional curated zero-shot prompt override
    status TEXT NOT NULL DEFAULT 'proposed',-- 'proposed' | 'approved' | 'dismissed'
    source TEXT NOT NULL DEFAULT 'concept_map',
    created_at INTEGER NOT NULL,
    UNIQUE(name, group_id)
);

CREATE TABLE IF NOT EXISTS tag_candidate_embeddings (
    candidate_id INTEGER NOT NULL REFERENCES tag_candidates(id) ON DELETE CASCADE,
    model_version TEXT NOT NULL,
    prompt TEXT NOT NULL,                  -- joined ensemble key (drift sentinel), mirrors tag_text_embeddings
    dims INTEGER NOT NULL,
    embedding BLOB NOT NULL,               -- f32 LE, L2-normalized
    created_at INTEGER NOT NULL,
    PRIMARY KEY (candidate_id, model_version)
);
```

Rationale for the separate embedding table: `tag_text_embeddings.tag_id` is `NOT NULL REFERENCES tags(id)` and half its primary key — a virtual candidate has no `tags` row, so its embedding cannot live there.

Config lives in the existing `library_config` key/value table (same pattern as `suggestion_threshold`):
- `vocab_expansion_enabled` — `"true"` / `"false"`, default `"false"`.
- `vocab_new_tag_threshold` — float string, default `"0.6"` (vs `0.5` for normal suggestions).

Per-track cap is a compile-time constant `MAX_NEW_TAGS_PER_TRACK = 2` (not user-configurable in v1 — YAGNI).

## Concept map

A pure-data Rust module `src-tauri/src/analysis/concept_map.rs`:

```rust
pub struct Member { pub name: &'static str, pub prompt: Option<&'static str> }
pub struct Dimension { pub aliases: &'static [&'static str], pub members: &'static [Member] }
pub static DIMENSIONS: &[Dimension] = &[ /* time_of_day, season, energy, era, activity, instruments, electronic_genre */ ];
```

Matching (`propose(...)`): for each user group, pick the dimension whose `aliases` contains the group name (case-insensitive), else the dimension with the largest member overlap ≥ 2 with the group's tags. Propose members not already present (case-insensitive) anywhere in the vocabulary, capped at `MAX_PROPOSE_PER_GROUP = 5`. `Member.prompt`, when set, becomes the candidate's `description` (used verbatim for zero-shot); when `None`, the candidate relies on the group's `derive_prompt_ensemble` template — identical to how real tags are embedded.

The starter map covers the common generic dimensions; a group that matches no dimension simply yields no candidates (safe). An LLM proposer would later implement the same `propose(...) -> Vec<ProposedCandidate>` contract.

## Scoring integration

`get_tag_suggestions` gains a second pass, gated on `vocab_expansion_enabled`:

- Reuse the existing pure `score_suggestions_with(input, params)` with a **candidates-only** `ScoreInput`: `tag_text` = candidate embeddings, `tag_positives` = empty (⇒ forces the zero-shot branch), `applied` = empty, `threshold` = `vocab_new_tag_threshold`, `max_total` = `max_per_group` = `MAX_NEW_TAGS_PER_TRACK`. The candidate's `id` in the pass is its `candidate_id`.
- Map each resulting `Suggestion` back to `NewTagSuggestion { candidate_id, name, group_id, score }`.
- `SuggestionsResponse` gains `new_tags: Vec<NewTagSuggestion>` (snake_case, matching the existing struct convention).

This reuses the per-tag library-wide z-score→sigmoid calibration verbatim; candidates never get a k-NN score (no positives).

## Commands (registered in `lib.rs`)

- `scan_tag_candidates() -> Vec<TagCandidate>` — deterministic proposal; inserts `proposed` rows; returns the full current candidate list.
- `get_tag_candidates(status: Option<String>) -> Vec<TagCandidate>`
- `approve_tag_candidate(candidate_id: i64)` / `dismiss_tag_candidate(candidate_id: i64)` / `delete_tag_candidate(candidate_id: i64)`
- `embed_tag_candidates()` — text-only; embeds every `approved` candidate lacking a `MODEL_VERSION` embedding (reuses the analyze Phase-1 recipe).
- `finalize_accepted_candidate(candidate_id: i64) -> i64` — called *after* the tag row already exists (the frontend first applies the tag name via the normal add-tag/`sync_tags` write path). Files the freshly-created tag under the candidate's group, copies the curated zero-shot description, retires the candidate, and returns the new tag id. There is deliberately no `accept_tag_candidate`/create-tag-with-group backend path (see the plan's global constraint) — acceptance reuses the audited tag-write path rather than duplicating tag creation.
- `get_vocab_settings() -> VocabSettings { enabled: bool, threshold: f32 }` / `set_vocab_settings(enabled: bool, threshold: f32)`

`TagCandidate { id, name, group_id, group_name, description, status, source }` (group_name joined for UI display).

## Frontend

- **`AnalysisTab.tsx`** — a new "Vocabulary expansion" card inside the existing `{ready && …}` fragment, matching the card/`<h4>`/`<p>`/`btn` conventions: master toggle (`get/set_vocab_settings`), a new-tag confidence slider, a "Scan my tags for new ideas" button, and a review list of `proposed` candidates with per-row Approve/Dismiss. Approving calls `approve_tag_candidate` then `embed_tag_candidates`.
- **`TagEditor.tsx`** — the fetch also reads `new_tags`; renders a distinct third chip variant (not the dashed-accent used by normal suggestions — e.g. a dashed *green* border with a `Plus`/`Sparkles` marker and a "new" affordance). Dismissal keyed on `candidate_id` in a separate `Set`. Accept → apply the tag name via the existing add-tag/`sync_tags` write path (`addTag(name)`), then `finalize_accepted_candidate({ candidateId })` → local refetch + `onUpdate()` (to bump `TagDeck`).
- **Types** — add `NewTagSuggestion` and extend `SuggestionsResponse` in `TagEditor.tsx`; extend `SuggestionsResponse` consumers accordingly. No `App.tsx` changes (suggestions are self-contained in `TagEditor`).

## Non-goals (v1)

- Example-track previews in the review list (the chosen surfacing is inline, not a dedicated review panel).
- User-configurable per-track cap.
- LLM proposer (interface-ready, not implemented).
- Auto-scan on import; persisted accept/dismiss analytics.

## Risks

1. **Noisy zero-shot on subjective dimensions** (energy/vibe-like) — mitigated by the higher new-tag threshold, the ≤2/track cap, curated prompts, and off-by-default. Concrete/describable dimensions (time of day, instruments, era) fare best.
2. **Group-name mismatch for generic users** — mitigated by the ≥2 member-overlap fallback so matching doesn't depend solely on a group being literally named "Time of Day".
3. **Case-insensitive tag uniqueness** (`tags.name UNIQUE COLLATE NOCASE`) — the concept map dedupes case-insensitively so a proposal can never silently merge into an existing tag.
4. **Accept race / partial failure** — acceptance is a frontend two-step sequence: `addTag(name)` (creates the real tag via the audited `sync_tags` write path) then `finalize_accepted_candidate` (group → describe → retire). Ordered so the tag row exists before finalize resolves it by name (`COLLATE NOCASE`). If finalize fails after the tag was created, the tag still exists and is applied to the track, the user gets a toast ("…was added, but couldn't be filed in its group automatically"), and the state self-heals: re-accepting re-files it, and `score_new_tags` filters out any candidate whose name already exists as a real tag so a lingering candidate won't resurface as a "new" chip.

## Verification

- Rust unit tests: concept-map matching (alias + overlap + dedupe), DB round-trips for both tables, accept-flow creates a grouped+described tag and retires the candidate.
- `cargo test` (from `src-tauri/`) and `npx tsc` (repo root) green.
- End-to-end: enable → scan → approve `Afternoon` → analyze a matching track → new-tag ghost chip appears → accept → confirm `Afternoon` exists in the Time-of-Day group with the curated description, is on the track's `comment_raw`, and the candidate row is gone.
