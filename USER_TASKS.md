# User Tasks

Things **Jordan** needs to do by hand — manual tests, model downloads, external
setup, and decisions the agent can't make for him. This is *not* the agent's
code-task list.

**How this works** (see CLAUDE.md → "User Tasks"): agents read this file, add
items as they surface, remind Jordan of open ones, and check them off when he
confirms they're done. If the **🔴 Blocking** section has anything the current
work depends on, the agent surfaces it and pauses first.

## 🔴 Blocking
_Depends-on-Jordan items that should halt related work until done._

- [ ] (2026-07-08) **Smoke-test the AI tag-suggestion feature end-to-end.** It
  shipped to `main` fully green on static checks (cargo/tsc/review) but has never
  actually been run. `npm run tauri dev` → Settings → AI Tags → download the model
  → enable "Suggest new tags" → **Scan** → approve a candidate → analyze a matching
  track → click a green **new** chip → confirm the tag writes to the file's Comment
  frame, is filed in the candidate's group, and the candidate doesn't reappear.
  Report anything off.

## To Do
_Non-blocking — do when convenient._

- [ ] (2026-07-11) **Data-loss risk review — decisions needed.** From the file/data-loss audit. Decide:
  (a) should `DeletionBehavior::Remove` stay selectable at all, or become opt-in-behind-a-warning with **Ask** as the hard default? (b) the mass-deletion safety threshold value — what fraction/count of linked tracks vanishing in one sync should trip the abort-and-review guard (e.g. >10% or >50 tracks)? (c) for "Move" import, prefer deleting originals vs. moving them to Trash (recoverable)?
- [ ] (2026-07-11) **Manual test once #1 lands:** with a large linked library, quit Music.app mid-sync / open an empty or still-loading library and run a sync — confirm TagDeck **aborts the removal phase** and logs a warning instead of purging tracks. Then confirm a *genuine* small deletion in Music.app still reconciles normally.
- [ ] (2026-07-11) **Manual test the iTunes comment read-merge (#2 fix).** In Two-way mode with a linked track: (1) in Music.app, type a note in the track's **Comments** field; (2) in TagDeck, add or remove a tag on that track; (3) confirm the Music.app comment now reads `your note && …tags…` — your note is intact, not replaced. Then (4) edit the note itself via TagDeck's **comment column** and confirm that change *does* push to Music.app.
- [ ] (2026-07-11) **Back up your own TagDeck DB before dogfooding sync** (tags/ratings/playlist membership live only in TagDeck and are not recoverable if a bad sync purges them). Location: the app's data dir SQLite file.

- [ ] (2026-07-09) Verify single-track Suggested Tags progress bar: pick an un-analyzed track, click "Suggest tags", confirm phases advance and the bar fills during audio windows, then suggestions render. Repeat on a first-ever analysis to see "Preparing tags…".
- [ ] (2026-07-09) **Smoke-test the Playlist Builder (Build tab).** `npm run tauri dev` → right-click a playlist → **Build this Playlist** (Build tab opens, header shows count + total time). Then: add via the row **+**, by dragging onto the panel, and via right-click → **Add to "…"** (try a multi-selection); confirm added rows show a check and count/time update. In the panel, reorder by drag, remove a track, double-click to play. Also set a target via the in-tab picker search and via **New playlist**. Confirm Spotify playlists don't offer "Build this Playlist" and an iTunes-synced target reflects the change in Music.app. **⌘Z** should undo an add.

## Done
_Recently finished. Trim when this grows long._

- [x] (2026-07-08) **Test the keyboard media keys.** Confirmed working by Jordan.
