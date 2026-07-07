# Play Queue — Design Spec

**Date:** 2026-07-07
**Status:** Approved

## Overview

A Spotify-style play queue. Users queue tracks via context menu or hotkey; queued tracks play next, and when the queue empties, playback resumes from the current tracklist position (Spotify overlay model). A queue pane lives as a tab in the right panel. The queue persists to SQLite and restores on launch.

## Behavior model

- The manual queue is an **overlay** on the implicit tracklist flow. When a track ends (or the user presses Next), the app plays the front of the manual queue if non-empty; otherwise it falls back to the existing `getNextTrack()` (next visible TrackList row).
- **Previous** ignores the queue — it moves back through the tracklist; popped queue items are not restored.
- Playing another track directly (double-click) does **not** clear the queue; it only changes the context the queue overlays.
- Duplicates in the queue are allowed.
- Two queueing actions (iTunes-style):
  - **Play Next** — insert at the front of the manual queue.
  - **Play Later** — append to the end of the manual queue.
- Multi-select: both actions act on the full selection (in visible tracklist order) when the actioned row is part of the selection; Play Next inserts the whole block at the front, preserving order.

## State & data model

- New hook `usePlayQueue` mounted in `App.tsx` (matches existing useState + prop-drilling style; no state library):
  - State: `queue: Track[]`
  - Actions: `playNext(tracks: Track[])`, `playLater(tracks: Track[])`, `removeAt(index)`, `moveItem(from, to)`, `clear()`, `popNext(): Track | undefined`
- Integration points in `App.tsx`:
  - `onNext` handler and the track-finish path: pop the queue first, else `trackListRef.current?.getNextTrack(...)`.
  - `onPrev`: unchanged.

## Persistence (Rust / SQLite)

- Migration: `play_queue (position INTEGER PRIMARY KEY, track_id INTEGER NOT NULL)`.
- Last-playing track id stored in an `app_state` key-value row (reuse the table if one exists; otherwise add it).
- Commands:
  - `get_play_queue() -> Vec<Track>` — JOINs against `tracks`; ids that no longer exist are silently dropped.
  - `set_play_queue(track_ids: Vec<i64>)` — delete-all + reinsert in one transaction (queues are small).
- Every queue mutation calls `set_play_queue` fire-and-forget.
- On launch: restore the queue and the last playing track **paused at the start** of the track (no seek-position restore in v1).

## Entry points

- **TrackList context menu**: two new items, `Play Next` and `Play Later`, separated from existing items, using the same multi-select branching as existing menu items (`selectedTrackIds.has(contextMenu.track.id)`).
- **Hotkeys** (app-level keydown handler in `App.tsx`, guarded by `isTextEntryFocused()` and the existing input guard):
  - `Q` → Play Later (selected tracks)
  - `Shift+Q` → Play Next (selected tracks)
- Both entry points show a toast: e.g. "Added 3 tracks to queue".

## Queue pane (tab in right panel)

- The right panel (`TagEditor` + `TagDeck`) gains a small tab bar: **Tags** | **Queue**. Tags remains the default. The Queue tab shows a count badge when the queue is non-empty.
- Queue tab contents, top to bottom:
  1. **Now Playing** — art, title, artist of `playingTrack`.
  2. **Next in Queue** — the manual queue, with a **Clear** button in the section header.
  3. **Next up from ‹source›** — display-only preview of the next ~20 tracks the tracklist would play after the queue empties, read via a new `getUpcomingTracks(fromId, limit)` method on the TrackList imperative handle.
- Queue-item interactions:
  - Drag to reorder (within Next in Queue).
  - Hover **X** to remove a single item.
  - Double-click to jump: plays that item immediately and removes it and everything queued before it.

## Edge cases

- Spotify ghost tracks queue like any track — `Player` already routes by `track.source`. Known limitation (pre-existing, out of scope): `SpotifyPlayer` has no track-end detection, so when a queued ghost finishes, the user must press Next to continue the queue. Follow-up: detect end-of-track in SpotifyPlayer's progress poll and call `onNext`.
- If a queued track's file is missing at play time, existing missing-file handling applies: the track is marked missing and playback stops with an error (it does not auto-advance — that is the app's pre-existing behavior). The queue entry is already consumed, so pressing Next resumes the queue. Follow-up option: advance-on-missing with a guard against skip-loops through consecutive missing tracks.
- Switching playlists/filters does not touch the manual queue; the "Next up" section simply reflects the new visible tracklist.
- Empty queue + end of tracklist: playback stops (current behavior).

## Testing

- `cargo test` covering `get_play_queue` / `set_play_queue` (order preserved, missing ids dropped, replace semantics).
- `npx tsc` clean.
- Manual smoke: context menu + hotkeys, multi-select queueing, reorder/remove/jump/clear in pane, queue-then-fallback advance, restart restore.
