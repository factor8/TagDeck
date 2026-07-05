# Spotify Integration — Design Spec

**Date:** 2026-07-05
**Status:** Approved design, pre-implementation
**Branch:** `feature/spotify-integration`

## Goal

Selectively import Spotify playlists into TagDeck, tag their tracks before owning the files, play them via the Spotify desktop app, and automatically merge accumulated tag data into the real audio file when the track is purchased and lands in the local library.

## Constraints (Spotify API, post-February 2026)

- **Development Mode only.** Extended quota mode requires a registered business with 250k+ MAU — out of reach. Dev Mode allows the app owner plus up to 4 allowlisted users (5 total), and the owner must hold Spotify Premium (the integration stops working if the subscription lapses).
- One Client ID per developer. TagDeck's Spotify settings take a user-supplied Client ID so each installation can use its owner's Spotify app registration if needed.
- Available endpoints cover everything required: `GET /me/playlists`, `GET /playlists/{id}/items`, individual track/album/artist lookups, `GET /search` (max 10 results), and the full `/me/player` suite (play/pause/seek/skip/queue/transfer).
- **Not available:** audio features (BPM/key), recommendations, batch metadata fetches. Spotify BPM/key data cannot be imported.
- Web Playback SDK (in-process streaming) is avoided: it requires EME/DRM in the webview, which Tauri's WKWebView cannot reliably provide. Playback uses Spotify Connect remote control instead.

## Architecture Overview

Ghost tracks (Spotify tracks without local files) live in the existing `tracks` table so the tag editor, track list, search, and playlist machinery work on them unchanged. Spotify playlists live in the existing `playlists` table with a new origin. A separate "Spotify" sidebar section keeps them visually distinct from the local library.

## 1. Data Model

Migration on `tracks`:

- `file_path` becomes **nullable** (`NULL` = ghost track).
- `source TEXT NOT NULL DEFAULT 'local'` — `'local' | 'spotify'`.
- `spotify_id TEXT UNIQUE` — Spotify track ID. Present on ghosts; retained on the local track after a merge so future playlist syncs resolve that Spotify track to the owned file.

Ghost rows: `persistent_id = "SP-{spotify_id}"`, normal artist/title/album/`duration_secs` metadata, `itunes_pid = NULL`. Tags stored in `comment_raw` using the existing `{user comment} && {tag1; tag2}` serialization — DB-resident until a file exists to write to. The `tags` vocabulary table updates as usual.

Migration on `playlists`:

- `origin` gains value `'spotify'`.
- `spotify_playlist_id TEXT`, `spotify_snapshot_id TEXT` — for identity and cheap change detection.

Membership uses the existing `playlist_tracks` table. One ghost per Spotify track regardless of how many playlists contain it.

## 2. Auth & Settings

New **Spotify** tab in Settings:

- Client ID field with a short walkthrough for creating a Spotify developer app (needed by non-owner users due to the 5-user allowlist).
- **Connect** button → Authorization Code + PKCE flow: default browser opens Spotify's consent page; a temporary loopback HTTP listener on `127.0.0.1:<random port>` captures the redirect. Scopes: `playlist-read-private`, `playlist-read-collaborative`, `user-read-playback-state`, `user-modify-playback-state`.
- Tokens stored in the macOS Keychain; access token silently refreshed via the refresh token.
- Connected state shows the account display name; **Disconnect** wipes tokens but keeps imported playlists/ghosts.

## 3. Import & Auto-Sync

- Sidebar Spotify section → **"Import playlists…"** opens a modal listing the user's Spotify playlists with checkboxes (selective import). Import fetches items (paginated), creates/reuses ghost tracks (dedupe on `spotify_id`), and writes playlist + membership rows.
- **Auto-sync** on app launch and every 15 minutes: fetch `/me/playlists`, compare each imported playlist's `snapshot_id`; only changed playlists re-fetch items. Adds new ghosts, updates membership/positions, renames playlists.
- Ghosts removed from all Spotify playlists: **kept if tagged** (still purchase candidates), garbage-collected if untagged.
- Spotify-side "local file" entries and region-unavailable tracks import as metadata-only ghosts (taggable, not playable).
- All sync activity goes through the existing logging system.

## 4. UI

- Separate **SPOTIFY** section in the sidebar, below the existing playlist tree, holding imported playlists with a Spotify badge.
- Tracks render in the existing TrackList. Ghost rows: Spotify glyph, dimmed styling. Tagging, rating, and search behave identically to local tracks. File operations (Option-drag export, file management, relocate) are disabled for ghosts.
- Spotify playlists appear in the sidebar filter and ⌘K quick switcher.
- Match review queue (see §6) surfaces as a badge on the Spotify section header.

## 5. Playback (Spotify Connect)

- Play on a ghost → `PUT /me/player/play` with the track URI, targeting the user's Spotify desktop app. If no active device, TagDeck launches the app via a `spotify:` URI, waits for the device to register, then transfers playback.
- TagDeck's transport bar maps to `/me/player` endpoints (pause, resume, seek, next/previous) while a ghost is the current track. Progress is polled every 5 seconds while playing and interpolated locally between polls.
- Local audio engine is untouched; audio output comes from the Spotify app. Requires Premium (already mandated by Dev Mode).

## 6. Merge on Purchase

Runs wherever new local tracks appear (file import, iTunes sync).

- **Matcher:** normalized artist + title similarity (lowercase, strip punctuation, "feat." credits, remaster/version suffixes) combined with duration within ±3 seconds. Produces a confidence score in [0, 1]. Starting thresholds (tunable during implementation): ≥ 0.90 auto-merges, 0.60–0.90 goes to the review queue, below 0.60 is ignored.
- **High confidence → auto-merge:** union ghost tags into the file's comment field via existing `write_tags` (preserving any user comment and existing file tags), repoint `playlist_tracks` rows from ghost to local track, move `spotify_id` onto the local track, delete the ghost, emit an undoable notification.
- **Mid confidence → review queue:** side-by-side candidate list (ghost vs. new file) with confirm/reject.
- **No match:** nothing happens. Ghost context menu offers manual **"Link to local track…"** as a fallback.

## 7. Error Handling & Edge Cases

- HTTP 429 honors `Retry-After`; sync backs off.
- Offline / revoked token: quiet banner in the Spotify section, sync skipped, cached data remains browsable.
- Connect-time failures (user not allowlisted, owner lost Premium) surface clear, actionable error messages.
- Duplicate Spotify tracks across playlists share one ghost; merging updates every containing playlist at once.

## 8. Testing & Docs

- Unit tests: fuzzy matcher (normalization, thresholds, duration window), ghost tag serialization round-trip, snapshot-diff sync logic.
- `Docs/TestPlan.md`: manual test entries for OAuth connect/disconnect, selective import, auto-sync, Connect playback, auto-merge, review queue, and undo.
- `Docs/CHANGELOG.md` entry on completion.

## Non-Goals

- In-process audio streaming (Web Playback SDK).
- Importing Spotify BPM/key/audio features (API removed).
- Writing tags back to Spotify (no such API surface).
- Two-way playlist sync (TagDeck edits do not push to Spotify).
- Distribution beyond the 5-user Dev Mode allowlist.
