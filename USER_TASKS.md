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

_(none)_

## Done
_Recently finished. Trim when this grows long._

_(none yet)_
