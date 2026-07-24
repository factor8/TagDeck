# Show/Hide Missing Tracks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toolbar toggle that shows or hides missing-file tracks in the track list.

**Architecture:** Pure client-side view filter over the existing `missing` boolean. Filter/count logic lives in a small pure helper (`src/utils/missingFilter.ts`). `TrackList` applies the filter inside its existing `filteredTracks` pipeline and reports the in-view missing count up to `App`. `App` owns the global `hideMissing` state (localStorage-persisted) and renders the toolbar toggle next to the search bar. No Rust/DB/backend changes.

**Tech Stack:** React + TypeScript, Vite, lucide-react icons, TanStack Table (existing). Spec: [`Docs/superpowers/specs/2026-07-23-hide-missing-tracks-design.md`](../specs/2026-07-23-hide-missing-tracks-design.md).

## Global Constraints

- **Default:** show missing (toggle opts into hiding). `hideMissing` defaults to `false`.
- **Scope:** global — one setting for library + all playlists.
- **Persistence:** `localStorage`, key `app_hide_missing_tracks`, string `"true"`/`"false"`.
- **Empty view:** toggle always rendered; disabled/dimmed when in-view missing count is `0`.
- **No backend changes:** do not touch `src-tauri/`, the DB, or `mark_track_missing`.
- **Testing convention:** the frontend has no test runner (Rust has `cargo test`, but this feature is React-only). Verify via `npx tsc --noEmit` typecheck + running the app. Logic that can be pure is extracted so it is self-evidently correct by reading it.
- **Missing count semantics:** count = tracks in the current view that pass every other filter (playlist, ghost-exclusion, search) and have `missing === true`. It is computed from the pre-missing-filter set, so flipping the toggle never changes the count. It DOES compose with search.

---

### Task 1: Pure filter/count helper

**Files:**
- Create: `src/utils/missingFilter.ts`

**Interfaces:**
- Consumes: `Track` from `src/types.ts` (`missing?: boolean`).
- Produces:
  - `countMissing(tracks: Track[]): number`
  - `filterMissing(tracks: Track[], hideMissing: boolean): Track[]`

- [ ] **Step 1: Create the helper**

```ts
// src/utils/missingFilter.ts
import type { Track } from '../types';

/** Count tracks whose underlying file is missing on disk. */
export function countMissing(tracks: Track[]): number {
  return tracks.reduce((n, t) => n + (t.missing ? 1 : 0), 0);
}

/**
 * When `hideMissing` is true, return the list with missing-file tracks removed.
 * When false, return the same array reference unchanged (no-op, cheap).
 */
export function filterMissing(tracks: Track[], hideMissing: boolean): Track[] {
  return hideMissing ? tracks.filter(t => !t.missing) : tracks;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors referencing `missingFilter.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/utils/missingFilter.ts
git commit -m "feat(missing): pure helper to filter/count missing-file tracks"
```

---

### Task 2: Apply filter and report count in TrackList

**Files:**
- Modify: `src/components/TrackList.tsx` (Props interface ~46; imports ~1-3; memo ~927-1058)

**Interfaces:**
- Consumes: `countMissing`, `filterMissing` from Task 1.
- Produces (new props on `TrackList`):
  - `hideMissing?: boolean` — when true, hide missing rows.
  - `onMissingCountChange?: (count: number) => void` — reports in-view missing count.

- [ ] **Step 1: Import the helper**

Add to the import block near the top of `src/components/TrackList.tsx` (next to the existing `../utils/searchParser` import at line 3):

```ts
import { countMissing, filterMissing } from '../utils/missingFilter';
```

- [ ] **Step 2: Add the two props to the `Props` interface**

In `interface Props {` (line 46), add after `searchTerm: string;`:

```ts
    /** When true, hide tracks whose file is missing on disk. Global toggle. */
    hideMissing?: boolean;
    /** Reports how many in-view tracks are missing (pre-missing-filter, composes with search). */
    onMissingCountChange?: (count: number) => void;
```

- [ ] **Step 3: Destructure the new props**

In the component signature (line 773), add `hideMissing, onMissingCountChange` to the destructured props list (e.g. after `searchTerm`).

- [ ] **Step 4: Rename the existing filter memo to `baseFilteredTracks`**

At line 927, change:

```ts
    const filteredTracks = useMemo(() => {
```

to:

```ts
    // All filters EXCEPT the missing-file toggle (playlist, ghost, search).
    const baseFilteredTracks = useMemo(() => {
```

Leave the memo body and its dependency array (`}, [tracks, searchTerm, allowedTrackIds, playlistOrderMap, playlistId]);` at line 1058) unchanged.

- [ ] **Step 5: Derive `filteredTracks` and report the count**

Immediately after the memo's closing line (1058), add:

```ts
    // Apply the global "hide missing" toggle on top of the base filters.
    const filteredTracks = useMemo(
        () => filterMissing(baseFilteredTracks, !!hideMissing),
        [baseFilteredTracks, hideMissing]
    );

    // Report in-view missing count (from the pre-missing-filter set, so it is
    // stable when the toggle flips and still reflects the active search).
    useEffect(() => {
        onMissingCountChange?.(countMissing(baseFilteredTracks));
    }, [baseFilteredTracks, onMissingCountChange]);
```

All existing downstream consumers keep using `filteredTracks` unchanged.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (`useEffect`/`useMemo` are already imported in this file.)

- [ ] **Step 7: Commit**

```bash
git add src/components/TrackList.tsx
git commit -m "feat(missing): TrackList hides missing rows and reports in-view count"
```

---

### Task 3: Toolbar toggle in App

**Files:**
- Modify: `src/App.tsx` (lucide import line 8; state ~56; TrackList render ~1296; toolbar search block ~1076-1154)

**Interfaces:**
- Consumes: `hideMissing` / `onMissingCountChange` props on `TrackList` (Task 2).

- [ ] **Step 1: Import Eye/EyeOff icons**

Change line 8 to add `Eye, EyeOff`:

```ts
import { Search, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Settings, X, Info, FolderOpen, Eye, EyeOff } from 'lucide-react';
```

- [ ] **Step 2: Add state (persisted) + missing count**

After the `searchTerm` state (line 56), add:

```ts
  const [hideMissing, setHideMissing] = useState(() => {
    return localStorage.getItem('app_hide_missing_tracks') === 'true';
  });
  const [missingCount, setMissingCount] = useState(0);
```

- [ ] **Step 3: Persist the toggle on change**

Add near the other persistence effects (e.g. after the block around line 695-710, anywhere in the effects region):

```ts
  useEffect(() => {
    localStorage.setItem('app_hide_missing_tracks', String(hideMissing));
  }, [hideMissing]);
```

- [ ] **Step 4: Render the toggle button next to search**

In the search-bar flex container, immediately after the `<BpmCounter />` line (line 1153) and before that container's closing `</div>` (line 1154), add:

```tsx
            <button
                onClick={() => setHideMissing(v => !v)}
                onMouseDown={(e) => e.stopPropagation()}
                disabled={missingCount === 0}
                title={
                    missingCount === 0
                        ? 'No missing-file tracks in view'
                        : hideMissing
                            ? `Show ${missingCount} missing-file track${missingCount === 1 ? '' : 's'}`
                            : `Hide ${missingCount} missing-file track${missingCount === 1 ? '' : 's'}`
                }
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    background: hideMissing ? 'var(--accent-color)' : 'transparent',
                    border: hideMissing ? '1px solid var(--accent-color)' : '1px solid var(--border-color)',
                    color: hideMissing ? '#fff' : 'var(--text-secondary)',
                    borderRadius: '6px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    cursor: missingCount === 0 ? 'default' : 'pointer',
                    opacity: missingCount === 0 ? 0.4 : 1,
                    whiteSpace: 'nowrap'
                }}
            >
                {hideMissing ? <EyeOff size={15} /> : <Eye size={15} />}
                <span>{missingCount} missing</span>
            </button>
```

- [ ] **Step 5: Wire props into TrackList**

In the `<TrackList ... />` render (line 1296), add after the `searchTerm={searchTerm}` prop (line 1306):

```tsx
              hideMissing={hideMissing}
              onMissingCountChange={setMissingCount}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(missing): toolbar toggle to show/hide missing-file tracks"
```

---

### Task 4: Manual verification + docs

**Files:**
- Modify: `Docs/CHANGELOG.md` (`[Unreleased]` → `Added`)

- [ ] **Step 1: Run the app and verify behavior**

Run: `npm run tauri dev` (or use the `run` skill).
Verify:
1. Toolbar shows an "N missing" toggle next to search; N matches the dimmed rows visible in the current view.
2. Clicking it hides missing rows and the button highlights (accent). Clicking again shows them (still 50% dimmed). Count stays the same across the flip.
3. In a view with zero missing tracks, the button reads "0 missing", is dimmed, and does nothing on click.
4. Type a search that excludes some missing tracks → count reflects only missing tracks still matching the search.
5. Toggle on, fully quit and relaunch → still hidden (localStorage persisted). Applies across library and every playlist.

- [ ] **Step 2: Add CHANGELOG entry**

Under `## [Unreleased]` → `### Added` in `Docs/CHANGELOG.md`:

```markdown
- **Show/Hide Missing Tracks** — a toolbar toggle next to search that hides tracks whose file is missing on disk. Global, persists across restarts, and shows how many missing tracks are in view. Purely a view filter — nothing is deleted.
```

- [ ] **Step 3: Commit**

```bash
git add Docs/CHANGELOG.md
git commit -m "docs(missing): changelog entry for show/hide missing tracks"
```

---

## Self-Review

**Spec coverage:**
- Default show → Global Constraints + Task 3 Step 2 (`=== 'true'` defaults false). ✅
- Toolbar placement next to search → Task 3 Step 4 (after `<BpmCounter/>` in search flex). ✅
- Global + localStorage persistence → Task 3 Steps 2-3. ✅
- Always visible, disabled when zero → Task 3 Step 4 (`disabled`, dimmed). ✅
- Eye/EyeOff + "N missing" count → Task 3 Steps 1, 4. ✅
- One-line filter in existing pipeline → Task 2 Steps 4-5. ✅
- Count from pre-filter set, composes with search, stable across toggle → Task 2 Step 5 uses `baseFilteredTracks` (before missing filter, after search). ✅
- No backend changes → no `src-tauri/` edits anywhere. ✅
- Testing (repo-standard: frontend has no runner) → typecheck + manual verify, pure helper extracted. ✅

**Placeholder scan:** none — all steps contain concrete code/commands.

**Type consistency:** `countMissing`/`filterMissing` signatures match between Task 1 (defined) and Task 2 (consumed). Props `hideMissing`/`onMissingCountChange` match between Task 2 (defined on interface) and Task 3 (passed in render). `missingCount`/`setMissingCount` consistent within Task 3.
