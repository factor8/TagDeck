# Metadata Synchronization Strategy

## Problem
Modifying file metadata tags (ID3, etc.) externally via TagDeck is not immediately reflected in library applications like Rekordbox or Apple Music (iTunes). These applications maintain internal databases that cache metadata and do not constantly monitor files for changes.

## Solutions for Rekordbox

### 1. The "Right-Click Reload" (Current Manual Workaround)
*   **Method:** User right-clicks track(s) -> "Reload Tag".
*   **Pros:** Safe, built-in.
*   **Cons:** Tedious, manual.

### 2. XML Bridge (Industry Standard)
*   **Method:**
    1. TagDeck generates a `rekordbox.xml` file containing the updated tracks.
    2. User typically has to select "Update Collection" or "Import Playlist" from the XML tab in Rekordbox.
*   **Pros:** Safe, documented supported workflow.
*   **Cons:** Still requires user interaction (Settings -> View -> Layout -> Tree View -> ensure XML is enabled, then Refresh XML).

### 3. Keyboard Macro / Accessibility API
*   **Method:** Use macOS Accessibility API to simulate right-clicking selected tracks and hitting "Reload Tag".
*   **Pros:** "Magical" automatic feel.
*   **Cons:** Fragile. Breaks if Rekordbox UI changes. Requires Accessibility permissions.

### 4. Direct Database Modification
*   **Method:** Reverse engineer and write directly to `master.db` (SQLite).
*   **Pros:** Instant, seamless.
*   **Cons:** **Extremely Dangerous**. Schema changes between versions. Can corrupt library. Rekordbox 6+ encrypts parts of the DB. **Not recommended.**

---

## Solutions for Apple Music (iTunes)

### 1. AppleScript `refresh`
*   **Method:** Send command `tell application "Music" to refresh track ...`
*   **Status:** Mixed results. Sometimes requires the track to be selected or currently playing.

### 2. AppleScript `update` property hack
*   **Method:** Scripts that force a re-read by toggling a dummy property (e.g. changing the "played count" or "rating" and changing it back) sometimes trigger a full re-read.

### 3. Folder Watching / Re-Import
*   **Method:** Create a workflow where files are "moved" or "touched" in a way that forces Music.app to notice the file system event.
*   **Cons:** Unreliable on modern macOS versions.

---

## Recommended Strategy for TagDeck

**Phase 1: Hybrid Approach**
1.  **TagDeck Updates File**: Write ID3 tags directly (Golden Source).
2.  **Apple Music**: Use AppleScript to force refresh immediately after write.
3.  **Rekordbox**:
    *   **Primary:** Generate an `Import_to_Rekordbox.xml` of the session's tagged tracks.
    *   **Secondary:** Investigate keyboard shortcut helper to trigger "Reload Tag".

## Metadata Format for Compatibility
To ensure data visibility across all platforms, we are moving to a **Delimited Comment** strategy.

**Format:**
`{Original User Comment} && {TagDeck Tags}`

**Example:**
`Great opener for sunset set && Energetic; Vocals; Ethereal`

**Parser Logic:**
1. Read Comment.
2. Split by ` && `.
3. Preserve Part 0.
4. Overwrite Part 1 with current active tags from TagDeck.
