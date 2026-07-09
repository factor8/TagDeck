# TagDeck Documentation

TagDeck is a macOS desktop app (Tauri + React) for tagging and playing local music, with Apple Music/iTunes ingestion, Spotify integration, on-device AI tag suggestions, and DJ-software export.

The docs are organized by **how current and how forward-looking** they are:

| Folder | What's in it | Trust level |
|---|---|---|
| [`reference/`](reference/) | Live "how it works" docs for shipped subsystems | ✅ Kept in sync with the code |
| [`roadmap/`](roadmap/) | Maintained plans and unbuilt / backlog features | 🔜 Forward-looking |
| [`CHANGELOG.md`](CHANGELOG.md) | Authoritative, chronological feature history | ✅ Source of truth for what shipped |
| [`archive/`](archive/) | Superseded plans and point-in-time snapshots | 📦 Historical only — do not trust as current |
| [`superpowers/`](superpowers/) | Spec-Driven-Development artifacts (design specs + task plans) for individual features | 📦 Provenance; features shipped |

## Reference (current)

- [reference/HowAITagSuggestionsWork.md](reference/HowAITagSuggestionsWork.md) — plain-language explainer of the on-device AI tag suggestions and vocabulary expansion.
- [reference/LibraryStrategy.md](reference/LibraryStrategy.md) — **canonical design-of-record** for library ownership, the iTunes sync modes (Off / Import-only / Two-way), Sync Review, conflict handling, and the tag comment-storage format.
- [reference/RealTimeSync.md](reference/RealTimeSync.md) — internals of the real-time delta-sync engine and the library folder watchers.
- [reference/MixedInKeyIntegration.md](reference/MixedInKeyIntegration.md) — how "Analyze with Mixed In Key" triggers the external app and reloads BPM/key/energy.
- [reference/KeyCommands.md](reference/KeyCommands.md) — keyboard shortcuts.
- [reference/SearchSpecs.md](reference/SearchSpecs.md) — advanced search-bar syntax (with parsed-but-not-yet-functional fields flagged).

## Roadmap (forward-looking)

- [roadmap/FileManagementPlan.md](roadmap/FileManagementPlan.md) — file-management product plan; Phases 1–4 shipped, with the remaining gaps tracked.
- [roadmap/SmartPlaylists.md](roadmap/SmartPlaylists.md) — proposed Smart Playlists feature (not yet built).

## Superpowers (SDD artifacts)

Design specs and task-by-task implementation plans for features built via spec-driven development. All have shipped; kept for provenance.

- Spotify integration — [spec](superpowers/specs/2026-07-05-spotify-integration-design.md) · [plan](superpowers/plans/2026-07-05-spotify-integration.md)
- Spotify playlist ↔ library match scan — [spec](superpowers/specs/2026-07-06-spotify-playlist-library-match-scan-design.md) · [plan](superpowers/plans/2026-07-06-spotify-playlist-library-match-scan.md)
- Play queue — [spec](superpowers/specs/2026-07-07-play-queue-design.md) · [plan](superpowers/plans/2026-07-07-play-queue.md)
- Vocabulary expansion — [spec](superpowers/specs/2026-07-07-vocabulary-expansion-design.md) · [plan](superpowers/plans/2026-07-07-vocabulary-expansion.md)

## Archive (historical)

Superseded plans and Feb-2026 snapshots, each with a banner explaining why. Notable: `PRD.md` (original vision), `THE_STORY_OF_THIS_REPO.md` / `REPOSITORY_SUMMARY.md` (origin-sprint snapshots), and `BpmKeyAnalysis.md` (a native BPM/key-detection plan that was never built — TagDeck uses Mixed In Key instead).
