# Mixed In Key 8 External Processing Integration

## Overview
Add a context menu option to send selected track(s) to Mixed In Key 8 for analysis, then automatically poll and reload metadata changes using the existing sync mechanism. Supports batch processing with scaled timeout handling.

## Git Branch
`feature/mixed-in-key-integration`

## Implementation Steps

### 1. Add "Send to Mixed In Key" to Context Menu
**File**: [src/components/TrackList.tsx](src/components/TrackList.tsx) (lines 702-782)

Insert a new menu item in the existing right-click context menu that appears on track selection, positioned near "Show in Finder", that triggers the MiK8 workflow for all currently selected tracks.

**Requirements**:
- Only show when tracks are selected
- Place logically with other file operations
- Handle both single and multiple track selections
- Show count in label when multiple tracks selected (e.g., "Send 5 Tracks to Mixed In Key")

### 2. Create `send_to_mixed_in_key` Tauri Command
**File**: [src-tauri/src/commands.rs](src-tauri/src/commands.rs)

Add a Rust command following the pattern of `show_in_finder` that:
- Accepts `Vec<String>` of file paths and `Vec<i64>` of track IDs
- Validates `/Applications/Mixed In Key 8.app` exists before attempting launch
- Returns helpful error if MiK8 not installed: "Mixed In Key 8 not found. Please install from https://mixedinkey.com/"
- Validates each file exists before processing
- Launches `open -a "Mixed In Key 8"` with all file paths as arguments for batch processing
- Logs the action with track count
- Returns `Result<Vec<i64>, String>` with list of successfully sent track IDs

**App Detection**:
```rust
#[cfg(target_os = "macos")]
{
    let mik8_path = "/Applications/Mixed In Key 8.app";
    if !std::path::Path::new(mik8_path).exists() {
        return Err("Mixed In Key 8 not found. Please install from https://mixedinkey.com/".to_string());
    }
}
```

### 3. Implement Polling Service with Modification Time Tracking
**File**: [src/components/TagDeck.tsx](src/components/TagDeck.tsx)

Create a state-based polling system that:
- Maintains a `processingTracks` state: `Map<trackId, { startTime, originalModTime }>`
- When tracks sent to MiK8, store their current file modification time
- Start polling interval at 2-second intervals
- On each poll cycle:
  - Check file modification time via new Tauri command `get_file_mod_time`
  - Only call `refreshTracks()` for tracks whose mod time has changed
  - Remove track from processing set when metadata updated
- Calculate timeout: `10 seconds + (15 seconds × number of tracks in batch)`
- Clear polling and show timeout message if expired
- Stop polling when all tracks processed or timeout reached

**Polling Logic**:
```typescript
// Pseudo-code structure
const processingTracks = new Map<number, { 
  startTime: number, 
  originalModTime: number 
}>();

// When sending to MiK8
const trackIds = selectedTracks.map(t => t.id);
const modTimes = await invoke('get_file_mod_times', { 
  filePaths: selectedTracks.map(t => t.file_path) 
});

trackIds.forEach((id, idx) => {
  processingTracks.set(id, {
    startTime: Date.now(),
    originalModTime: modTimes[idx]
  });
});

// Polling interval
const checkInterval = setInterval(async () => {
  const timeout = 10000 + (processingTracks.size * 15000);
  const now = Date.now();
  
  for (const [trackId, data] of processingTracks) {
    // Check if expired
    if (now - data.startTime > timeout) {
      processingTracks.delete(trackId);
      continue;
    }
    
    // Check mod time
    const currentModTime = await invoke('get_file_mod_time', { 
      filePath: trackFilePath 
    });
    
    if (currentModTime > data.originalModTime) {
      await refreshTracks([trackId]);
      processingTracks.delete(trackId);
      showToast('Metadata updated from Mixed In Key');
    }
  }
  
  // Stop polling when done
  if (processingTracks.size === 0) {
    clearInterval(checkInterval);
  }
}, 2000);
```

### 4. Add `get_file_mod_time` Helper Command
**File**: [src-tauri/src/commands.rs](src-tauri/src/commands.rs)

Create utility command to retrieve file modification times without full metadata read:

```rust
#[tauri::command]
pub fn get_file_mod_time(file_path: String) -> Result<u64, String> {
    use std::fs;
    use std::time::SystemTime;
    
    let metadata = fs::metadata(&file_path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    
    let modified = metadata.modified()
        .map_err(|e| format!("Failed to get modification time: {}", e))?;
    
    let duration = modified.duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| format!("Invalid modification time: {}", e))?;
    
    Ok(duration.as_secs())
}

#[tauri::command]
pub fn get_file_mod_times(file_paths: Vec<String>) -> Result<Vec<u64>, String> {
    file_paths.into_iter()
        .map(|path| get_file_mod_time(path))
        .collect()
}
```

### 5. Register Commands in Handler
**File**: [src-tauri/src/lib.rs](src-tauri/src/lib.rs)

Add to `invoke_handler`:
- `send_to_mixed_in_key`
- `get_file_mod_time`
- `get_file_mod_times`

### 6. UI Feedback and Error Handling
**Files**: [src/components/TrackList.tsx](src/components/TrackList.tsx), [src/components/TagDeck.tsx](src/components/TagDeck.tsx)

Implement:
- **Initial toast**: "Sent 3 tracks to Mixed In Key 8" (show count)
- **Processing indicator**: Subtle visual indicator on track rows during polling (e.g., pulsing icon, color change)
- **Success toast**: "Metadata updated for [Track Name]" when changes detected
- **Timeout message**: "Mixed In Key processing timed out for 2 tracks" if polling expires
- **Error handling**: 
  - MiK8 not installed: Show error toast with installation link
  - File not found: Skip missing files, continue with valid ones
  - Launch failure: Show OS-level error message

### 7. Metadata Merge Strategy
**Approach**: Auto-merge without prompting

When `refreshTracks()` is called after MiK8 processing:
- Use existing `get_track_info` command which reads metadata from file
- MiK8 writes to fields like:
  - Key (e.g., "8A", "Cm") → usually in Comment or Grouping field
  - BPM → overwrites existing BPM
  - Energy → custom field
- TagDeck's existing metadata read logic will automatically pick up changes
- No special parsing needed - just re-read the file as we do on load/sync
- Display updated values in UI immediately

**No conflict resolution needed** - simply accept whatever MiK8 wrote to the file.

## Testing Checklist

- [ ] Context menu appears on track selection
- [ ] Menu item shows correct count for multiple tracks
- [ ] MiK8 app detection works (shows error when app missing)
- [ ] MiK8 launches with selected track(s)
- [ ] File mod time tracking initializes correctly
- [ ] Polling starts after sending tracks
- [ ] Metadata refresh triggers only when mod time changes
- [ ] Processing indicator appears on affected tracks
- [ ] Success toast shows when metadata updated
- [ ] Timeout expires correctly (10s + 15s per track)
- [ ] Polling stops when all tracks processed
- [ ] Batch processing works with 5+ tracks
- [ ] Error handling for missing files
- [ ] UI updates with new BPM/key values after processing

## Future Enhancements (Not in Scope)

1. **Progress bar**: Visual progress for batch processing
2. **Queue management**: Pause/cancel ongoing processing
3. **Preferences**: Configure MiK8 path for non-standard installations
4. **Other apps**: Extend pattern to support other audio analysis tools (iZotope RX, etc.)
5. **Metadata field mapping**: User preference for which field to use for key detection
6. **Diff view**: Show before/after comparison of metadata changes
