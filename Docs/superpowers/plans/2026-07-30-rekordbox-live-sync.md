# Rekordbox Live Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a fixed `rekordbox.xml` continuously current in the background so the user sets up the bridge once and thereafter only hits reload in Rekordbox — a direct replacement for the TagDeck → iTunes → Rekordbox hop.

**Architecture:** A dirty-signal + debounced background thread (modeled on `library_watcher.rs`) rebuilds the XML via the existing pure `build_rekordbox_xml`, writes it atomically, skips writes when unchanged, and reports status to the UI. Library-mutation commands "ping" the signal. The exporter gains BitRate + Grouping and keeps AverageBpm.

**Tech Stack:** Rust (Tauri v2, rusqlite, std threads + `mpsc`), React + TypeScript, vitest.

## Global Constraints

- **One-way bridge only.** Never read from or write Rekordbox's `master.db`. (from spec)
- **Never hold the DB lock across a file write.** Snapshot tracks/playlists under the lock, drop it, then build + write. (from spec)
- **Atomic writes for every `rekordbox.xml` write** — temp file in the same directory + `std::fs::rename`. Rekordbox must never read a half-written file. Applies to the live flush AND the existing manual export. (from spec)
- **Missing tracks excluded** from the collection and playlist entries (existing `build_rekordbox_xml` behavior — do not change). (from spec)
- **`BitRate`**: emit only when `> 0`, in **kbps**, directly from `track.bit_rate` (already kbps) — no conversion. (from spec)
- **`AverageBpm`**: emit only when `bpm > 0` (unchanged guard). (from spec)
- **`Grouping`**: emit `track.grouping_raw` verbatim only when non-empty. (from spec)
- **Tags ride in `Comments`** (existing contract) — unchanged. (from spec)
- **Defaults:** debounce **3s** (range 1–15), backstop flush every **5 min**, default path `~/Music/TagDeck/rekordbox.xml`. (from spec)
- **Config** via the KV table (`db.set_config`/`get_config`): keys `rekordbox_live_enabled`, `rekordbox_xml_path` (existing), `rekordbox_debounce_secs`. (from spec)
- **Rust tests:** colocated `#[cfg(test)] mod tests`, run with `cargo test` from `src-tauri/`. **Frontend tests:** vitest, colocated `*.test.ts`, pure-logic style (no component-render harness exists).
- **Line numbers in this plan are from the spec-time snapshot** and may have shifted (another agent is editing `commands.rs`). Relocate every edit by **function/symbol name**, not line number.

---

### Task 1: Exporter — add BitRate + Grouping, keep AverageBpm

**Files:**
- Modify: `src-tauri/src/rekordbox.rs` (`build_rekordbox_xml`, ~line 44–72; tests ~line 209–307)

**Interfaces:**
- Consumes: `Track { bit_rate: i64, grouping_raw: Option<String>, bpm: i64, .. }` (`models.rs`)
- Produces: `build_rekordbox_xml(tracks, playlists, app_version) -> (String, RekordboxStats)` — signature UNCHANGED; output now includes `BitRate` and `Grouping` attributes.

- [ ] **Step 1: Write the failing test.** Add to `rekordbox.rs`'s `mod tests`:

```rust
#[test]
fn emits_bitrate_and_grouping() {
    let mut t = track(1, "One", "/x/one.mp3");
    t.bit_rate = 320;
    t.grouping_raw = Some("Warmup".to_string());
    let playlists = vec![(playlist(11, "P1", "Set", false, None), vec![1])];
    let (xml, _) = build_rekordbox_xml(&[t], &playlists, "0.0.0");
    assert!(xml.contains("BitRate=\"320\""));
    assert!(xml.contains("Grouping=\"Warmup\""));
    assert!(xml.contains("AverageBpm=\"128.00\"")); // bpm kept
}

#[test]
fn omits_bitrate_and_grouping_when_absent() {
    let mut t = track(1, "One", "/x/one.mp3");
    t.bit_rate = 0;
    t.grouping_raw = None;
    let (xml, _) = build_rekordbox_xml(&[t], &[], "0.0.0");
    assert!(!xml.contains("BitRate="));
    assert!(!xml.contains("Grouping="));
}
```

- [ ] **Step 2: Run to verify it fails.** `cd src-tauri && cargo test rekordbox::tests::emits_bitrate_and_grouping` → FAIL (`BitRate` not in output).

- [ ] **Step 3: Implement.** In `build_rekordbox_xml`, right after the `AverageBpm` block (~line 62), add:

```rust
if t.bit_rate > 0 {
    push_attr(&mut xml, "BitRate", &t.bit_rate.to_string());
}
if let Some(g) = t.grouping_raw.as_deref() {
    if !g.is_empty() {
        push_attr(&mut xml, "Grouping", g);
    }
}
```

- [ ] **Step 4: Run tests.** `cargo test rekordbox` → PASS (new tests + existing ones).

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/rekordbox.rs
git commit -m "feat(rekordbox): export BitRate (kbps) and Grouping"
```

---

### Task 2: Generic atomic file write

**Files:**
- Create: `src-tauri/src/fs_atomic.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod fs_atomic;` near the other `mod` declarations)
- Modify: `src-tauri/src/commands.rs` (`export_rekordbox_xml`, ~line 3117 — switch `std::fs::write` to the helper)

**Interfaces:**
- Produces: `fs_atomic::atomic_write(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()>` — creates parent dirs, writes to a sibling temp, renames over `path`; on error removes the temp and leaves `path` untouched.

- [ ] **Step 1: Write the failing test.** Create `src-tauri/src/fs_atomic.rs`:

```rust
//! Atomic file writes: write to a temp file in the same directory, then
//! rename over the destination, so readers (e.g. Rekordbox) never observe a
//! half-written file.

use std::io;
use std::path::Path;

pub fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp = path.with_extension("tagdeck-writing");
    match std::fs::write(&tmp, contents).and_then(|_| std::fs::rename(&tmp, path)) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_overwrites_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("tagdeck-aw-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("out.xml");

        atomic_write(&f, b"one").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"one");

        atomic_write(&f, b"two").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"two");

        assert!(!f.with_extension("tagdeck-writing").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 2: Register the module.** In `lib.rs`, add `mod fs_atomic;` with the other module declarations.

- [ ] **Step 3: Run to verify it passes.** `cd src-tauri && cargo test fs_atomic` → PASS.

- [ ] **Step 4: Switch the manual export to atomic write.** In `commands.rs::export_rekordbox_xml`, replace:

```rust
std::fs::write(&dest_path, xml)
    .map_err(|e| format!("Failed to write {}: {}", dest_path, e))?;
```
with:
```rust
crate::fs_atomic::atomic_write(std::path::Path::new(&dest_path), xml.as_bytes())
    .map_err(|e| format!("Failed to write {}: {}", dest_path, e))?;
```

- [ ] **Step 5: Build + commit.** `cargo build` → OK.

```bash
git add src-tauri/src/fs_atomic.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "feat(fs): atomic_write helper; use it for rekordbox export"
```

---

### Task 3: Dirty signal + sync status types

**Files:**
- Create: `src-tauri/src/rekordbox_sync.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod rekordbox_sync;`)

**Interfaces:**
- Produces:
  - `RekordboxDirtySignal::new() -> (RekordboxDirtySignal, std::sync::mpsc::Receiver<()>)`, `.mark(&self)` (non-blocking), derives `Clone`.
  - `RekordboxSyncStatus { state: String, last_written_at: Option<i64>, last_error: Option<String>, tracks: usize, playlists: usize }`, derives `Clone, Serialize, Default` (Default → `state: "disabled"`). `state` ∈ `"disabled" | "up_to_date" | "pending" | "writing" | "error"`.

- [ ] **Step 1: Write the failing test.** Create `src-tauri/src/rekordbox_sync.rs`:

```rust
//! Background "Rekordbox Live Sync": keeps a fixed rekordbox.xml current.

use serde::Serialize;
use std::sync::mpsc::{channel, Receiver, Sender};

#[derive(Clone)]
pub struct RekordboxDirtySignal {
    tx: Sender<()>,
}

impl RekordboxDirtySignal {
    pub fn new() -> (Self, Receiver<()>) {
        let (tx, rx) = channel();
        (Self { tx }, rx)
    }
    /// Non-blocking ping; a dropped receiver is ignored.
    pub fn mark(&self) {
        let _ = self.tx.send(());
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RekordboxSyncStatus {
    pub state: String,
    pub last_written_at: Option<i64>,
    pub last_error: Option<String>,
    pub tracks: usize,
    pub playlists: usize,
}

impl Default for RekordboxSyncStatus {
    fn default() -> Self {
        Self {
            state: "disabled".to_string(),
            last_written_at: None,
            last_error: None,
            tracks: 0,
            playlists: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_delivers_ping() {
        let (sig, rx) = RekordboxDirtySignal::new();
        sig.mark();
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn status_defaults_to_disabled() {
        assert_eq!(RekordboxSyncStatus::default().state, "disabled");
    }
}
```

- [ ] **Step 2: Register + run.** Add `mod rekordbox_sync;` to `lib.rs`. `cd src-tauri && cargo test rekordbox_sync` → PASS.

- [ ] **Step 3: Commit.**

```bash
git add src-tauri/src/rekordbox_sync.rs src-tauri/src/lib.rs
git commit -m "feat(rekordbox): dirty signal + sync status types"
```

---

### Task 4: `flush_once` — build, skip-if-unchanged, atomic write

**Files:**
- Modify: `src-tauri/src/rekordbox_sync.rs`

**Interfaces:**
- Consumes: `build_rekordbox_xml` (Task 1), `fs_atomic::atomic_write` (Task 2), `Track`, `Playlist`.
- Produces:
  - `enum FlushOutcome { Written { tracks: usize, playlists: usize }, Unchanged, Error(String) }`
  - `flush_once(app_version: &str, tracks: &[Track], playlists: &[(Playlist, Vec<i64>)], dest: &std::path::Path, last_hash: &mut Option<u64>) -> FlushOutcome`

- [ ] **Step 1: Write the failing test.** Append to `rekordbox_sync.rs`'s `mod tests` (add `use crate::models::{Playlist, Track};` and small local `track`/`playlist` constructors, or reuse patterns from `rekordbox.rs` tests):

```rust
#[test]
fn flush_writes_then_skips_when_unchanged() {
    let dir = std::env::temp_dir().join(format!("tagdeck-flush-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let dest = dir.join("rekordbox.xml");

    let tracks = vec![mk_track(1, "/x/one.mp3")];
    let playlists = vec![(mk_playlist(11, "Set"), vec![1])];
    let mut last: Option<u64> = None;

    match flush_once("0.0.0", &tracks, &playlists, &dest, &mut last) {
        FlushOutcome::Written { tracks, playlists } => {
            assert_eq!(tracks, 1);
            assert_eq!(playlists, 1);
        }
        _ => panic!("expected Written"),
    }
    assert!(dest.exists());
    assert!(last.is_some());

    // Same inputs → no rewrite.
    assert!(matches!(
        flush_once("0.0.0", &tracks, &playlists, &dest, &mut last),
        FlushOutcome::Unchanged
    ));

    let _ = std::fs::remove_dir_all(&dir);
}
```

(Provide `mk_track`/`mk_playlist` test helpers mirroring the full `Track`/`Playlist` literals in `rekordbox.rs`'s tests.)

- [ ] **Step 2: Run to verify it fails.** `cargo test rekordbox_sync::tests::flush_writes_then_skips` → FAIL (`flush_once` undefined).

- [ ] **Step 3: Implement.** Add to `rekordbox_sync.rs`:

```rust
use crate::models::{Playlist, Track};
use std::path::Path;

pub enum FlushOutcome {
    Written { tracks: usize, playlists: usize },
    Unchanged,
    Error(String),
}

fn hash_str(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// Build the XML and write it atomically to `dest` only if it changed since
/// the last write. Callers pass an already-collected snapshot — this never
/// touches the DB lock.
pub fn flush_once(
    app_version: &str,
    tracks: &[Track],
    playlists: &[(Playlist, Vec<i64>)],
    dest: &Path,
    last_hash: &mut Option<u64>,
) -> FlushOutcome {
    let (xml, stats) = crate::rekordbox::build_rekordbox_xml(tracks, playlists, app_version);
    let h = hash_str(&xml);
    if *last_hash == Some(h) {
        return FlushOutcome::Unchanged;
    }
    match crate::fs_atomic::atomic_write(dest, xml.as_bytes()) {
        Ok(()) => {
            *last_hash = Some(h);
            FlushOutcome::Written {
                tracks: stats.tracks,
                playlists: stats.playlists,
            }
        }
        Err(e) => FlushOutcome::Error(format!("Failed to write {}: {}", dest.display(), e)),
    }
}
```

- [ ] **Step 4: Run tests.** `cargo test rekordbox_sync` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/rekordbox_sync.rs
git commit -m "feat(rekordbox): flush_once with skip-if-unchanged + atomic write"
```

---

### Task 5: Config accessors + Tauri commands

**Files:**
- Modify: `src-tauri/src/rekordbox_sync.rs` (config helpers + commands)
- Modify: `src-tauri/src/lib.rs` (register commands in `generate_handler!`)
- Modify: `src-tauri/src/commands.rs` (`AppState` gains two fields — see Task 6 for the struct edit; commands here read `State<AppState>`)

**Interfaces:**
- Produces (Tauri commands):
  - `get_rekordbox_live_config(state) -> RekordboxLiveConfig { enabled: bool, path: Option<String>, debounce_secs: u64 }`
  - `set_rekordbox_live_enabled(state, enabled: bool) -> Result<(), String>` (marks dirty on enable so the first write happens immediately)
  - `set_rekordbox_live_path(state, path: String) -> Result<(), String>` (writes `rekordbox_xml_path`, marks dirty)
  - `set_rekordbox_debounce_secs(state, secs: u64) -> Result<(), String>` (clamps 1–15)
  - `get_rekordbox_sync_status(state) -> RekordboxSyncStatus`
- Helper fns (used by the thread in Task 6): `read_live_config(&Database) -> RekordboxLiveConfig`.

- [ ] **Step 1: Write the failing test** for the clamp helper:

```rust
#[test]
fn debounce_clamps_to_range() {
    assert_eq!(clamp_debounce(0), 1);
    assert_eq!(clamp_debounce(3), 3);
    assert_eq!(clamp_debounce(999), 15);
}
```

- [ ] **Step 2: Run → FAIL** (`clamp_debounce` undefined).

- [ ] **Step 3: Implement config + commands.** Add to `rekordbox_sync.rs`:

```rust
use crate::commands::AppState;
use crate::db::Database;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
pub struct RekordboxLiveConfig {
    pub enabled: bool,
    pub path: Option<String>,
    pub debounce_secs: u64,
}

pub fn clamp_debounce(secs: u64) -> u64 {
    secs.clamp(1, 15)
}

pub fn read_live_config(db: &Database) -> RekordboxLiveConfig {
    let enabled = db.get_config("rekordbox_live_enabled").ok().flatten().as_deref() == Some("true");
    let path = db.get_config("rekordbox_xml_path").ok().flatten();
    let debounce_secs = db
        .get_config("rekordbox_debounce_secs")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u64>().ok())
        .map(clamp_debounce)
        .unwrap_or(3);
    RekordboxLiveConfig { enabled, path, debounce_secs }
}

#[tauri::command]
pub fn get_rekordbox_live_config(state: State<AppState>) -> Result<RekordboxLiveConfig, String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    Ok(read_live_config(&db))
}

#[tauri::command]
pub fn set_rekordbox_live_enabled(state: State<AppState>, enabled: bool) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.set_config("rekordbox_live_enabled", if enabled { "true" } else { "false" })
            .map_err(|e| e.to_string())?;
    }
    if enabled {
        state.rekordbox_dirty.mark();
    }
    Ok(())
}

#[tauri::command]
pub fn set_rekordbox_live_path(state: State<AppState>, path: String) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
        db.set_config("rekordbox_xml_path", &path).map_err(|e| e.to_string())?;
    }
    state.rekordbox_dirty.mark();
    Ok(())
}

#[tauri::command]
pub fn set_rekordbox_debounce_secs(state: State<AppState>, secs: u64) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Failed to lock DB".to_string())?;
    db.set_config("rekordbox_debounce_secs", &clamp_debounce(secs).to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_rekordbox_sync_status(state: State<AppState>) -> RekordboxSyncStatus {
    state
        .rekordbox_status
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}
```

- [ ] **Step 4: Register commands.** In `lib.rs` `generate_handler!`, add: `rekordbox_sync::get_rekordbox_live_config, rekordbox_sync::set_rekordbox_live_enabled, rekordbox_sync::set_rekordbox_live_path, rekordbox_sync::set_rekordbox_debounce_secs, rekordbox_sync::get_rekordbox_sync_status`. (Task 6 adds the AppState fields these depend on; if building this task alone, do the AppState struct edit from Task 6 first.)

- [ ] **Step 5: Run + build + commit.** `cargo test rekordbox_sync` → PASS; `cargo build` → OK.

```bash
git add src-tauri/src/rekordbox_sync.rs src-tauri/src/lib.rs
git commit -m "feat(rekordbox): live-sync config accessors + Tauri commands"
```

---

### Task 6: Wire AppState + start the flush thread + quit flush

**Files:**
- Modify: `src-tauri/src/commands.rs` (`AppState` struct, ~line 20–24)
- Modify: `src-tauri/src/rekordbox_sync.rs` (the thread: `start_rekordbox_sync`, `settle`)
- Modify: `src-tauri/src/lib.rs` (build the signal, manage AppState, spawn the thread, add exit flush)

**Interfaces:**
- Consumes: `RekordboxDirtySignal`, `RekordboxSyncStatus`, `read_live_config`, `flush_once`.
- Produces: `start_rekordbox_sync(app: tauri::AppHandle, rx: std::sync::mpsc::Receiver<()>)`; `AppState.rekordbox_dirty: RekordboxDirtySignal`, `AppState.rekordbox_status: std::sync::Mutex<RekordboxSyncStatus>`.

- [ ] **Step 1: Extend `AppState`.** In `commands.rs`:

```rust
pub struct AppState {
    pub db: Mutex<Database>,
    pub undo_stack: Mutex<UndoStack>,
    pub is_syncing: AtomicBool,
    pub rekordbox_dirty: crate::rekordbox_sync::RekordboxDirtySignal,
    pub rekordbox_status: Mutex<crate::rekordbox_sync::RekordboxSyncStatus>,
}
```

- [ ] **Step 2: Implement the thread + settle.** Add to `rekordbox_sync.rs`:

```rust
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const BACKSTOP: Duration = Duration::from_secs(300);

fn set_status(app: &AppHandle, status: RekordboxSyncStatus) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut s) = state.rekordbox_status.lock() {
            *s = status.clone();
        }
    }
    let _ = app.emit("rekordbox-sync-status", status);
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// One settle: read config; if enabled+path, snapshot the DB (lock → copy →
/// drop), build+write via flush_once, and publish status.
fn settle(app: &AppHandle, last_hash: &mut Option<u64>) {
    let state = match app.try_state::<AppState>() {
        Some(s) => s,
        None => return,
    };

    let (cfg, snapshot) = {
        let db = match state.db.lock() {
            Ok(db) => db,
            Err(_) => return,
        };
        let cfg = read_live_config(&db);
        if !cfg.enabled || cfg.path.is_none() {
            drop(db);
            set_status(app, RekordboxSyncStatus::default()); // "disabled"
            return;
        }
        let tracks: Vec<_> = db
            .get_all_tracks()
            .unwrap_or_default()
            .into_iter()
            .filter(|t| !t.is_ghost())
            .collect();
        let playlists: Vec<_> = db
            .get_playlists()
            .unwrap_or_default()
            .into_iter()
            .map(|p| {
                let ids = db.get_playlist_track_ids(p.id).unwrap_or_default();
                (p, ids)
            })
            .collect();
        (cfg, (tracks, playlists))
    }; // DB lock dropped here

    let path = cfg.path.unwrap();
    set_status(app, RekordboxSyncStatus {
        state: "writing".to_string(),
        last_written_at: None,
        last_error: None,
        tracks: snapshot.0.len(),
        playlists: 0,
    });

    let outcome = flush_once(
        env!("CARGO_PKG_VERSION"),
        &snapshot.0,
        &snapshot.1,
        std::path::Path::new(&path),
        last_hash,
    );

    let status = match outcome {
        FlushOutcome::Written { tracks, playlists } | FlushOutcome::Unchanged
            if matches!(outcome, FlushOutcome::Unchanged) =>
        {
            // Unchanged: keep prior counts but mark up_to_date.
            RekordboxSyncStatus {
                state: "up_to_date".to_string(),
                last_written_at: Some(now_secs()),
                last_error: None,
                tracks,
                playlists,
            }
        }
        FlushOutcome::Written { tracks, playlists } => RekordboxSyncStatus {
            state: "up_to_date".to_string(),
            last_written_at: Some(now_secs()),
            last_error: None,
            tracks,
            playlists,
        },
        FlushOutcome::Unchanged => RekordboxSyncStatus {
            state: "up_to_date".to_string(),
            last_written_at: Some(now_secs()),
            last_error: None,
            tracks: snapshot.0.len(),
            playlists: snapshot.1.len(),
        },
        FlushOutcome::Error(e) => RekordboxSyncStatus {
            state: "error".to_string(),
            last_written_at: None,
            last_error: Some(e),
            tracks: 0,
            playlists: 0,
        },
    };
    set_status(app, status);
}

/// Public entry: run the debounced flush loop on a background thread.
pub fn start_rekordbox_sync(app: AppHandle, rx: Receiver<()>) {
    std::thread::spawn(move || {
        let mut last_hash: Option<u64> = None;
        loop {
            match rx.recv_timeout(BACKSTOP) {
                Ok(()) => {
                    // Debounce-drain: coalesce a burst into one settle.
                    let debounce = {
                        match app.try_state::<AppState>() {
                            Some(state) => state
                                .db
                                .lock()
                                .map(|db| Duration::from_secs(read_live_config(&db).debounce_secs))
                                .unwrap_or(Duration::from_secs(3)),
                            None => Duration::from_secs(3),
                        }
                    };
                    loop {
                        match rx.recv_timeout(debounce) {
                            Ok(()) => continue,
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    settle(&app, &mut last_hash);
                }
                Err(RecvTimeoutError::Timeout) => settle(&app, &mut last_hash), // backstop
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}
```

> Simplify the `match outcome` above during implementation — it is written verbosely to be explicit; the intent is: `Written` and `Unchanged` → `up_to_date` (with counts), `Error` → `error`. Since `outcome` is moved, compute counts before matching or match by reference.

- [ ] **Step 3: Wire in `lib.rs` setup.** Where `AppState` is currently built (~line 124), replace with:

```rust
let (rekordbox_dirty, rekordbox_rx) = rekordbox_sync::RekordboxDirtySignal::new();
app.manage(AppState {
    db: Mutex::new(db),
    undo_stack: Mutex::new(UndoStack::new()),
    is_syncing: AtomicBool::new(false),
    rekordbox_dirty,
    rekordbox_status: Mutex::new(rekordbox_sync::RekordboxSyncStatus::default()),
});
rekordbox_sync::start_rekordbox_sync(app.handle().clone(), rekordbox_rx);
```

- [ ] **Step 4: Add the quit flush.** In `lib.rs`, on the builder `.run(...)` (or `.build(...)?.run(...)`), handle exit:

```rust
.run(|app_handle, event| {
    if let tauri::RunEvent::ExitRequested { .. } = event {
        let mut last: Option<u64> = None;
        rekordbox_sync::settle(app_handle, &mut last); // best-effort final flush
    }
});
```

(Make `settle` `pub(crate)` so `lib.rs` can call it. Note: a fresh `last=None` forces one final write — acceptable at quit.)

- [ ] **Step 5: Build + commit.** `cd src-tauri && cargo build` → OK. Manual smoke (deferred to USER_TASKS): enable via a temp command call or the UI once Task 7 lands.

```bash
git add src-tauri/src/commands.rs src-tauri/src/rekordbox_sync.rs src-tauri/src/lib.rs
git commit -m "feat(rekordbox): live-sync flush thread + AppState wiring + quit flush"
```

---

### Task 7: Instrument all library-mutation commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (the enumerated commands)
- Modify: `src-tauri/src/sync_review.rs` (`apply_sync_changes`)

**Interfaces:**
- Consumes: `AppState.rekordbox_dirty.mark()`.
- Produces: every library mutation pings the dirty signal.

- [ ] **Step 1: Add `state.rekordbox_dirty.mark();`** on the success path (just before the `Ok(...)` return) of each command below. **Relocate by function name** (line numbers are stale). Each command already has `state: State<AppState>`; if one doesn't, it already has `app`/`db` — mark via `app.state::<AppState>().rekordbox_dirty.mark()`.

  Playlists: `create_playlist`, `rename_playlist`, `delete_playlist`, `move_playlist`, `duplicate_playlist`, `reorder_sibling_playlists`, `update_playlist_metadata`, `set_playlist_sync`, `restore_playlist_backup`.
  Membership/order: `add_to_playlist`, `remove_from_playlist`, `reorder_playlist_tracks`, `copy_playlist_memberships`.
  Tags/comments: `write_tags`, `batch_add_tag`, `batch_remove_tag`, `update_track_info`.
  Ratings: `update_rating`.
  Imports: `import_library`, `import_from_music_app`, `import_files`, `consolidate_library`.
  Missing/reconcile: `mark_track_missing`, `verify_library_files`, `sync_recent_changes`, and `sync_review::apply_sync_changes`.
  Taxonomy: `delete_tag`, `set_tag_group`, `delete_tag_group`.

- [ ] **Step 2: Add the maintainability rule as a code comment** on the `AppState` struct (or `mark`): `// Any new library-mutating command MUST call state.rekordbox_dirty.mark() on success (feeds Rekordbox Live Sync).`

- [ ] **Step 3: Build.** `cd src-tauri && cargo build` → OK.

- [ ] **Step 4: Manual sanity (single command).** Temporarily add `eprintln!` in `settle` or watch the status; not a unit test — real coverage is the manual round-trip in Task 9. (Optional: a Rust test that constructs an `AppState` with a test channel is heavy due to `Mutex<Database>`; skip — `signal_delivers_ping` in Task 3 already covers the primitive.)

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/commands.rs src-tauri/src/sync_review.rs
git commit -m "feat(rekordbox): mark library dirty on every mutation"
```

---

### Task 8: Frontend — status formatter + Live Sync panel

**Files:**
- Create: `src/components/settings/rekordboxStatus.ts` (pure helper)
- Create: `src/components/settings/rekordboxStatus.test.ts` (vitest)
- Create: `src/components/settings/RekordboxLiveSync.tsx` (panel component)
- Modify: `src/components/settings/ExportTab.tsx` (render `<RekordboxLiveSync />`)

**Interfaces:**
- Consumes commands: `get_rekordbox_live_config`, `set_rekordbox_live_enabled`, `set_rekordbox_live_path`, `set_rekordbox_debounce_secs`, `get_rekordbox_sync_status`; event `rekordbox-sync-status`.
- Produces: `formatRekordboxStatus(status: RekordboxSyncStatus, nowSecs: number) -> string`.

- [ ] **Step 1: Write the failing test.** Create `src/components/settings/rekordboxStatus.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatRekordboxStatus, type RekordboxSyncStatus } from './rekordboxStatus';

const base: RekordboxSyncStatus = {
  state: 'up_to_date', last_written_at: 100, last_error: null, tracks: 5, playlists: 2,
};

describe('formatRekordboxStatus', () => {
  it('shows time since last write', () => {
    expect(formatRekordboxStatus(base, 106)).toBe('Up to date · updated 6s ago');
  });
  it('handles minutes', () => {
    expect(formatRekordboxStatus(base, 100 + 180)).toBe('Up to date · updated 3m ago');
  });
  it('renders writing and error', () => {
    expect(formatRekordboxStatus({ ...base, state: 'writing' }, 100)).toBe('Saving…');
    expect(formatRekordboxStatus({ ...base, state: 'error', last_error: 'disk full' }, 100))
      .toBe('Error: disk full');
  });
  it('renders disabled', () => {
    expect(formatRekordboxStatus({ ...base, state: 'disabled' }, 100)).toBe('Off');
  });
});
```

- [ ] **Step 2: Run → FAIL.** `npm test -- rekordboxStatus` → module not found.

- [ ] **Step 3: Implement the helper.** Create `src/components/settings/rekordboxStatus.ts`:

```ts
export interface RekordboxSyncStatus {
  state: 'disabled' | 'up_to_date' | 'pending' | 'writing' | 'error';
  last_written_at: number | null;
  last_error: string | null;
  tracks: number;
  playlists: number;
}

function formatAgo(secs: number): string {
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

export function formatRekordboxStatus(s: RekordboxSyncStatus, nowSecs: number): string {
  switch (s.state) {
    case 'disabled': return 'Off';
    case 'writing': return 'Saving…';
    case 'pending': return 'Pending — updating shortly';
    case 'error': return `Error: ${s.last_error ?? 'unknown'}`;
    case 'up_to_date':
      if (s.last_written_at == null) return 'Up to date';
      return `Up to date · updated ${formatAgo(Math.max(0, nowSecs - s.last_written_at))}`;
  }
}
```

- [ ] **Step 4: Run → PASS.** `npm test -- rekordboxStatus`.

- [ ] **Step 5: Build the panel component.** Create `src/components/settings/RekordboxLiveSync.tsx` — a self-contained panel that:
  - on mount, `invoke('get_rekordbox_live_config')` and `invoke('get_rekordbox_sync_status')`;
  - subscribes to the `rekordbox-sync-status` event (`listen` from `@tauri-apps/api/event`) and updates a `status` state; a 1s interval re-renders the "updated Ns ago" label via `formatRekordboxStatus(status, Date.now()/1000)`;
  - **toggle** "Keep Rekordbox in sync" → if enabling with no path, open the save dialog (default `rekordbox.xml`), call `set_rekordbox_live_path`, then `set_rekordbox_live_enabled(true)`; else `set_rekordbox_live_enabled(false)`;
  - **path row** with a "Change…" button (save dialog → `set_rekordbox_live_path`);
  - **debounce** number input (1–15) → `set_rekordbox_debounce_secs`;
  - a collapsible **setup guide** with the exact Rekordbox steps and the "*already exists → Yes* is safe: it updates the Comment, never your cues or beat grid; no duplicates" explainer, and the note "to fully drop iTunes, set iTunes sync → Off";
  - the **status line** rendered from `formatRekordboxStatus`.
  Follow `ExportTab.tsx`'s existing styling idioms (inline styles, `var(--...)`, `useToast`, `Disc3` icon).

- [ ] **Step 6: Render it.** In `ExportTab.tsx`, import and render `<RekordboxLiveSync />` above the existing manual "Export to Rekordbox…" block (keep the manual button).

- [ ] **Step 7: Build + commit.** `npm run build` (or `npm test`) → OK.

```bash
git add src/components/settings/rekordboxStatus.ts src/components/settings/rekordboxStatus.test.ts src/components/settings/RekordboxLiveSync.tsx src/components/settings/ExportTab.tsx
git commit -m "feat(rekordbox): Live Sync settings panel + status formatter"
```

---

### Task 9: Docs + manual test checklist

**Files:**
- Modify: `Docs/reference/LibraryStrategy.md` (Rekordbox section)
- Modify: `Docs/CHANGELOG.md` (`[Unreleased]` → Added)
- Modify: `USER_TASKS.md`
- Modify: `Docs/README.md` (only if a new reference doc is added — otherwise leave)

- [ ] **Step 1: LibraryStrategy.md.** In the "Rekordbox (export bridge)" section, change the deferred line ("Deferred: auto-export-on-change toggle…") to shipped, and document: Live Sync (one-time setup, background debounced atomic write, skip-if-unchanged, backstop), the added `BitRate`/`Grouping` and kept `AverageBpm`, and the "*already exists → Yes*" guidance (safe; no duplicates; cues/grid untouched).

- [ ] **Step 2: CHANGELOG.md.** Under `[Unreleased]` → **Added**:
  `- Rekordbox Live Sync: keep a fixed rekordbox.xml current automatically (debounced, atomic); exports now include bitrate and grouping. Set up once, then just reload in Rekordbox.`

- [ ] **Step 3: USER_TASKS.md.** Add the manual-test checklist (needs live Rekordbox), dated `(2026-07-30)`:
  - Enable Live Sync, point Rekordbox at the file, edit a tag / reorder a playlist / add a track → reload in Rekordbox → change appears.
  - Confirm "*already exists → Yes*" updates the Comment and leaves memory cues + beat grid intact; no duplicate Collection entries.
  - Confirm BPM (where present), bitrate, grouping show on imported tracks.
  - Unplug the destination drive mid-session → error status, no corruption; replug → next edit recovers.

- [ ] **Step 4: Commit.**

```bash
git add Docs/reference/LibraryStrategy.md Docs/CHANGELOG.md USER_TASKS.md Docs/README.md
git commit -m "docs(rekordbox): document Live Sync; changelog + manual tests"
```

---

## Self-Review

**Spec coverage:** setup/activation → Task 8; fixed file + config → Tasks 5, 8; playlists+tags+ratings (existing) + BPM kept + bitrate + grouping → Task 1; atomic write → Task 2; dirty signal + debounce engine + skip-if-unchanged + backstop + quit flush → Tasks 3, 4, 6, 7; status line + tunable debounce → Tasks 5, 8; independence from iTunes → copy in Task 8; error handling → Tasks 2, 4, 6; genre → out of scope (fast-follow, noted). All covered.

**Placeholder scan:** the panel component (Task 8 Step 5) is described behaviorally rather than as one code block because it is glue over already-defined command/event interfaces and follows the existing `ExportTab.tsx` idiom — every command name, event name, and the status helper it depends on are concretely specified. All logic with test value (exporter attrs, atomic write, signal, flush_once, clamp, status formatter) has real code + tests.

**Type consistency:** `RekordboxSyncStatus` fields identical across Rust (`rekordbox_sync.rs`) and TS (`rekordboxStatus.ts`); `flush_once`/`FlushOutcome`/`RekordboxDirtySignal`/`read_live_config`/`clamp_debounce` signatures consistent between defining and consuming tasks; command names match between Task 5 (Rust) and Task 8 (frontend).

**Note for executor:** the `match outcome` block in Task 6 Step 2 is deliberately verbose to make intent explicit and should be simplified (compute counts before the match since `outcome` is moved). Behavior: `Written`/`Unchanged` → `up_to_date`, `Error` → `error`.
