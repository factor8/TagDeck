# Analyzed-Status Indicator (Tag Window) — Design Spec

**Date:** 2026-07-09
**Status:** Shipped

## Overview

There is currently no way to tell, from the tag window, whether a track's audio
has been analyzed (fingerprinted). Analysis is the prerequisite for tag
suggestions — an un-analyzed track can't be scored — but the only signal today is
the implicit appearance of the "Suggest tags" button. This feature adds a mild,
always-present status indicator in the tag-window header so the user can tell at a
glance whether the selected track is analyzed.

## Decisions (locked with user)

- **States:** show **both** states — a solid marker when analyzed, a faint marker
  when not — rather than only marking the analyzed case.
- **Icon:** **Sparkles** (`lucide-react`), matching the existing AI motif already
  used by the "Suggest tags" button.
- **Placement:** in the header row, immediately left of the Info button.
- **Interactivity:** none. Pure status. Analysis is still triggered by the
  existing "Suggest tags" button; the indicator does not duplicate that action.
- **Scope:** single-track only; hidden in multi-select.

## Behavior model

- **Analyzed** → solid `Sparkles`, size 14, color `var(--accent-color)`, tooltip
  (`title`) "Audio analyzed".
- **Not analyzed** → same `Sparkles`, size 14, color `var(--text-secondary)` at
  ~35% opacity, tooltip "Not analyzed yet".
- **Multi-select** → indicator not rendered (analysis state is per-track and not
  meaningful for a selection).
- The indicator flips faint→solid automatically after the user clicks "Suggest
  tags" and analysis completes, because the existing `analysis-complete` listener
  refetches suggestions and updates the backing state.

## Data source

No backend change and no new command. The indicator reads the existing `analyzed`
boolean state in `TagEditor.tsx` (`src/components/TagEditor.tsx`), which is already
set from every `get_tag_suggestions` response (`resp.analyzed`). The Rust
`SuggestionsResponse.analyzed` field already reports `false` when the track has no
stored embedding for `MODEL_VERSION`.

## Flash guard

`analyzed` initializes to `true` (`TagEditor.tsx` `useState(true)`). On selecting a
never-analyzed track, the header would briefly show the solid "analyzed" look for
the moment before `fetchSuggestions` resolves and corrects it — a misleading flash.

Mitigation: gate the indicator so it does not render until the first
`get_tag_suggestions` fetch for the **current** track has resolved. Implementation:
a `suggestionsLoaded` boolean set `false` at the start of `fetchSuggestions` (and
when the track changes) and `true` in its `finally`. The indicator renders only
when `suggestionsLoaded` is true. This keeps the header from asserting a status it
hasn't confirmed yet.

## Frontend (only file touched: `src/components/TagEditor.tsx`)

- Import `Sparkles` (already imported for the suggest button — reuse).
- Add a `suggestionsLoaded` state; set `false` on track change / fetch start, `true`
  in the `fetchSuggestions` `finally`.
- In the header (`styles.header`, the row currently holding the title span and the
  Info button), insert the indicator between the title `<div>` and the Info button,
  rendered only when `!isMultiSelect && suggestionsLoaded`:
  - `analyzed` → `<Sparkles size={14} color="var(--accent-color)" title="Audio analyzed" />`
  - `!analyzed` → `<Sparkles size={14} style={{ color: 'var(--text-secondary)', opacity: 0.35 }} title="Not analyzed yet" />`
  - Wrap in a `span` with `display:flex; align-items:center; marginLeft:8px` (mirrors
    the Info button's `marginLeft` spacing) so it aligns with the adjacent icons.

Estimated change: ~15 lines plus the `suggestionsLoaded` guard. No type changes
(the `analyzed` field already exists on `SuggestionsResponse`).

## Non-goals (v1)

- Making the indicator clickable to trigger analysis (the "Suggest tags" button
  already covers that).
- A per-track analyzed indicator in the main track list / library table.
- Any bulk "N of M analyzed" summary.
- Backend or schema changes.

## Verification

- `npx tsc` (repo root) green.
- Manual, single-select:
  - Analyzed track → solid accent Sparkles in header.
  - Never-analyzed track → faint Sparkles, no "analyzed" flash on selection.
  - Click "Suggest tags" → after analysis completes, indicator flips faint→solid.
- Multi-select → no indicator.
