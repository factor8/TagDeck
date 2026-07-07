# Play Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spotify-style play queue: queue tracks via context menu or Q/⇧Q hotkeys, queued tracks play next then playback resumes from the tracklist, with a Queue tab in the right panel and DB persistence.

**Architecture:** The queue is an in-memory `Track[]` held by a `usePlayQueue` hook mounted in App.tsx (matching the app's useState + prop-drilling style — no state library). The existing "next track" path (Player next button, ArrowRight, track-finish) pops the queue first and falls back to the current `getNextTrack()` tracklist flow. Persistence is a `play_queue` SQLite table rewritten wholesale on every mutation via two new Tauri commands.

**Tech Stack:** Tauri 2 (Rust, rusqlite), React 19, TypeScript, @dnd-kit/sortable (already a dependency), lucide-react icons.

**Spec:** `Docs/superpowers/specs/2026-07-07-play-queue-design.md`

## Global Constraints

- Work on branch `feature/play-queue` (create from `main` if it doesn't exist).
- Rust verification: `cargo check` and `cargo test` run from `src-tauri/`.
- Frontend verification: `npx tsc` from the repo root (there is **no** frontend test runner — do not add one).
- Match existing style: inline styles with CSS vars (`var(--bg-secondary)` etc.), 13px font in panes, existing `context-menu-item` classes.
- The right-panel tab labels are exactly **Tags** and **Queue**.
- Hotkeys: `Q` = Play Later (append), `Shift+Q` = Play Next (prepend). Menu labels: "Play Next", "Play Later".
- Toast copy: single track Play Next → `"<title>" will play next`; multi → `<n> tracks will play next`; single Play Later → `Added "<title>" to queue`; multi → `Added <n> tracks to queue`.
- Do not touch `Player.tsx` / `SpotifyPlayer.tsx` internals — the queue lives entirely above them (App-level `onNext`).
- Restoring the *playing track* on launch already exists (localStorage `app_playing_track`, `App.tsx:31`) — no work needed there. Only the queue itself gets DB persistence.

---

### Task 1: Rust — `play_queue` table, DB methods, Tauri commands

**Files:**
- Modify: `src-tauri/src/db.rs` (migration block ends near line 199; `get_all_tracks` at line 1037; tests module at line 1979)
- Modify: `src-tauri/src/commands.rs` (commands follow the pattern at line 76)
- Modify: `src-tauri/src/lib.rs` (`invoke_handler` registration list, near line 138)

**Interfaces:**
- Produces (frontend contract, used by Task 2):
  - `get_play_queue` command → `Vec<Track>` (serialized with the existing `Track` model — same shape as `get_tracks`)
  - `set_play_queue` command, arg `trackIds: number[]` (Tauri converts camelCase → `track_ids`) → `()`
- Produces (Rust): `Database::get_play_queue(&self) -> Result<Vec<Track>>`, `Database::set_play_queue(&self, track_ids: &[i64]) -> Result<()>`

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/db.rs`, inside `mod tests` (after the existing `ghost()` helper — reuse it), add:

```rust
    #[test]
    fn play_queue_roundtrip_preserves_order_and_duplicates() {
        let db = Database::new(":memory:").unwrap();
        let a = db.insert_imported_track(&ghost("pq-a"), None, None).unwrap();
        let b = db.insert_imported_track(&ghost("pq-b"), None, None).unwrap();
        db.set_play_queue(&[b, a, b]).unwrap();
        let q = db.get_play_queue().unwrap();
        assert_eq!(q.iter().map(|t| t.id).collect::<Vec<_>>(), vec![b, a, b]);
    }

    #[test]
    fn play_queue_set_replaces_and_drops_missing_ids() {
        let db = Database::new(":memory:").unwrap();
        let a = db.insert_imported_track(&ghost("pq-c"), None, None).unwrap();
        // Unknown track ids are persisted but silently dropped on read.
        db.set_play_queue(&[a, 99_999]).unwrap();
        let q = db.get_play_queue().unwrap();
        assert_eq!(q.iter().map(|t| t.id).collect::<Vec<_>>(), vec![a]);
        // set_play_queue fully replaces the previous queue.
        db.set_play_queue(&[]).unwrap();
        assert!(db.get_play_queue().unwrap().is_empty());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `src-tauri/`): `cargo test play_queue`
Expected: FAIL to compile — `no method named set_play_queue found for struct Database`.

- [ ] **Step 3: Add the migration and DB methods**

In `src-tauri/src/db.rs`, in `Database::new`, immediately after the `spotify_merge_log` CREATE TABLE block (before the `playlist_sync_backfill_done` backfill, ~line 181), add:

```rust
        // Play queue: the user's manual "play next" overlay. `position` is a
        // plain ordering column; the whole table is rewritten on every queue
        // change (queues are tiny), so no incremental updates are needed.
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS play_queue (
                position INTEGER PRIMARY KEY,
                track_id INTEGER NOT NULL
            )",
            [],
        );
```

After `get_all_tracks` (ends ~line 1076), add:

```rust
    /// Returns the persisted play queue in order. Queue entries whose track
    /// no longer exists in the library are silently dropped.
    pub fn get_play_queue(&self) -> Result<Vec<crate::models::Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.persistent_id, t.file_path, t.artist, t.title, t.album,
             t.comment_raw, t.grouping_raw, t.duration_secs, t.format, t.size_bytes, t.bit_rate, t.modified_date,
             t.rating, t.date_added, t.bpm, t.missing, t.itunes_pid, t.unlinked_at, t.source, t.spotify_id
             FROM play_queue q JOIN tracks t ON t.id = q.track_id
             ORDER BY q.position",
        )?;

        let track_iter = stmt.query_map([], |row| {
            Ok(crate::models::Track {
                id: row.get(0)?,
                persistent_id: row.get(1)?,
                file_path: row.get(2)?,
                artist: row.get(3)?,
                title: row.get(4)?,
                album: row.get(5)?,
                comment_raw: row.get(6)?,
                grouping_raw: row.get(7)?,
                duration_secs: row.get(8)?,
                format: row.get(9)?,
                size_bytes: row.get(10)?,
                bit_rate: row.get(11)?,
                modified_date: row.get(12)?,
                rating: row.get(13)?,
                date_added: row.get(14)?,
                bpm: row.get(15)?,
                missing: row.get(16).unwrap_or(false),
                itunes_pid: row.get(17).unwrap_or(None),
                unlinked_at: row.get(18).unwrap_or(None),
                source: row.get(19).unwrap_or_else(|_| "local".to_string()),
                spotify_id: row.get(20).unwrap_or(None),
            })
        })?;

        let mut tracks = Vec::new();
        for track in track_iter {
            tracks.push(track?);
        }
        Ok(tracks)
    }

    /// Replaces the persisted play queue with `track_ids` in order, in one
    /// transaction. Duplicate ids are allowed (queueing a song twice is fine).
    pub fn set_play_queue(&self, track_ids: &[i64]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM play_queue", [])?;
        {
            let mut stmt = tx.prepare("INSERT INTO play_queue (position, track_id) VALUES (?1, ?2)")?;
            for (i, tid) in track_ids.iter().enumerate() {
                stmt.execute(params![i as i64, tid])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test play_queue`
Expected: `test result: ok. 2 passed`. Also run `cargo test` once — all existing tests must still pass.

- [ ] **Step 5: Add the Tauri commands**

In `src-tauri/src/commands.rs`, after the `get_tracks` command (ends line 85), add:

```rust
#[tauri::command]
pub async fn get_play_queue(state: State<'_, AppState>) -> Result<Vec<Track>, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Failed to lock DB".to_string())?;
    db.get_play_queue().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_play_queue(track_ids: Vec<i64>, state: State<'_, AppState>) -> Result<(), String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Failed to lock DB".to_string())?;
    db.set_play_queue(&track_ids).map_err(|e| e.to_string())
}
```

In `src-tauri/src/lib.rs`, in the `tauri::generate_handler![...]` list, after `commands::get_tracks,` add:

```rust
            commands::get_play_queue,
            commands::set_play_queue,
```

- [ ] **Step 6: Verify compilation**

Run: `cargo check`
Expected: clean (warnings only if pre-existing).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(queue): play_queue table, DB methods, and Tauri commands"
```

---

### Task 2: Frontend — `usePlayQueue` hook

**Files:**
- Create: `src/hooks/usePlayQueue.ts` (the `src/hooks/` directory does not exist yet — create it)

**Interfaces:**
- Consumes: `get_play_queue` / `set_play_queue` commands from Task 1; `Track` from `src/types.ts`.
- Produces (used by Tasks 4–5): `usePlayQueue(): { queue: Track[]; playNext(tracks: Track[]): void; playLater(tracks: Track[]): void; removeAt(index: number): void; moveItem(from: number, to: number): void; clear(): void; popNext(): Track | undefined; jumpTo(index: number): Track | undefined; }`

- [ ] **Step 1: Write the hook**

Create `src/hooks/usePlayQueue.ts`:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';

/**
 * The manual "play next" queue — an overlay on the tracklist flow.
 * Queued tracks play before the tracklist resumes where it left off.
 * Restored from the DB on launch; every change is persisted fire-and-forget.
 */
export function usePlayQueue() {
    const [queue, setQueue] = useState<Track[]>([]);
    // Guards against persisting the (empty) initial state before the DB load lands.
    const loadedRef = useRef(false);
    // Mirror of `queue` for synchronous reads: popNext/jumpTo must return the
    // popped track immediately, which a setState functional update can't do.
    const queueRef = useRef<Track[]>([]);
    queueRef.current = queue;

    useEffect(() => {
        invoke<Track[]>('get_play_queue')
            .then(q => {
                setQueue(q);
                loadedRef.current = true;
            })
            .catch(err => {
                console.error('Failed to load play queue:', err);
                loadedRef.current = true;
            });
    }, []);

    useEffect(() => {
        if (!loadedRef.current) return;
        invoke('set_play_queue', { trackIds: queue.map(t => t.id) })
            .catch(err => console.error('Failed to persist play queue:', err));
    }, [queue]);

    /** Insert at the front — plays immediately after the current song. */
    const playNext = useCallback((tracks: Track[]) => {
        setQueue(prev => [...tracks, ...prev]);
    }, []);

    /** Append to the end of the queue. */
    const playLater = useCallback((tracks: Track[]) => {
        setQueue(prev => [...prev, ...tracks]);
    }, []);

    const removeAt = useCallback((index: number) => {
        setQueue(prev => prev.filter((_, i) => i !== index));
    }, []);

    const moveItem = useCallback((from: number, to: number) => {
        setQueue(prev => {
            if (from === to || from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
            const next = [...prev];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
        });
    }, []);

    const clear = useCallback(() => setQueue([]), []);

    /** Removes and returns the front of the queue (undefined when empty). */
    const popNext = useCallback((): Track | undefined => {
        const head = queueRef.current[0];
        if (head) setQueue(prev => prev.slice(1));
        return head;
    }, []);

    /** Play queue[index] now: returns it and drops it plus everything before it. */
    const jumpTo = useCallback((index: number): Track | undefined => {
        const target = queueRef.current[index];
        if (target) setQueue(prev => prev.slice(index + 1));
        return target;
    }, []);

    return { queue, playNext, playLater, removeAt, moveItem, clear, popNext, jumpTo };
}
```

- [ ] **Step 2: Verify compilation**

Run (repo root): `npx tsc`
Expected: exits 0, no output. (The hook is not imported anywhere yet — `tsc` still type-checks it via the project include.)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePlayQueue.ts
git commit -m "feat(queue): usePlayQueue hook with DB persistence"
```

---

### Task 3: TrackList — context-menu items and imperative-handle additions

**Files:**
- Modify: `src/components/TrackList.tsx` — props interface (line 46), lucide import (line 39), `TrackListHandle` (line 233), `useImperativeHandle` (line 1691), context menu JSX (line 2076, just inside `<div className="context-menu">`)

**Interfaces:**
- Consumes: nothing new (rows/selection already in scope).
- Produces (used by Task 4):
  - Props `onPlayNext?: (tracks: Track[]) => void` and `onPlayLater?: (tracks: Track[]) => void`
  - `TrackListHandle.getSelectedTracks(): Track[]` — selected tracks in visible row order
  - `TrackListHandle.getUpcomingTracks(fromId: number | null, limit: number): Track[]` — the next `limit` visible rows after `fromId` (from the top when `fromId` is null; empty when `fromId` isn't in the view)

- [ ] **Step 1: Add props and icons**

In the `Props` interface (after `onFileDrop`, line 62), add:

```typescript
    /** Insert tracks at the front of the manual play queue (plays right after the current song). */
    onPlayNext?: (tracks: Track[]) => void;
    /** Append tracks to the end of the manual play queue. */
    onPlayLater?: (tracks: Track[]) => void;
```

Destructure both in the component's props (find where `onFileDrop` is destructured and add `onPlayNext, onPlayLater` alongside).

In the lucide-react import (line 39), add `ListStart, ListEnd`:

```typescript
import { Folder, ArrowUp, ArrowDown, Settings, Volume2, Volume, ListMusic, ChevronRight, Trash2, Activity, AudioLines, Link2, Unlink, FileAudio, X, ExternalLink, ListStart, ListEnd } from 'lucide-react';
```

- [ ] **Step 2: Add handle methods**

In `export interface TrackListHandle` (line 233), after `getOrderedTrackIds`, add:

```typescript
    /** Selected tracks in current visible row order. Used by the Q/⇧Q queue hotkeys. */
    getSelectedTracks: () => Track[];
    /** The next `limit` visible tracks after `fromId` (top of list when null). Feeds the Queue pane's "Next up" section. */
    getUpcomingTracks: (fromId: number | null, limit: number) => Track[];
```

In the `useImperativeHandle` object (line 1691), after `getOrderedTrackIds: () => rows.map(r => r.original.id),`, add:

```typescript
        getSelectedTracks: () =>
            rows.filter(r => selectedTrackIds.has(r.original.id)).map(r => r.original),
        getUpcomingTracks: (fromId: number | null, limit: number) => {
            if (fromId === null) return rows.slice(0, limit).map(r => r.original);
            const currentIndex = rows.findIndex(r => r.original.id === fromId);
            if (currentIndex === -1) return [];
            return rows.slice(currentIndex + 1, currentIndex + 1 + limit).map(r => r.original);
        },
```

- [ ] **Step 3: Add the context-menu items**

Just above the context-menu JSX (before the `return (` of the component is too far — put it right before `useImperativeHandle`, where `rows` and `selectedTrackIds` are in scope), add the shared helper:

```typescript
    // Tracks a context-menu/queue action applies to: the whole selection (in
    // visible row order) when the right-clicked row is part of it, else just that row.
    const getActionTracks = (track: Track): Track[] =>
        selectedTrackIds.has(track.id)
            ? rows.filter(r => selectedTrackIds.has(r.original.id)).map(r => r.original)
            : [track];
```

Inside the context menu (line 2076, immediately after `<div className="context-menu" style={{...}}>` opens and **before** the `Show in Finder` block), add:

```tsx
                        <div
                            className="context-menu-item"
                            onClick={() => {
                                onPlayNext?.(getActionTracks(contextMenu.track));
                                setContextMenu(null);
                            }}
                        >
                            <ListStart size={14} className="context-menu-icon" />
                            <span>
                                {selectedTrackIds.has(contextMenu.track.id) && selectedTrackIds.size > 1
                                    ? `Play Next (${selectedTrackIds.size} tracks)`
                                    : 'Play Next'}
                            </span>
                            <span style={{ marginLeft: 'auto', fontSize: '11px', opacity: 0.6 }}>⇧Q</span>
                        </div>
                        <div
                            className="context-menu-item"
                            onClick={() => {
                                onPlayLater?.(getActionTracks(contextMenu.track));
                                setContextMenu(null);
                            }}
                        >
                            <ListEnd size={14} className="context-menu-icon" />
                            <span>
                                {selectedTrackIds.has(contextMenu.track.id) && selectedTrackIds.size > 1
                                    ? `Play Later (${selectedTrackIds.size} tracks)`
                                    : 'Play Later'}
                            </span>
                            <span style={{ marginLeft: 'auto', fontSize: '11px', opacity: 0.6 }}>Q</span>
                        </div>
                        <div className="context-menu-separator" />
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/TrackList.tsx
git commit -m "feat(queue): Play Next / Play Later context-menu items and queue handle methods"
```

---

### Task 4: App — queue-aware advance, hotkeys, wiring

**Files:**
- Modify: `src/App.tsx` — imports (line 14 area), state (~line 75), keydown handler (lines 601–635 block and effect deps at line 675), Player `onNext` (line 1213), TrackList props (line 1126)

**Interfaces:**
- Consumes: `usePlayQueue` (Task 2), `TrackListHandle.getSelectedTracks` (Task 3), `onPlayNext`/`onPlayLater` TrackList props (Task 3).
- Produces (used by Task 5): `playQueue` hook instance, `handlePlayNext(tracks)`, `handlePlayLater(tracks)`, `handleNextTrack()` — all in App scope.

- [ ] **Step 1: Mount the hook and add handlers**

Add the import:

```typescript
import { usePlayQueue } from './hooks/usePlayQueue';
```

Inside `App()`, after the `trackListRef` declarations (~line 78), add:

```typescript
  const playQueue = usePlayQueue();
```

After `handleRefresh` (line 714–716), add:

```typescript
  // Advance playback: manual queue first, then fall through to the tracklist.
  // (Declare after getSyncReviewSinceTimestamp, ~line 140 — see placement note below.)
  const handleNextTrack = useCallback(() => {
    const queued = playQueue.popNext();
    if (queued) {
        setPlayingTrack(queued);
        setShouldAutoPlay(true);
        return;
    }
    if (playingTrack) {
        const next = trackListRef.current?.getNextTrack(playingTrack.id);
        if (next) {
            setPlayingTrack(next);
            setShouldAutoPlay(true);
        }
    }
  }, [playQueue.popNext, playingTrack]);

  const handlePlayNext = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return;
    playQueue.playNext(tracks);
    showSuccess(tracks.length === 1
        ? `"${tracks[0].title ?? 'Track'}" will play next`
        : `${tracks.length} tracks will play next`);
  }, [playQueue.playNext, showSuccess]);

  const handlePlayLater = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return;
    playQueue.playLater(tracks);
    showSuccess(tracks.length === 1
        ? `Added "${tracks[0].title ?? 'Track'}" to queue`
        : `Added ${tracks.length} tracks to queue`);
  }, [playQueue.playLater, showSuccess]);
```

(`Track` is already imported in App.tsx line 22.) **Placement:** the keydown `useEffect` (line 556) lists these callbacks in its dependency array, so they must be declared before it. Put all three callbacks immediately after the `getSyncReviewSinceTimestamp` callback (~line 140) — NOT after `handleRefresh`, which sits below the effect.

- [ ] **Step 2: Queue-aware next + hotkeys in the keydown handler**

In the keydown handler's arrow-key block, replace the `ArrowRight` branch (lines 613–623):

```typescript
            if (e.key === 'ArrowRight') {
                if (playingTrack || playQueue.queue.length > 0) {
                    e.preventDefault();
                    handleNextTrack();
                    return;
                }
            }
```

Immediately after the `ArrowLeft` branch (line 634, still inside the same `!isInput && !e.metaKey && !e.ctrlKey && !e.altKey` block), add:

```typescript
            // Q / ⇧Q — queue the selected tracks (Play Later / Play Next)
            if (e.key.toLowerCase() === 'q' && !e.repeat) {
                const selected = trackListRef.current?.getSelectedTracks() ?? [];
                if (selected.length > 0) {
                    e.preventDefault();
                    if (e.shiftKey) {
                        handlePlayNext(selected);
                    } else {
                        handlePlayLater(selected);
                    }
                }
                return;
            }
```

Update the effect's dependency array (line 675):

```typescript
  }, [showSuccess, showError, playingTrack, handleNextTrack, handlePlayNext, handlePlayLater, playQueue.queue.length]);
```

- [ ] **Step 3: Route Player onNext through the queue and pass TrackList props**

Replace the Player `onNext` prop (lines 1213–1221) with:

```tsx
        onNext={handleNextTrack}
```

In the `<TrackList>` element (line 1126), add:

```tsx
              onPlayNext={handlePlayNext}
              onPlayLater={handlePlayLater}
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc`
Expected: exits 0.

- [ ] **Step 5: Manual smoke test**

Run `npx tauri dev`, then verify:
1. Right-click a track → Play Next / Play Later appear at the top with ⇧Q / Q hints; both show a toast.
2. Select a few tracks, press Q → "Added N tracks to queue" toast.
3. Play a song, queue a different one, press the player's next button (or ArrowRight) → the queued song plays; press next again → playback continues from the tracklist row after the queued song's position in the visible list (or stops advancing if that song isn't in the current view — acceptable per spec).
4. Typing "q" in the search box does NOT queue anything.
5. Restart the app → queue is still populated (verify via step 3 behavior; the pane arrives in Task 5).

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(queue): queue-aware next-track advance and Q/⇧Q hotkeys"
```

---

### Task 5: QueuePane component and right-panel tabs

**Files:**
- Create: `src/components/QueuePane.tsx`
- Modify: `src/App.tsx` — right-panel JSX (lines 1171–1201), new tab state, header toggle title (line 1021 unchanged — leave it)

**Interfaces:**
- Consumes: `playQueue` from Task 4, `TrackListHandle.getUpcomingTracks` from Task 3, `playlistNames` map (App.tsx line 39), `playingPlaylistId` (line 35).
- Produces: `<QueuePane nowPlaying queue upcoming sourceName onRemoveAt onMoveItem onClear onJumpTo />`

- [ ] **Step 1: Create QueuePane**

Create `src/components/QueuePane.tsx`:

```tsx
import { CSSProperties, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DndContext, DragEndEvent, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, ListMusic, Music, Trash2, X } from 'lucide-react';
import { Track } from '../types';

interface Props {
    nowPlaying: Track | null;
    /** The manual play queue, front = plays next. */
    queue: Track[];
    /** Display-only preview of what the tracklist plays after the queue empties. */
    upcoming: Track[];
    /** Name of the context the upcoming tracks come from (playlist name or "Library"). */
    sourceName: string;
    onRemoveAt: (index: number) => void;
    onMoveItem: (from: number, to: number) => void;
    onClear: () => void;
    /** Play queue[index] immediately (drops it and everything queued before it). */
    onJumpTo: (index: number) => void;
}

const sectionHeaderStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 14px 6px',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: 'var(--text-secondary)',
};

const TrackLabel = ({ track, dimmed }: { track: Track; dimmed?: boolean }) => (
    <div style={{ minWidth: 0, flex: 1, opacity: dimmed ? 0.6 : 1 }}>
        <div style={{
            fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
            {track.title || 'Untitled'}
        </div>
        <div style={{
            fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
            {track.artist || 'Unknown Artist'}
        </div>
    </div>
);

// One sortable row in the manual queue. Sortable id is index-based ("qi-3")
// because the same track may be queued more than once.
const QueueRow = ({ track, index, onRemove, onJump }: {
    track: Track;
    index: number;
    onRemove: () => void;
    onJump: () => void;
}) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
        useSortable({ id: `qi-${index}` });
    const [hovered, setHovered] = useState(false);

    return (
        <div
            ref={setNodeRef}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                opacity: isDragging ? 0.5 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 10px 6px 6px',
                cursor: 'default',
                background: hovered ? 'var(--bg-tertiary)' : 'transparent',
            }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onDoubleClick={onJump}
            title="Double-click to play now"
        >
            <span
                {...attributes}
                {...listeners}
                style={{ display: 'flex', alignItems: 'center', cursor: 'grab', color: 'var(--text-secondary)', touchAction: 'none' }}
            >
                <GripVertical size={14} />
            </span>
            <TrackLabel track={track} />
            <button
                onClick={(e) => { e.stopPropagation(); onRemove(); }}
                style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: 'var(--text-secondary)', padding: '2px', display: 'flex',
                    alignItems: 'center', visibility: hovered ? 'visible' : 'hidden',
                }}
                title="Remove from queue"
            >
                <X size={14} />
            </button>
        </div>
    );
};

export const QueuePane = ({ nowPlaying, queue, upcoming, sourceName, onRemoveAt, onMoveItem, onClear, onJumpTo }: Props) => {
    const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

    // Same artwork fetch as Player.tsx — blob URL from raw bytes.
    useEffect(() => {
        setArtworkUrl(null);
        if (!nowPlaying) return;
        let active = true;
        invoke<number[] | null>('get_track_artwork', { id: nowPlaying.id })
            .then(data => {
                if (active && data) {
                    setArtworkUrl(URL.createObjectURL(new Blob([new Uint8Array(data)])));
                }
            })
            .catch(e => console.warn('Artwork fetch failed', e));
        return () => { active = false; };
    }, [nowPlaying?.id]);

    useEffect(() => {
        return () => { if (artworkUrl) URL.revokeObjectURL(artworkUrl); };
    }, [artworkUrl]);

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const from = Number(String(active.id).replace('qi-', ''));
        const to = Number(String(over.id).replace('qi-', ''));
        if (!Number.isNaN(from) && !Number.isNaN(to)) onMoveItem(from, to);
    };

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
            {/* Now Playing */}
            <div style={sectionHeaderStyle}><span>Now Playing</span></div>
            {nowPlaying ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '2px 14px 10px' }}>
                    <div style={{
                        width: '40px', height: '40px', borderRadius: '4px', flexShrink: 0,
                        background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', color: 'var(--text-secondary)', overflow: 'hidden',
                    }}>
                        {artworkUrl
                            ? <img src={artworkUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            : <Music size={18} />}
                    </div>
                    <TrackLabel track={nowPlaying} />
                </div>
            ) : (
                <div style={{ padding: '2px 14px 10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Nothing playing
                </div>
            )}

            {/* Manual queue */}
            <div style={sectionHeaderStyle}>
                <span>Next in Queue</span>
                {queue.length > 0 && (
                    <button
                        onClick={onClear}
                        style={{
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            color: 'var(--text-secondary)', display: 'flex', alignItems: 'center',
                            gap: '4px', fontSize: '11px', padding: '2px 4px',
                        }}
                        title="Clear queue"
                    >
                        <Trash2 size={12} />
                        Clear
                    </button>
                )}
            </div>
            {queue.length === 0 ? (
                <div style={{ padding: '2px 14px 10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Queue is empty — right-click a track or press Q
                </div>
            ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={queue.map((_, i) => `qi-${i}`)} strategy={verticalListSortingStrategy}>
                        <div>
                            {queue.map((track, i) => (
                                <QueueRow
                                    key={`qi-${i}-${track.id}`}
                                    track={track}
                                    index={i}
                                    onRemove={() => onRemoveAt(i)}
                                    onJump={() => onJumpTo(i)}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            )}

            {/* Upcoming from the tracklist (display only) */}
            <div style={sectionHeaderStyle}><span>Next up from {sourceName}</span></div>
            {upcoming.length === 0 ? (
                <div style={{ padding: '2px 14px 14px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Nothing up next
                </div>
            ) : (
                <div style={{ paddingBottom: '14px' }}>
                    {upcoming.map((track, i) => (
                        <div key={`up-${i}-${track.id}`} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px 6px 12px' }}>
                            <ListMusic size={13} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                            <TrackLabel track={track} dimmed />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
```

- [ ] **Step 2: Add the tab bar to the right panel in App.tsx**

Add the import:

```typescript
import { QueuePane } from './components/QueuePane';
```

Add tab state next to `isRightCollapsed` (line 78):

```typescript
  const [rightPanelTab, setRightPanelTab] = useState<'tags' | 'queue'>('tags');
```

Replace the right panel's inner content (lines 1171–1201, the `<div style={{ height: '100%', ... }}>` containing TagEditor/TagDeck) with:

```tsx
            <div style={{ 
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--bg-secondary)'
            }}>
            {/* Tags / Queue tab bar */}
            <div style={{ display: 'flex', flexShrink: 0, borderBottom: '1px solid var(--border-color)' }}>
                {(['tags', 'queue'] as const).map(tab => (
                    <button
                        key={tab}
                        onClick={() => setRightPanelTab(tab)}
                        style={{
                            flex: 1,
                            padding: '8px 0',
                            background: 'transparent',
                            border: 'none',
                            borderBottom: rightPanelTab === tab ? '2px solid var(--accent-color)' : '2px solid transparent',
                            color: rightPanelTab === tab ? 'var(--text-primary)' : 'var(--text-secondary)',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '6px',
                        }}
                    >
                        {tab === 'tags' ? 'Tags' : 'Queue'}
                        {tab === 'queue' && playQueue.queue.length > 0 && (
                            <span style={{
                                fontSize: '10px',
                                fontWeight: 700,
                                padding: '1px 6px',
                                borderRadius: '8px',
                                background: 'var(--accent-color)',
                                color: '#fff',
                            }}>
                                {playQueue.queue.length}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {rightPanelTab === 'tags' ? (
                <>
                    {/* Editor Panel (Fixed at top of sidebar) */}
                    {selectedTrack ? (
                        <TagEditor 
                            track={selectedTrack} 
                            onUpdate={handleRefresh} 
                            selectedTrackIds={selectedTrackIds}
                            commonTags={currentTags}
                        />
                    ) : (
                        <div style={{ padding: '20px', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '13px' }}>
                            Select a track to edit tags
                        </div>
                    )}

                    {/* Tag Deck (Takes remaining space) */}
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                        <TagDeck 
                            onTagClick={handleDeckTagClick} 
                            currentTrackTags={currentTags}
                            refreshTrigger={refreshTrigger}
                        />
                    </div>
                </>
            ) : (
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    <QueuePane
                        nowPlaying={playingTrack}
                        queue={playQueue.queue}
                        upcoming={trackListRef.current?.getUpcomingTracks(playingTrack?.id ?? null, 20) ?? []}
                        sourceName={playingPlaylistId != null ? (playlistNames.get(playingPlaylistId) ?? 'Playlist') : 'Library'}
                        onRemoveAt={playQueue.removeAt}
                        onMoveItem={playQueue.moveItem}
                        onClear={playQueue.clear}
                        onJumpTo={(index) => {
                            const target = playQueue.jumpTo(index);
                            if (target) {
                                setPlayingTrack(target);
                                setShouldAutoPlay(true);
                            }
                        }}
                    />
                </div>
            )}
            </div>
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc`
Expected: exits 0.

- [ ] **Step 4: Manual smoke test**

Run `npx tauri dev`, then verify:
1. Right panel shows Tags | Queue tabs; Tags looks identical to before.
2. Queue tab: Now Playing shows the current track with artwork (or a music icon), the queue lists queued tracks, "Next up from ‹playlist name›" shows the following tracklist rows.
3. Queue two+ tracks → badge count on the Queue tab updates.
4. Drag a queued row by its grip → order changes (and survives an app restart).
5. Hover a queued row → X appears; clicking removes just that row.
6. Double-click the 2nd queued row → it plays immediately and the 1st row is gone too.
7. Clear empties the queue.
8. The row drag inside the queue does NOT trigger the app-wide track/playlist drag overlay.

- [ ] **Step 5: Commit**

```bash
git add src/components/QueuePane.tsx src/App.tsx
git commit -m "feat(queue): Queue tab in right panel with reorder, remove, jump, and clear"
```

---

### Task 6: Changelog

**Files:**
- Modify: `Docs/CHANGELOG.md` (Unreleased → Added section, top of the list)

**Interfaces:** none.

- [ ] **Step 1: Add the changelog entry**

At the top of the `### Added` list under `## [Unreleased]`, add:

```markdown
- **Play queue**: right-click any track (or a multi-selection) for **Play Next** / **Play Later**, or press **⇧Q** / **Q** with tracks selected. Queued songs play before the tracklist resumes where you left off (Spotify-style). The new **Queue** tab in the right panel shows what's playing, the queue itself (drag to reorder, hover-X to remove, double-click to jump, Clear), and what's coming up next from the current playlist. The queue survives app restarts.
```

- [ ] **Step 2: Commit**

```bash
git add Docs/CHANGELOG.md
git commit -m "docs: changelog for play queue"
```
