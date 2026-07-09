# Smart Playlists

**Status:** Proposed — not yet built.

> Extracted from the now-archived `Docs/archive/PlaylistPlan.md`. That plan's Phases 1–3 (local playlists, iTunes sync, folders/reorder/visual polish) have all shipped. Smart Playlists was Phase 4, the only unbuilt portion — pulled out here as a standalone backlog item. Verified unbuilt: `is_smart` / `smart_playlist_rules` return no hits in `src-tauri/src/db.rs`.

## Goal

Auto-populating playlists whose track list is derived from tag/metadata filter rules rather than manual curation. The user defines rules once (e.g. "any track tagged Uplifting between 120–130 BPM"), and the playlist stays current as the library changes.

## UX

- Create a smart playlist from the sidebar, same entry point as a normal playlist.
- A rules editor lets the user add one or more rules, each of the form `field · operator · value`, plus a match mode (all / any), an optional track limit, and an optional sort.
- Smart playlists carry a distinct sidebar icon (⚡ / 🔮) to distinguish them from static playlists.
- The user can convert a smart playlist into a static one, freezing its current contents.
- The rules editor should be fast and intuitive — this is the acceptance bar for the feature.

## Rules Model

Each smart playlist owns an ordered set of rules. A rule is a `field`, an `operator`, and a `value`. The playlist's `smart_match_mode` decides whether all rules must match (AND) or any rule (OR).

| Rule | Meaning |
|------|---------|
| `tag contains "Uplifting"` | Any track with the "Uplifting" tag |
| `bpm between [120, 130]` | BPM in range |
| `rating gt 60` | 4+ stars |
| `artist equals "Bicep"` | Exact artist match |
| `date_added gt 1700000000` | Added after a certain date |

- **Fields:** `tag`, `artist`, `album`, `bpm`, `rating`, `format`, `date_added`
- **Operators:** `contains`, `not_contains`, `equals`, `gt`, `lt`, `between`
- **Value:** the comparison value, or JSON for `between` (e.g. `"[120, 140]"`).

## Proposed Schema

```sql
CREATE TABLE IF NOT EXISTS smart_playlist_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    field TEXT NOT NULL,        -- 'tag', 'artist', 'album', 'bpm', 'rating', 'format', 'date_added'
    operator TEXT NOT NULL,     -- 'contains', 'not_contains', 'equals', 'gt', 'lt', 'between'
    value TEXT NOT NULL,        -- the comparison value (or JSON for 'between': "[120, 140]")
    position INTEGER DEFAULT 0  -- rule order
);

ALTER TABLE playlists ADD COLUMN is_smart BOOLEAN DEFAULT 0;
ALTER TABLE playlists ADD COLUMN smart_match_mode TEXT DEFAULT 'all';
  -- 'all' = AND logic (every rule must match)
  -- 'any' = OR logic (at least one rule matches)
ALTER TABLE playlists ADD COLUMN smart_limit INTEGER;
  -- Optional max track count
ALTER TABLE playlists ADD COLUMN smart_sort TEXT;
  -- Optional sort field for limiting (e.g., 'date_added DESC')
```

Follow the existing safe-migration pattern in `Database::new` (`let _ = conn.execute("ALTER TABLE ...", []);`).

## Behavior

- Smart playlists have `is_smart = true` and `origin = 'tagdeck'`.
- Their track list is **computed on demand** by evaluating rules against the track database.
- Results are cached in `playlist_tracks` for performance but regenerated when:
  - The user opens the playlist
  - A track's metadata changes (tags, rating, BPM)
  - The user manually refreshes
- Converting to a static playlist freezes the current results.

## Acceptance Criteria

- [ ] User can create a smart playlist with 1+ rules.
- [ ] Smart playlist auto-refreshes when tracks change.
- [ ] User can convert smart → static playlist.
- [ ] Smart playlist rules editor is intuitive and fast.

## Performance

On large (~100k track) libraries, re-evaluating rules eagerly is too slow. Cache results in `playlist_tracks`, only re-evaluate on demand or when affected metadata changes, and rely on indexed columns for common filter fields (`bpm`, `rating`, `date_added`, tags).

## Open Questions

- What triggers "a track's metadata changed" cheaply enough to invalidate only affected smart playlists, rather than all of them?
- Should smart playlists be pushable to iTunes, or are they TagDeck-only? (iTunes has native smart playlists with a different rules format — no attempt at interop is assumed here.)
- How are rules validated / surfaced in the UI when a `field`/`operator` combination is nonsensical (e.g. `format between`)?
- Does `tag contains` match substrings or whole tags, and how does it interact with multi-tag tracks?
- Should `smart_sort` be a free-text SQL fragment (injection risk) or a constrained field + direction picker?
