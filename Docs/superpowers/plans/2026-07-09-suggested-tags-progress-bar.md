# Suggested Tags — Unified Progress Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare `Analyzing…` spinner on the Tag Editor's single-track "Suggest tags" flow with a real, phase-labeled progress bar that fills as the track is embedded.

**Architecture:** The Rust `analyze_tracks` job already emits `analysis-progress` events. We add per-window sub-track progress in the CLAP embedder and, for single-track runs only, emit explicit `loading_model` / `decoding` / windowed `analyzing` events. The React `TagEditor` listens to these, maps them to a monotonic 0–1 fraction with phase labels (plus a cosmetic "creep" during unmeasurable steps), and renders a shared `ProgressBar`.

**Tech Stack:** Rust (Tauri, `ort`/ONNX), React + TypeScript, `@tauri-apps/api` events.

## Global Constraints

- Sub-phase/window events fire **only for single-track runs** (`total == 1`). Batch analysis keeps its existing throttled per-track progress — no new events.
- The frontend bar is **monotonic** — fraction never decreases within a run.
- Concurrency is already guarded: `analyze_tracks` rejects if a job is running, so all `analysis-progress` events after the user's click belong to that click.
- Follow existing code style; do not restructure unrelated code.
- Keep-docs-current: update `Docs/reference/HowAITagSuggestionsWork.md` and `Docs/CHANGELOG.md` in the same change.

## File Structure

- `src-tauri/src/analysis/clap.rs` — add `embed_audio_with` (per-window callback); `embed_audio` becomes a no-op-callback wrapper. Add unit tests for `window_offsets`.
- `src-tauri/src/analysis/commands.rs` — add `window`/`window_total` fields to `AnalysisProgress`; emit single-track boundary + window events in `run_job`.
- `src/components/ProgressBar.tsx` — **new** shared component (extracted from `AnalysisTab`).
- `src/components/settings/AnalysisTab.tsx` — import the shared `ProgressBar`, delete its local copy.
- `src/components/TagEditor.tsx` — progress state, `analysis-progress` listener, mapping + creep, bar UI replacing the spinner.
- `Docs/reference/HowAITagSuggestionsWork.md`, `Docs/CHANGELOG.md`, `USER_TASKS.md` — docs + manual-test tracking.

---

### Task 1: Per-window progress in the CLAP embedder

**Files:**
- Modify: `src-tauri/src/analysis/clap.rs:44-61` (`embed_audio`)
- Test: `src-tauri/src/analysis/clap.rs` (new `#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `AudioEmbedder::embed_audio_with(&mut self, samples: &[f32], on_window: &mut dyn FnMut(usize, usize)) -> Result<Vec<f32>>` — calls `on_window(done, total)` after each window, where `total` is the window count (1–3) and `done` runs 1..=total. `embed_audio(samples)` remains and delegates with a no-op closure (unchanged return value).

- [ ] **Step 1: Write the failing test**

Add at the end of `src-tauri/src/analysis/clap.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_offsets_short_track_is_single_window() {
        assert_eq!(window_offsets(1000), vec![0]);
        assert_eq!(window_offsets(MAX_SAMPLES), vec![0]);
    }

    #[test]
    fn window_offsets_long_track_is_three_ascending() {
        let offs = window_offsets(MAX_SAMPLES * 4);
        assert_eq!(offs.len(), 3);
        assert!(offs.windows(2).all(|w| w[0] < w[1]), "offsets must ascend: {offs:?}");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib analysis::clap::tests`
Expected: FAIL to compile or a failing assertion (the module is new; if `window_offsets` behavior already matches, tests may pass — that is acceptable, they guard the count contract `embed_audio_with` relies on).

- [ ] **Step 3: Add `embed_audio_with` and make `embed_audio` delegate**

Replace `embed_audio` (`clap.rs:42-61`) with:

```rust
    /// Embed a decoded mono-48k waveform. Averages embeddings of up to three 10s
    /// windows (25/50/75% through the track) for a stable whole-track vector.
    pub fn embed_audio(&mut self, samples: &[f32]) -> Result<Vec<f32>> {
        self.embed_audio_with(samples, &mut |_, _| {})
    }

    /// Like [`embed_audio`], but invokes `on_window(done, total)` after each
    /// window is embedded so a caller can report sub-track progress. `total` is
    /// the number of windows (1–3), known before the first inference.
    pub fn embed_audio_with(
        &mut self,
        samples: &[f32],
        on_window: &mut dyn FnMut(usize, usize),
    ) -> Result<Vec<f32>> {
        let offsets = window_offsets(samples.len());
        let total = offsets.len();
        let mut acc = vec![0.0f32; EMBED_DIM];
        let mut count = 0;
        for (i, start) in offsets.into_iter().enumerate() {
            let slice = &samples[start..(start + MAX_SAMPLES).min(samples.len())];
            let fitted = fit_window(slice);
            let emb = self.embed_one_window(&fitted)?;
            for k in 0..EMBED_DIM {
                acc[k] += emb[k];
            }
            count += 1;
            on_window(i + 1, total);
        }
        if count == 0 {
            return Err(anyhow!("no audio windows"));
        }
        l2_normalize(&mut acc);
        Ok(acc)
    }
```

- [ ] **Step 4: Run tests + build**

Run: `cd src-tauri && cargo test --lib analysis::clap::tests && cargo build`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/analysis/clap.rs
git commit -m "feat(analysis): per-window progress callback in embed_audio"
```

---

### Task 2: Emit single-track boundary + window events in `run_job`

**Files:**
- Modify: `src-tauri/src/analysis/commands.rs:140-149` (`AnalysisProgress` struct)
- Modify: `src-tauri/src/analysis/commands.rs:369-488` (`run_job` phase 2 worker loop)

**Interfaces:**
- Consumes: `AudioEmbedder::embed_audio_with` from Task 1.
- Produces: `analysis-progress` events. For single-track runs (`total == 1`), the sequence is `loading_model` → `decoding` → `analyzing` (repeated with `window`/`window_total` set 1..=n) → then `analysis-complete`. Event JSON gains optional `window` and `window_total` (numbers).

- [ ] **Step 1: Add optional fields to `AnalysisProgress`**

In `commands.rs`, replace the struct at lines 140-149 with:

```rust
#[derive(Serialize, Clone)]
struct AnalysisProgress {
    phase: String,
    current: usize,
    total: usize,
    embedded: usize,
    failed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    track_id: Option<i64>,
    /// Window index (1..=window_total) within a single track's audio embed.
    /// Only set for single-track runs; None for batch and non-embed phases.
    #[serde(skip_serializing_if = "Option::is_none")]
    window: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    window_total: Option<usize>,
}
```

- [ ] **Step 2: Add `window`/`window_total: None` to existing constructions**

Three existing `AnalysisProgress { … }` literals must compile with the new fields. Add `window: None, window_total: None,` to each:
- the `embedding_tags` start event (`commands.rs:305-313`),
- the per-tag `embedding_tags` event (`commands.rs:351-360`),
- the phase-2 start `analyzing` event (`commands.rs:372-381`),
- the throttled per-track `analyzing` event (`commands.rs:474-484`).

- [ ] **Step 3: Capture a `single` flag and emit `loading_model`**

Immediately after `let total = candidates.len();` (`commands.rs:370`), add:

```rust
    let single = total == 1;
```

Inside the worker thread closure, immediately at the top of the spawned closure (before `let mut engine = match AudioEmbedder::load(...)` at `commands.rs:401`), add:

```rust
            if single {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    AnalysisProgress {
                        phase: "loading_model".into(),
                        current: 0,
                        total: 1,
                        embedded: 0,
                        failed: 0,
                        track_id: None,
                        window: None,
                        window_total: None,
                    },
                );
            }
```

(`single` is `Copy`, captured by the `move` closure.)

- [ ] **Step 4: Emit `decoding` + windowed `analyzing` around the embed**

Replace the decode+embed `match` block (`commands.rs:418-446`) with:

```rust
                if single {
                    let _ = app.emit(
                        PROGRESS_EVENT,
                        AnalysisProgress {
                            phase: "decoding".into(),
                            current: 0,
                            total: 1,
                            embedded: 0,
                            failed: 0,
                            track_id: Some(track_id),
                            window: None,
                            window_total: None,
                        },
                    );
                }
                let embed_result = decode_to_mono_48k(std::path::Path::new(&path))
                    .and_then(|samples| {
                        if single {
                            let app_win = app.clone();
                            engine.embed_audio_with(&samples, &mut |done, wtotal| {
                                let _ = app_win.emit(
                                    PROGRESS_EVENT,
                                    AnalysisProgress {
                                        phase: "analyzing".into(),
                                        current: 1,
                                        total: 1,
                                        embedded: 0,
                                        failed: 0,
                                        track_id: Some(track_id),
                                        window: Some(done),
                                        window_total: Some(wtotal),
                                    },
                                );
                            })
                        } else {
                            engine.embed_audio(&samples)
                        }
                    });
                match embed_result {
                    Ok(vec) => {
                        if let Ok(db) = app.state::<AppState>().db.lock() {
                            match db.upsert_track_embedding(track_id, MODEL_VERSION, &vec, now_ts()) {
                                Ok(()) => {
                                    embedded.fetch_add(1, Ordering::SeqCst);
                                }
                                Err(e) => {
                                    failed.fetch_add(1, Ordering::SeqCst);
                                    app.state::<crate::logging::LogState>().add_log(
                                        "ERROR",
                                        &format!("store embedding failed (track {track_id}): {e}"),
                                        &app,
                                    );
                                }
                            }
                        }
                    }
                    Err(e) => {
                        failed.fetch_add(1, Ordering::SeqCst);
                        app.state::<crate::logging::LogState>().add_log(
                            "WARN",
                            &format!("analyze failed ({path}): {e:#}"),
                            &app,
                        );
                    }
                }
```

- [ ] **Step 5: Build**

Run: `cd src-tauri && cargo build`
Expected: clean build (all `AnalysisProgress` literals now have the two new fields).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/analysis/commands.rs
git commit -m "feat(analysis): emit single-track phase + window progress events"
```

---

### Task 3: Extract a shared `ProgressBar` component

**Files:**
- Create: `src/components/ProgressBar.tsx`
- Modify: `src/components/settings/AnalysisTab.tsx:374-383` (delete local copy) and its import block

**Interfaces:**
- Produces: `export function ProgressBar({ value, label }: { value: number; label: string })` — `value` is a 0–100 percentage.

- [ ] **Step 1: Create the shared component**

Create `src/components/ProgressBar.tsx`:

```tsx
export function ProgressBar({ value, label }: { value: number; label: string }) {
    return (
        <div style={{ marginTop: '12px' }}>
            <div style={{ height: '6px', background: 'var(--bg-secondary)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ width: `${value}%`, height: '100%', background: 'var(--accent-color)', transition: 'width 0.2s' }} />
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '5px' }}>{label}</div>
        </div>
    );
}
```

- [ ] **Step 2: Point `AnalysisTab` at the shared component**

In `src/components/settings/AnalysisTab.tsx`: delete the local `function ProgressBar(...)` (lines 374-383) and add an import near the top with the other component imports:

```tsx
import { ProgressBar } from '../ProgressBar';
```

- [ ] **Step 3: Build/typecheck**

Run: `npm run build`
Expected: succeeds; `AnalysisTab` renders the same bar via the shared component.

- [ ] **Step 4: Commit**

```bash
git add src/components/ProgressBar.tsx src/components/settings/AnalysisTab.tsx
git commit -m "refactor(ui): extract shared ProgressBar component"
```

---

### Task 4: Progress bar in the Tag Editor

**Files:**
- Modify: `src/components/TagEditor.tsx` — imports, state/refs, listener, `analyzeThisTrack`, complete handler, track-change effect, render.

**Interfaces:**
- Consumes: `analysis-progress` events (`phase`, `current`, `total`, `window?`, `window_total?`) from Task 2; `ProgressBar` from Task 3.

- [ ] **Step 1: Add imports + event type + pure mapping helpers**

In `TagEditor.tsx`, add to the imports:

```tsx
import { useRef } from 'react';
import { ProgressBar } from './ProgressBar';
```

(Merge `useRef` into the existing `react` import if preferred.) Then add at module scope, above the `TagEditor` component:

```tsx
interface AnalysisProgressEvent {
    phase: string;
    current: number;
    total: number;
    window?: number | null;
    window_total?: number | null;
}

const clamp01 = (f: number) => Math.max(0, Math.min(1, f));
const lerp = (a: number, b: number, f: number) => a + (b - a) * clamp01(f);

// Map a single-track analysis event to a target ceiling + phase label.
// Returns null for events the bar should ignore (e.g. the coarse pre-worker
// "analyzing" tick that carries no window data). `firstRun` widens the layout
// to make room for the one-time "Preparing tags…" segment.
function progressForEvent(
    ev: AnalysisProgressEvent,
    firstRun: boolean,
): { ceiling: number; label: string; canCreep: boolean } | null {
    const seg = firstRun
        ? { tags: [0, 0.3], load: [0.3, 0.45], decode: [0.45, 0.55], embed: [0.55, 0.9] }
        : { tags: [0, 0], load: [0, 0.25], decode: [0.25, 0.5], embed: [0.5, 0.9] };
    switch (ev.phase) {
        case 'embedding_tags': {
            const f = ev.total > 0 ? ev.current / ev.total : 0;
            return { ceiling: lerp(seg.tags[0], seg.tags[1], f), label: 'Preparing tags…', canCreep: false };
        }
        case 'loading_model':
            return { ceiling: seg.load[1], label: 'Loading model…', canCreep: true };
        case 'decoding':
            return { ceiling: seg.decode[1], label: 'Reading audio…', canCreep: true };
        case 'analyzing': {
            if (ev.window_total == null) return null; // coarse tick, no sub-progress
            const f = ev.window_total > 0 ? (ev.window ?? 0) / ev.window_total : 0;
            return { ceiling: lerp(seg.embed[0], seg.embed[1], f), label: 'Analyzing audio…', canCreep: false };
        }
        default:
            return null;
    }
}
```

- [ ] **Step 2: Add state + refs (inside the component, near the other suggestion state ~line 66)**

```tsx
    const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
    const analyzingRef = useRef(false);
    const sawTagPhaseRef = useRef(false);
    const creepRef = useRef<number | null>(null); // ceiling to ease toward, or null

    useEffect(() => { analyzingRef.current = analyzing; }, [analyzing]);
```

- [ ] **Step 3: Add the `analysis-progress` listener + creep interval**

Add two effects (near the existing `analysis-complete` effect ~line 101):

```tsx
    // Live progress for THIS component's single-track analyze.
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let active = true;
        listen<AnalysisProgressEvent>('analysis-progress', (e) => {
            if (!analyzingRef.current) return;
            const ev = e.payload;
            if (ev.phase === 'embedding_tags') sawTagPhaseRef.current = true;
            const mapped = progressForEvent(ev, sawTagPhaseRef.current);
            if (!mapped) return;
            creepRef.current = mapped.canCreep ? mapped.ceiling : null;
            setProgress((prev) => {
                const base = prev?.fraction ?? 0;
                const fraction = mapped.canCreep ? base : Math.max(base, mapped.ceiling);
                return { fraction, label: mapped.label };
            });
        }).then((u) => { if (active) unlisten = u; else u(); });
        return () => { active = false; unlisten?.(); };
    }, []);

    // Cosmetic creep during un-measurable steps (model load / decode).
    useEffect(() => {
        const id = setInterval(() => {
            const ceiling = creepRef.current;
            if (ceiling == null) return;
            setProgress((prev) => {
                if (!prev || prev.fraction >= ceiling) return prev;
                const next = Math.min(ceiling, prev.fraction + (ceiling - prev.fraction) * 0.08 + 0.003);
                return { ...prev, fraction: next };
            });
        }, 120);
        return () => clearInterval(id);
    }, []);
```

- [ ] **Step 4: Reset progress on start; finish it on complete; clear on track change**

In `analyzeThisTrack` (`~line 149`), replace the body's start with a reset, and clear progress on error:

```tsx
    const analyzeThisTrack = async () => {
        if (!track) return;
        sawTagPhaseRef.current = false;
        creepRef.current = null;
        setProgress({ fraction: 0, label: 'Starting…' });
        setAnalyzing(true);
        try {
            await invoke('analyze_tracks', { trackIds: [track.id], force: false });
            // `analysis-complete` listener refetches and clears `analyzing`.
        } catch (e) {
            setAnalyzing(false);
            setProgress(null);
            creepRef.current = null;
            const msg = String(e);
            if (msg.includes('not downloaded')) {
                showError('Enable AI suggestions in Settings → AI Tags first.');
            } else {
                showError(`Analysis failed: ${msg}`);
            }
        }
    };
```

In the existing `analysis-complete` listener (`~line 104`), fill to 100% then clear:

```tsx
        listen('analysis-complete', async () => {
            creepRef.current = null;
            setProgress({ fraction: 1, label: 'Finding suggestions…' });
            if (track && !isMultiSelect) await fetchSuggestions(track.id);
            setAnalyzing(false);
            setProgress(null);
        }).then((u) => {
```

In the track-selection effect (`~line 87`), clear progress on any track change:

```tsx
    useEffect(() => {
        setDismissed(new Set());
        setDismissedNew(new Set());
        setProgress(null);
        setAnalyzing(false);
        creepRef.current = null;
        if (track && !isMultiSelect) {
            fetchSuggestions(track.id);
        } else {
            setSuggestions([]);
            setNewTags([]);
            setAnalyzed(true);
        }
    }, [track, isMultiSelect, fetchSuggestions]);
```

- [ ] **Step 5: Render the bar (replace the spinner button branch)**

In the suggestions IIFE (`~line 556`), add a progress branch as the FIRST return inside the IIFE (before the `visible` computation), and leave the existing `!analyzed` button for the idle state:

```tsx
                {!isMultiSelect && (() => {
                    if (progress) {
                        return (
                            <div
                                style={styles.suggestRow}
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(progress.fraction * 100)}
                                aria-valuetext={progress.label}
                            >
                                <div style={{ flex: 1 }}>
                                    <ProgressBar value={Math.round(progress.fraction * 100)} label={progress.label} />
                                </div>
                            </div>
                        );
                    }
                    const visible = suggestions.filter(
```

The rest of the IIFE (visible chips, then the `if (!analyzed)` button, then `return null`) is unchanged. The old `analyzing ? 'Analyzing…'` button no longer shows the spinner during analysis because `progress` is set for the whole run — but leave that button code intact for the idle `!analyzed` state (it renders "Suggest tags").

- [ ] **Step 6: Typecheck/build**

Run: `npm run build`
Expected: succeeds, no TS errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/TagEditor.tsx
git commit -m "feat(tageditor): phased progress bar for single-track Suggest tags"
```

---

### Task 5: Docs + manual-test tracking

**Files:**
- Modify: `Docs/reference/HowAITagSuggestionsWork.md`
- Modify: `Docs/CHANGELOG.md`
- Modify: `USER_TASKS.md`

- [ ] **Step 1: Update the reference doc**

In `Docs/reference/HowAITagSuggestionsWork.md`, add a short note (in the mechanics section) that a single-track "Suggest tags" run now shows a phased progress bar (Preparing tags → Loading model → Reading audio → Analyzing audio → Finding suggestions), driven by `analysis-progress` events with per-window sub-progress. Keep it code-accurate.

- [ ] **Step 2: Update the changelog**

In `Docs/CHANGELOG.md` under `[Unreleased] → Added`, add:

```markdown
- Single-track "Suggest tags" now shows a phased progress bar (model load → audio read → per-window analysis → suggestions) instead of a bare spinner.
```

- [ ] **Step 3: Add the manual-verification task**

In `USER_TASKS.md`, add under the appropriate section:

```markdown
- [ ] (2026-07-09) Verify single-track Suggested Tags progress bar: pick an un-analyzed track, click "Suggest tags", confirm phases advance and the bar fills during audio windows, then suggestions render. Repeat on a first-ever analysis to see "Preparing tags…".
```

- [ ] **Step 4: Commit**

```bash
git add Docs/reference/HowAITagSuggestionsWork.md Docs/CHANGELOG.md USER_TASKS.md
git commit -m "docs: single-track Suggested Tags progress bar"
```

---

## Self-Review

- **Spec coverage:** backend window callback (Task 1), single-track events incl. `loading_model`/`decoding`/window + `total==1` gating (Task 2), monotonic mapping with first-run "Preparing tags…" and gentle creep (Task 4 helpers/effects), UI bar replacing spinner + a11y (Task 4), error/track-change edges (Task 4 Step 4), tests (Task 1), docs + USER_TASKS (Task 5). All spec sections mapped.
- **Placeholders:** none — every code step shows complete code.
- **Type consistency:** `embed_audio_with(&mut self, &[f32], &mut dyn FnMut(usize, usize))` used identically in Tasks 1 and 2; `AnalysisProgress.window/window_total` optional in Task 2 and read as `window?/window_total?` in Task 4; `ProgressBar({value,label})` defined in Task 3 and called in Tasks 3-4.
