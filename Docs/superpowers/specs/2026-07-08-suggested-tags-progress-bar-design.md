# Suggested Tags — Unified Progress Bar (single track)

**Date:** 2026-07-08
**Status:** Design (approved for planning)

## Problem

When a user opens the Tag Editor on a track that hasn't been analyzed, the
"Suggested" row shows a **Suggest tags** button. Clicking it runs `analyze_tracks`
for that one track and, on completion, fetches suggestions. Today the only feedback
is a bare spinning `Analyzing…` label ([TagEditor.tsx:601](../../../src/components/TagEditor.tsx#L601)).
The user wants a **real progress bar** that moves through the whole operation and
labels the phase it's in.

## Reality that shapes the design

Two very different steps happen in sequence:

- **Analyze** (`analyze_tracks` → `run_job`) — the slow part: load model, decode
  audio, run CLAP inference over 1–3 audio windows. Seconds.
- **Suggest** (`get_tag_suggestions`) — pure vector math over stored embeddings.
  Milliseconds — effectively instant.

So a single bar "through both" spends ~all its life in Analyze. The value is a
genuinely-filling bar during audio embedding plus an honest **phase label**. This
spec makes the Analyze step report sub-track progress so the bar actually moves.

### Pipeline stages (single track)

1. **Preparing tags** *(first run only)* — `run_job` phase `embedding_tags`, loops
   all tags with the 127MB text model. Cached afterward, so skipped on later runs.
   Measurable: `current/total` tags.
2. **Loading model** — `AudioEmbedder::load` (~34MB ONNX). One event, no internal
   sub-progress.
3. **Reading audio** — `decode_to_mono_48k`. One event, no internal sub-progress.
4. **Analyzing audio** — `embed_audio` over 1–3 windows (25/50/75%), each an ONNX
   inference. **This is the sub-track progress** — fills per window.
5. **Finding suggestions** — `get_tag_suggestions` on the JS side. Instant.

Concurrency is safe: `analyze_tracks` rejects with "Analysis is already running" if
any job is in flight ([commands.rs:181](../../../src-tauri/src/analysis/commands.rs#L181)),
so every `analysis-progress` event after the user's click belongs to that click.

## Design

### A. Backend — sub-track progress plumbing

**`src-tauri/src/analysis/clap.rs`**
- Add `embed_audio_with(&mut self, samples: &[f32], on_window: &mut dyn FnMut(usize, usize)) -> Result<Vec<f32>>`.
  It computes `window_offsets` up front (so `window_total` is known), and calls
  `on_window(done, total)` after each window is embedded.
- Keep `embed_audio(samples)` as a thin wrapper that calls `embed_audio_with` with a
  no-op closure. Existing callers are unchanged.

**`src-tauri/src/analysis/commands.rs`**
- Extend `AnalysisProgress` with two optional fields:
  ```rust
  #[serde(skip_serializing_if = "Option::is_none")]
  window: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  window_total: Option<usize>,
  ```
  (Default `None` everywhere else; only the single-track embed path sets them.)
- In `run_job`, for the **single-track case (`total == 1`)** emit explicit boundary
  events so the frontend can drive phases:
  - `phase: "loading_model"` immediately before `AudioEmbedder::load`.
  - `phase: "decoding"` immediately before `decode_to_mono_48k`.
  - during embed, pass a callback to `embed_audio_with` that emits
    `phase: "analyzing"` with `window`/`window_total` set (`current: 1, total: 1`).
  Batch jobs (`total > 1`) keep the existing throttled per-track progress and never
  emit the sub-phase/window ticks (avoids event spam across many workers).
- The `set_status`/`AnalysisStatus` snapshot is unaffected (it already tracks a
  coarse phase string); we only enrich the emitted `AnalysisProgress` event.

Rationale for gating on `total == 1`: the sub-phase events are meaningful only for a
single visible track. A 3-worker batch would interleave `loading_model` events from
each worker into nonsense, and the Settings batch bar is already satisfactory.

### B. Percentage mapping (front end)

The frontend maintains one monotonic `progress` value (0–1) and a `label`. Each
incoming event maps to a **target ceiling**; the bar advances toward its ceiling and
never decreases. Phase → range:

**Normal run (no `embedding_tags` seen):**

| Phase event | Ceiling | Label |
|---|---|---|
| `loading_model` | 0.25 | Loading model… |
| `decoding` | 0.50 | Reading audio… |
| `analyzing` (window k/n) | 0.50 → 0.90 by `k/n` | Analyzing audio… |
| `analysis-complete` → suggestions fetched | 1.00 | Finding suggestions… → done |

**First run (an `embedding_tags` event arrives first):** prepend a leading segment —
`embedding_tags` fills **0 → 0.30** by `current/total`, and the four rows above
compress into **0.30 → 1.00** (loading_model→0.45, decoding→0.55, analyzing
0.55→0.90, complete→1.00). The frontend detects this case simply: if it ever sees an
`embedding_tags` event for this run, it uses the first-run ranges.

**Gentle creep:** during `loading_model` and `decoding` (no internal sub-progress),
a small `requestAnimationFrame`/interval-driven interpolation eases the bar from its
current value toward the phase ceiling over an assumed duration (e.g. ~1.5s), capped
at the ceiling, so it never freezes. The creep is cosmetic and always yields to a
real event (real events set the floor; creep only moves within the current segment
toward its ceiling). Cleared on unmount / completion.

### C. Front-end UI — `src/components/TagEditor.tsx`

- New state: `progress: { fraction: number; label: string } | null`.
- Add `listen('analysis-progress', handler)` in a `useEffect` (mirrors the existing
  `analysis-complete` listener at [TagEditor.tsx:101](../../../src/components/TagEditor.tsx#L101)).
  The handler updates `progress` only while `analyzing` is true; ignore events
  otherwise. Detect the first-run case by remembering whether an `embedding_tags`
  event was seen this run.
- Replace the spinner button ([TagEditor.tsx:592-605](../../../src/components/TagEditor.tsx#L592-L605))
  branch: while `analyzing`, render a slim progress bar + phase label in the same
  `suggestRow` slot instead of the `Analyzing…` button; when not analyzing and
  `!analyzed`, render the existing **Suggest tags** button.
- On `analysis-complete`: set fraction to 1.0 / label "Finding suggestions…", then
  the existing refetch runs and suggestion chips replace the bar (clear `progress`).
- Style: reuse the progress-bar visual language from
  [AnalysisTab.tsx:237-241](../../../src/components/settings/AnalysisTab.tsx#L237-L241)
  for consistency (track + fill + small caption). Keep it compact to fit the editor
  row. Bar and label get `role="progressbar"` + `aria-valuenow`/`aria-valuetext`
  for accessibility.

### D. Error / edge handling

- **Analysis fails** (`analyze_tracks` rejects, e.g. model not downloaded): existing
  `catch` in `analyzeThisTrack` clears `analyzing` and shows the toast; clear
  `progress` too so the bar disappears and the button returns.
- **Job produces no embedding** (decode/inference failure mid-run): `analysis-complete`
  still fires; refetch returns `analyzed: false`, so the row falls back to the
  **Suggest tags** button. No stuck bar.
- **User switches track mid-analysis:** the track-change `useEffect` should clear
  `progress` and `analyzing` so a new selection never shows a stale bar.
- **Cancel:** there is no per-track cancel affordance today; out of scope. (Settings
  has the batch cancel.)

### E. Testing

- **Rust unit test** (clap.rs): `embed_audio_with` invokes the callback exactly
  `window_total` times with monotonic `done`, and `window_total` is 1 for a short
  buffer (`len <= MAX_SAMPLES`) and up to 3 for a long buffer. Assert the returned
  vector is unchanged vs. `embed_audio`.
- **Manual (USER_TASKS.md item):** analyze one un-analyzed track; confirm phases
  advance (Loading model → Reading audio → Analyzing audio → Finding suggestions),
  the bar fills during windows, creep animates during load/decode, and suggestions
  render at the end. Repeat on a **first-ever** analysis to see "Preparing tags…".

## Out of scope

- Settings batch tab changes (its bar is already adequate).
- Sub-window progress finer than per-window.
- Per-track cancel button.

## Files touched

- `src-tauri/src/analysis/clap.rs` — `embed_audio_with` + callback.
- `src-tauri/src/analysis/commands.rs` — `AnalysisProgress` fields, single-track
  boundary/window events in `run_job`.
- `src/components/TagEditor.tsx` — progress state, `analysis-progress` listener,
  bar UI replacing the spinner.
- `Docs/reference/HowAITagSuggestionsWork.md` + `Docs/CHANGELOG.md` — update for the
  new progress UI (keep-docs-current rule).
- `USER_TASKS.md` — manual verification item.
