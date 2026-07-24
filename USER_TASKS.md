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

- [X] (2026-07-08) **Smoke-test the AI tag-suggestion feature end-to-end.** It
  shipped to `main` fully green on static checks (cargo/tsc/review) but has never
  actually been run. `npm run tauri dev` → Settings → AI Tags → download the model
  → enable "Suggest new tags" → **Scan** → approve a candidate → analyze a matching
  track → click a green **new** chip → confirm the tag writes to the file's Comment
  frame, is filed in the candidate's group, and the candidate doesn't reappear.
  Report anything off.

## To Do

_Non-blocking — do when convenient._

- [X] (2026-07-23) Manually smoke-test the Show/Hide Missing Tracks toggle: count matches dimmed rows, toggling hides/shows missing rows, disabled+dimmed at "0 missing", composes with search, and persists across an app restart.
- [ ] (2026-07-24) **Smoke-test the reworked track drag-and-drop.** In a playlist in **manual order** (default, or click the **#** column so it's ascending): (1) drag a track **up/down** — it should **reorder** every time, never jump to "added to a playlist"; drop below the last row → moves to the end. (2) Drag a track toward the **right edge** of a wide (horizontally scrollable) table — the list should **not** scroll sideways. (3) Drag a track onto a **sidebar playlist** and onto the **Build** panel — each should show a dashed "hold to add…" outline, turn solid after a brief hold, then **add** on release; **release before the hold** → nothing happens. (4) **Sorted view**: click a content column (e.g. BPM) to sort, then drag a track up/down — reordering should be disabled and a subtle "manual order" **toast** should appear; clicking **#** returns to manual order and reordering works again. (5) Confirm a multi-selection still adds the whole selection, ⌘Z still undoes an add, ⌥-drag still drags files out, and **column reordering** still auto-scrolls a wide table sideways.
- [ ] (2026-07-11) **Data-loss risk review — decisions needed.** From the file/data-loss audit. Decide:
  (a) should `DeletionBehavior::Remove` stay selectable at all, or become opt-in-behind-a-warning with **Ask** as the hard default? (b) the mass-deletion safety threshold value — what fraction/count of linked tracks vanishing in one sync should trip the abort-and-review guard (e.g. >10% or >50 tracks)? ~~(c) for "Move" import, prefer deleting originals vs. moving them to Trash (recoverable)?~~ **Resolved 2026-07-12 → move to Trash (#3 fix shipped).**
- [ ] (2026-07-11) **Manual test once #1 lands:** with a large linked library, quit Music.app mid-sync / open an empty or still-loading library and run a sync — confirm TagDeck **aborts the removal phase** and logs a warning instead of purging tracks. Then confirm a *genuine* small deletion in Music.app still reconciles normally.
- [ ] (2026-07-11) **Manual test the iTunes comment read-merge (#2 fix).** In Two-way mode with a linked track: (1) in Music.app, type a note in the track's **Comments** field; (2) in TagDeck, add or remove a tag on that track; (3) confirm the Music.app comment now reads `your note && …tags…` — your note is intact, not replaced. Then (4) edit the note itself via TagDeck's **comment column** and confirm that change *does* push to Music.app.
- [X] (2026-07-12) **Manual test undo of a playlist-track removal.** ✅ Confirmed by Jordan 2026-07-12.
- [X] (2026-07-12) **Manual test undo of rating changes + playlist deletion.** ✅ Confirmed by Jordan 2026-07-12 (checkpoint 1).
- [ ] (2026-07-12) **Manual test the rest of the expanded undo (checkpoint 2).** With ⌘Z after each: (1) **rename** a playlist → name reverts; (2) **move** a playlist into/out of a folder → it returns to the old parent; (3) **drag-reorder tracks** in a playlist → old order returns (⌘⇧Z re-applies); (4) **reorder the sidebar** → old order returns; (5) **delete a tag** in Settings → AI/Tags → it reappears in its group; (6) **delete a tag group** → it reappears and its tags re-associate. For a **synced** playlist, confirm rename and track-reorder undo also reflect in Music.app. Toasts should name each action (e.g. "Undo Rename Playlist"). Remove a track from the **middle** of a playlist (Delete/Backspace, the Build tab's remove, or right-click), press **⌘Z** — confirm the track returns to its **original position** (not the bottom), and the toast reads "Undo Remove from Playlist". **⌘⇧Z** should remove it again. Repeat on an **iTunes-synced** playlist and confirm the track reappears in Music.app too (its Music.app position may differ; membership is what matters). Also confirm ⌘Z on an empty undo stack no longer flashes a success toast.
- [ ] (2026-07-12) **Manual test safe playlist reorder (#4 fix).** In Two-way mode, drag-reorder a synced playlist and confirm Music.app shows the new order with the **same track count** (nothing dropped). Then reorder a playlist that contains a track you've since removed from Music.app — confirm the reorder is refused and logged (WARN) rather than silently shrinking the playlist.
- [ ] (2026-07-12) **Smoke-test tag writes still work after the atomic-write change (#5 fix).** Add/remove a tag on a track and edit a track's title/artist via the inline editor; confirm the change sticks (reopen or re-read) and the file still plays. No `.tagdeck-writing` files should be left next to your audio files.
- [ ] (2026-07-12) **Manual test the "Move" import safety (#3 fix).** In Settings → Library, switch import mode to **Move** — confirm the warning dialog appears and the label reads "deletes originals". Drag in an audio file: confirm it lands in your library folder, plays, and the **original file is in the Trash** (recoverable), not gone. Then switch back to Copy — no dialog should appear.
- [ ] (2026-07-11) **Back up your own TagDeck DB before dogfooding sync** (tags/ratings/playlist membership live only in TagDeck and are not recoverable if a bad sync purges them). Location: the app's data dir SQLite file.
- [ ] (2026-07-09) Verify single-track Suggested Tags progress bar: pick an un-analyzed track, click "Suggest tags", confirm phases advance and the bar fills during audio windows, then suggestions render. Repeat on a first-ever analysis to see "Preparing tags…".
- [X] (2026-07-09) **Smoke-test the Playlist Builder (Build tab).** `npm run tauri dev` → right-click a playlist → **Build this Playlist** (Build tab opens, header shows count + total time). Then: add via the row **+**, by dragging onto the panel, and via right-click → **Add to "…"** (try a multi-selection); confirm added rows show a check and count/time update. In the panel, reorder by drag, remove a track, double-click to play. Also set a target via the in-tab picker search and via **New playlist**. Confirm Spotify playlists don't offer "Build this Playlist" and an iTunes-synced target reflects the change in Music.app. **⌘Z** should undo an add.

## Done

_Recently finished. Trim when this grows long._

- [X] (2026-07-08) **Test the keyboard media keys.** Confirmed working by Jordan.
