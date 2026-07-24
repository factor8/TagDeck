# Show/Hide Missing Tracks — Design

**Date:** 2026-07-23
**Status:** Approved, ready for implementation plan

## Problem

Tracks whose underlying audio file is missing on disk always appear in the
track list (rendered at 50% opacity). There is no way to hide them. Users
who want a clean, playable-only view have no filter.

## Goal

Add a toolbar toggle that shows or hides missing-file tracks in the track
list. Purely a client-side view filter — no backend, DB, or data changes.

## Existing state (as-is)

- Missing tracks carry a single boolean `missing` (`src/types.ts:18`,
  Rust `src-tauri/src/models.rs:21`, DB column `tracks.missing`). This is
  distinct from the Spotify "ghost" concept (`source: 'spotify'`).
- Missing rows render at 50% opacity (`TrackList.tsx:506`), can't be
  double-click-played (`:568`), are excluded from drag-out/export
  (`:1738`), and right-click offers "Reset missing file status?".
- The track list is `src/components/TrackList.tsx`; its filter pipeline is
  the `filteredTracks` useMemo (`TrackList.tsx:927`), which already layers
  playlist-membership, a ghost exclusion, and search-term filtering.
- The top toolbar (search input + search-help toggle) lives in
  `src/App.tsx:1076-1156`; `searchTerm` state is at `App.tsx:56`.

## Decisions

| Decision | Choice |
|----------|--------|
| Default | **Show missing** (current behavior; toggle opts into hiding) |
| Placement | Toolbar, next to the search bar in `App.tsx` |
| Scope | **Global**, applies to library + all playlists |
| Persistence | `localStorage` (survives app restarts) |
| Empty view | Toggle **always visible**, disabled/dimmed when the current view has zero missing tracks |
| Affordance | Eye / eye-off icon with a small "N missing" count |

## Design

### Control

A toggle button in the top toolbar adjacent to the search bar, styled to
match the existing search-help toggle so it blends into the design
language. Two states:

- **Showing missing** (default): all tracks visible; missing ones stay
  dimmed at 50% exactly as today.
- **Hiding missing**: missing tracks are filtered out of the list.

The button is **always present**. When the current view contains no
missing tracks, it is disabled/dimmed but keeps its position. The label
carries a count derived from the pre-filter track set (e.g. eye-off icon +
"3 missing") so the number is accurate regardless of the toggle's state.

### State

A single global `hideMissing: boolean` lifted to `App` state, initialized
from and persisted to `localStorage`. It is **not** per-playlist
sessionStorage (search's pattern), because the decision is global. Passed
down to `TrackList` as a prop.

### Filtering

One predicate added to the existing `filteredTracks` useMemo in
`TrackList.tsx`, layered alongside the ghost-exclusion and search filters:

```ts
result = result.filter(t => !hideMissing || !t.missing);
```

The "N missing" count is computed from the pre-filter set (the tracks
in-view before the missing filter runs) so it does not change when the
toggle flips.

### Out of scope

- No changes to Rust, the DB, `mark_track_missing`, or the
  missing-detection/relocate flow.
- No change to how missing rows look when shown (still 50% opacity).
- No per-playlist override.

## Testing

Filtering is a pure predicate, so it is unit-testable in isolation:

- `hideMissing = true` → tracks with `missing === true` are excluded.
- `hideMissing = false` → missing tracks are included (dimmed).
- Missing count reflects the underlying in-view data, not the filtered
  output — stable across toggle state.
- Interaction with an active search term: both filters compose (a missing
  track that also fails search stays out; search + hideMissing together
  behave as an AND).
- Toggle disabled state when in-view missing count is zero.

## Files touched

- `src/App.tsx` — `hideMissing` state, localStorage persistence, toolbar
  toggle button, prop pass-down.
- `src/components/TrackList.tsx` — accept `hideMissing` prop, add filter
  predicate to `filteredTracks`, expose/compute in-view missing count.
- Docs: `Docs/CHANGELOG.md` `[Unreleased]` Added entry.
