# BPM and Key Analysis Implementation Plan

## Overview
Add native BPM and musical key detection capabilities to TagDeck, allowing users to analyze tracks directly within the app without requiring external tools like Mixed In Key. Detected values can be written to file metadata and stored in the database for searching and sorting.

## Git Branch
`feature/bpm-key-analysis`

---

## Analysis Strategy Options

### Option 1: Pure Rust Implementation (Recommended)
**Pros:**
- No external dependencies
- Full control over algorithms
- Cross-platform compatibility
- Fast, efficient processing
- Can run in background threads

**Cons:**
- More complex to implement
- Need to understand DSP fundamentals
- Longer initial development time

### Option 2: External Tool Integration (Mixed In Key Style)
**Pros:**
- Leverages existing professional tools
- Proven accuracy
- Minimal code changes (follow MixedInKeyIntegration.md pattern)

**Cons:**
- User must purchase/install external software
- Platform-specific implementations
- Less integrated user experience

### Recommendation
Implement **Option 1** for BPM (simpler algorithm) and **Option 2** (Mixed In Key) for Key detection initially. Users get free basic BPM analysis built-in, with option to upgrade to professional key detection.

---

## BPM Detection Architecture

### Rust Libraries
- **`aubio-rs`** (0.3.0): Rust bindings for aubio audio analysis library
  - Proven BPM detection algorithm
  - Onset detection, tempo tracking
  - Battle-tested in DJ software
  
- **`rustfft`** (6.2.0): Fast Fourier Transform for frequency analysis
  - Required for spectral analysis
  - High-performance, pure Rust

- **`symphonia`** (0.5.4): Audio decoding
  - Decode MP3, AIFF, FLAC, WAV, etc.
  - Pure Rust, no C dependencies
  - Already similar to what WaveSurfer does in frontend

**Alternative Libraries:**
- **`bpm-detector`**: Smaller, simpler pure-Rust BPM detection
- **`tempo-detector`**: Another pure-Rust option

### Add to Cargo.toml
```toml
[dependencies]
# Existing dependencies...
aubio-rs = "0.3"
rustfft = "6.2"
symphonia = { version = "0.5", features = ["all"] }
```

---

## Implementation Steps

### Phase 1: BPM Analysis Backend

#### 1.1 Create BPM Analysis Module
**File**: `src-tauri/src/analysis.rs`

Core functionality:
- Audio decoding from various formats
- BPM detection using aubio or custom algorithm
- Batch processing support
- Progress reporting

**Basic Structure:**
```rust
use anyhow::{Context, Result};
use std::path::Path;

pub struct BpmAnalysisResult {
    pub bpm: f64,
    pub confidence: f64,
}

/// Analyze a single audio file for BPM
pub fn analyze_bpm<P: AsRef<Path>>(path: P) -> Result<BpmAnalysisResult> {
    let path_ref = path.as_ref();
    
    // 1. Decode audio file to PCM samples
    let samples = decode_audio(path_ref)?;
    
    // 2. Run BPM detection algorithm
    let bpm = detect_bpm(&samples)?;
    
    // 3. Validate result (typical range: 60-180 BPM)
    let confidence = calculate_confidence(bpm);
    
    Ok(BpmAnalysisResult { bpm, confidence })
}

/// Decode audio file to mono PCM samples at 44.1kHz
fn decode_audio<P: AsRef<Path>>(path: P) -> Result<Vec<f32>> {
    // Use symphonia to decode various formats
    // Convert to mono, resample to 44.1kHz
    // Return normalized float samples [-1.0, 1.0]
    todo!("Implement audio decoding")
}

/// Detect BPM using aubio tempo detection
fn detect_bpm(samples: &[f32]) -> Result<f64> {
    // Use aubio tempo detection
    // Or implement custom algorithm:
    //   1. Onset detection (find transients)
    //   2. Calculate inter-onset intervals
    //   3. Find dominant tempo via autocorrelation
    //   4. Handle double-time/half-time ambiguity
    todo!("Implement BPM detection")
}

fn calculate_confidence(bpm: f64) -> f64 {
    // Return confidence score 0.0-1.0
    // Based on BPM range validity
    if bpm < 60.0 || bpm > 200.0 {
        0.5
    } else {
        1.0
    }
}

/// Analyze multiple files in batch
pub fn analyze_bpm_batch(paths: Vec<String>) -> Vec<Result<BpmAnalysisResult>> {
    paths.into_iter()
        .map(|path| analyze_bpm(&path))
        .collect()
}
```

**Advanced Algorithm (Custom Implementation):**
```rust
use rustfft::{FftPlanner, num_complex::Complex};

fn detect_bpm_custom(samples: &[f32], sample_rate: u32) -> Result<f64> {
    // 1. Apply high-pass filter to isolate percussive content
    let filtered = highpass_filter(samples, 200.0, sample_rate);
    
    // 2. Onset detection using spectral flux
    let onsets = detect_onsets(&filtered, sample_rate);
    
    // 3. Calculate inter-onset intervals (IOI)
    let intervals: Vec<f64> = onsets.windows(2)
        .map(|w| (w[1] - w[0]) as f64 / sample_rate as f64)
        .collect();
    
    // 4. Use autocorrelation to find dominant tempo
    let tempo_candidates = autocorrelate_tempo(&intervals);
    
    // 5. Resolve double-time/half-time ambiguity
    let bpm = resolve_tempo_ambiguity(tempo_candidates);
    
    Ok(bpm)
}

fn detect_onsets(samples: &[f32], sample_rate: u32) -> Vec<usize> {
    // Sliding window analysis
    // Calculate spectral flux between frames
    // Peak picking to find onset times
    todo!("Implement onset detection")
}
```

#### 1.2 Create Analysis Commands
**File**: `src-tauri/src/commands.rs`

Add Tauri commands for frontend invocation:

```rust
use crate::analysis::{analyze_bpm, analyze_bpm_batch, BpmAnalysisResult};

#[tauri::command]
pub async fn analyze_track_bpm(file_path: String) -> Result<BpmAnalysisResult, String> {
    analyze_bpm(&file_path)
        .map_err(|e| format!("BPM analysis failed: {}", e))
}

#[tauri::command]
pub async fn analyze_tracks_bpm_batch(
    file_paths: Vec<String>,
) -> Result<Vec<Option<f64>>, String> {
    let results = analyze_bpm_batch(file_paths);
    
    Ok(results.into_iter()
        .map(|r| r.ok().map(|res| res.bpm))
        .collect())
}

#[tauri::command]
pub async fn write_bpm_to_metadata(
    file_path: String,
    bpm: f64,
) -> Result<(), String> {
    use crate::metadata::write_bpm_metadata;
    
    write_bpm_metadata(&file_path, bpm as i32)
        .map_err(|e| format!("Failed to write BPM: {}", e))
}
```

#### 1.3 Extend Metadata Writer
**File**: `src-tauri/src/metadata.rs`

Add BPM writing capability:

```rust
use lofty::tag::ItemKey;

/// Write BPM value to file metadata
pub fn write_bpm_metadata<P: AsRef<Path>>(path: P, bpm: i32) -> Result<()> {
    let path_ref = path.as_ref();
    let mut tagged_file = read_from_path(path_ref)
        .context(format!("Failed to read file: {:?}", path_ref))?;

    // Remove ID3v1 for iTunes compatibility
    if tagged_file.tag(TagType::Id3v1).is_some() {
        tagged_file.remove(TagType::Id3v1);
    }

    let mut tag = match tagged_file.primary_tag_mut() {
        Some(t) => t.clone(),
        None => Tag::new(TagType::Id3v2),
    };

    // Write BPM to appropriate field
    tag.remove_key(&ItemKey::Bpm);
    if bpm > 0 {
        tag.insert_text(ItemKey::Bpm, bpm.to_string());
    }

    tag.save_to_path(path, WriteOptions::default())
        .context("Failed to save BPM to disk")?;

    Ok(())
}

/// Read BPM from file metadata
pub fn read_bpm_metadata<P: AsRef<Path>>(path: P) -> Result<Option<i32>> {
    let tagged_file = read_from_path(path.as_ref())
        .context("Failed to read file")?;
    
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    let bpm = tag
        .and_then(|t| t.get_string(&ItemKey::Bpm))
        .and_then(|s| s.parse::<i32>().ok());

    Ok(bpm)
}
```

#### 1.4 Update Database Schema
**File**: `src-tauri/src/db.rs`

The `bpm` field already exists in the schema (line 23). Ensure it's properly indexed:

```rust
pub fn init_db(conn: &Connection) -> Result<()> {
    // Existing schema...
    
    // Add index for BPM searching/sorting
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tracks_bpm ON tracks(bpm)",
        [],
    )?;
    
    Ok(())
}
```

Update track sync to read BPM from metadata:

```rust
// In refresh_tracks or similar function
let bpm = read_bpm_metadata(&file_path)
    .ok()
    .flatten()
    .unwrap_or(0) as i64;

// Update database record
conn.execute(
    "UPDATE tracks SET bpm = ?1 WHERE id = ?2",
    params![bpm, track_id],
)?;
```

#### 1.5 Register Commands
**File**: `src-tauri/src/lib.rs`

```rust
mod analysis;

// In invoke_handler
.invoke_handler(tauri::generate_handler![
    // ...existing commands...
    analyze_track_bpm,
    analyze_tracks_bpm_batch,
    write_bpm_to_metadata,
])
```

---

### Phase 2: Frontend Integration

#### 2.1 Add Context Menu Options
**File**: `src/components/TrackList.tsx`

Add "Analyze BPM" option to track context menu:

```tsx
// In context menu render (around line 750)
{selectedTracks.length > 0 && (
    <>
        <div className="context-menu-item" onClick={handleAnalyzeBpm}>
            <Activity size={14} />
            {selectedTracks.length === 1 
                ? 'Analyze BPM' 
                : `Analyze BPM (${selectedTracks.length} tracks)`}
        </div>
        <div className="context-menu-separator" />
    </>
)}
```

#### 2.2 Implement Analysis Handler
**File**: `src/components/TrackList.tsx`

```tsx
import { invoke } from '@tauri-apps/api/core';

const handleAnalyzeBpm = async () => {
    closeContextMenu();
    
    if (selectedTracks.length === 0) return;
    
    // Show progress indication
    const trackCount = selectedTracks.length;
    showToast(`Analyzing BPM for ${trackCount} track${trackCount > 1 ? 's' : ''}...`);
    
    try {
        if (selectedTracks.length === 1) {
            // Single track analysis
            const track = selectedTracks[0];
            const result = await invoke<{ bpm: number; confidence: number }>(
                'analyze_track_bpm',
                { filePath: track.file_path }
            );
            
            const roundedBpm = Math.round(result.bpm);
            
            // Write to metadata
            await invoke('write_bpm_to_metadata', {
                filePath: track.file_path,
                bpm: roundedBpm
            });
            
            // Update database
            await invoke('update_track_bpm', {
                trackId: track.id,
                bpm: roundedBpm
            });
            
            showToast(`BPM detected: ${roundedBpm} BPM`);
            await refreshTracks([track.id]);
            
        } else {
            // Batch analysis
            const filePaths = selectedTracks.map(t => t.file_path);
            const results = await invoke<(number | null)[]>(
                'analyze_tracks_bpm_batch',
                { filePaths }
            );
            
            // Process results
            let successCount = 0;
            for (let i = 0; i < results.length; i++) {
                const bpm = results[i];
                if (bpm !== null && bpm > 0) {
                    const track = selectedTracks[i];
                    const roundedBpm = Math.round(bpm);
                    
                    await invoke('write_bpm_to_metadata', {
                        filePath: track.file_path,
                        bpm: roundedBpm
                    });
                    
                    await invoke('update_track_bpm', {
                        trackId: track.id,
                        bpm: roundedBpm
                    });
                    
                    successCount++;
                }
            }
            
            showToast(`BPM analysis complete: ${successCount}/${trackCount} tracks`);
            await refreshTracks(selectedTracks.map(t => t.id));
        }
        
    } catch (error) {
        console.error('BPM analysis failed:', error);
        showToast(`BPM analysis failed: ${error}`);
    }
};
```

#### 2.3 Add BPM Column to TrackList
**File**: `src/components/TrackList.tsx`

Add BPM as a sortable, searchable column:

```tsx
// In column definitions
{
    accessorKey: 'bpm',
    header: 'BPM',
    size: 70,
    cell: (info: any) => {
        const bpm = info.getValue() as number;
        return bpm > 0 ? bpm : '—';
    },
    enableSorting: true,
},
```

#### 2.4 Enhance BpmCounter Component (Optional)
**File**: `src/components/BpmCounter.tsx`

Add "Analyze" button to send current track for automated analysis:

```tsx
// After tap counter UI
<button
    onClick={async () => {
        if (!currentTrack) return;
        
        try {
            const result = await invoke<{ bpm: number }>(
                'analyze_track_bpm',
                { filePath: currentTrack.file_path }
            );
            
            const detected = Math.round(result.bpm);
            setBpm(detected);
            
            // Optionally auto-save to metadata
            await invoke('write_bpm_to_metadata', {
                filePath: currentTrack.file_path,
                bpm: detected
            });
            
            showToast(`Auto-detected: ${detected} BPM`);
        } catch (e) {
            showToast(`BPM detection failed`);
        }
    }}
    style={{
        padding: '4px 8px',
        fontSize: '11px',
        background: 'var(--accent-color)',
        border: 'none',
        borderRadius: '4px',
        color: 'white',
        cursor: 'pointer',
    }}
>
    Auto-Detect
</button>
```

#### 2.5 Add Progress Indicator for Batch Analysis
**File**: `src/components/TagDeck.tsx`

Implement progress tracking similar to Mixed In Key polling:

```tsx
const [analysisProgress, setAnalysisProgress] = useState<{
    current: number;
    total: number;
} | null>(null);

// Show progress overlay during batch analysis
{analysisProgress && (
    <div style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'var(--bg-secondary)',
        padding: '24px',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        zIndex: 1000,
    }}>
        <div style={{ marginBottom: '12px' }}>
            Analyzing BPM...
        </div>
        <div style={{ fontSize: '24px', fontWeight: 'bold' }}>
            {analysisProgress.current} / {analysisProgress.total}
        </div>
        <div style={{
            width: '200px',
            height: '4px',
            background: 'var(--bg-tertiary)',
            borderRadius: '2px',
            marginTop: '12px',
            overflow: 'hidden',
        }}>
            <div style={{
                width: `${(analysisProgress.current / analysisProgress.total) * 100}%`,
                height: '100%',
                background: 'var(--accent-color)',
                transition: 'width 0.3s',
            }} />
        </div>
    </div>
)}
```

---

## Musical Key Detection Architecture

### Option A: External Tool (Mixed In Key)
Follow the **MixedInKeyIntegration.md** pattern exactly. Mixed In Key already provides:
- Accurate key detection (Camelot notation)
- BPM analysis (as bonus)
- Energy level rating
- Batch processing

**Integration:** User right-clicks → "Analyze with Mixed In Key" → MiK8 processes → poll for metadata changes → refresh tracks.

### Option B: Native Key Detection (Advanced)
**Significantly more complex** than BPM. Requires:

#### Rust Libraries for Key Detection
- **`chromagram`**: Pure Rust chromagram extraction
- **`keyfinder`**: Port of KeyFinder library (C++ → Rust binding)
- **Essentia (via FFI)**: Professional-grade MIR library

**Basic Algorithm:**
```rust
pub struct KeyAnalysisResult {
    pub key: String,        // "C", "Dm", "F#m", etc.
    pub camelot: String,    // "8A", "5B", etc.
    pub confidence: f64,
}

fn analyze_key(samples: &[f32], sample_rate: u32) -> Result<KeyAnalysisResult> {
    // 1. Extract chromagram (12-bin pitch class profile)
    let chroma = extract_chromagram(samples, sample_rate);
    
    // 2. Apply key-finding algorithm (Krumhansl-Schmuckler)
    let (key_note, key_mode) = find_key(&chroma);
    
    // 3. Convert to standard notation
    let key = format_key(key_note, key_mode);
    
    // 4. Convert to Camelot notation for DJ use
    let camelot = to_camelot(key_note, key_mode);
    
    // 5. Calculate confidence
    let confidence = calculate_key_confidence(&chroma);
    
    Ok(KeyAnalysisResult { key, camelot, confidence })
}

fn extract_chromagram(samples: &[f32], sample_rate: u32) -> Vec<[f64; 12]> {
    // 1. Split into frames (e.g., 4096 samples with 50% overlap)
    // 2. Apply FFT to each frame
    // 3. Map frequency bins to 12 pitch classes (C, C#, D, ... B)
    // 4. Aggregate over time
    todo!("Chromagram extraction")
}

fn find_key(chroma: &[[f64; 12]]) -> (usize, Mode) {
    // Krumhansl-Schmuckler key-finding algorithm
    // Correlate chroma with 24 key profiles (12 major + 12 minor)
    // Return highest correlation
    todo!("Key finding")
}

fn to_camelot(note: usize, mode: Mode) -> String {
    // Map musical key to Camelot Wheel notation
    // E.g., C Major → 8B, A Minor → 8A
    let camelot_map = [
        ("C", "Major") => "8B",
        ("A", "Minor") => "8A",
        // ... 22 more mappings
    ];
    // Return matching notation
    todo!("Camelot conversion")
}
```

**Camelot Wheel Reference:**
```
Major Keys (B side):          Minor Keys (A side):
1B = C Major                  1A = A Minor
2B = D♭ Major                 2A = B♭ Minor
3B = D Major                  3A = B Minor
4B = E♭ Major                 4A = C Minor
5B = E Major                  5A = C♯ Minor
6B = F Major                  6A = D Minor
7B = F♯ Major                 7A = D♯ Minor
8B = G Major                  8A = E Minor
9B = A♭ Major                 9A = F Minor
10B = A Major                 10A = F♯ Minor
11B = B♭ Major                11A = G Minor
12B = B Major                 12A = G♯ Minor
```

**Metadata Storage:**
Write key to `Grouping` field or new custom field:
```rust
pub fn write_key_metadata<P: AsRef<Path>>(
    path: P,
    key: &str,
    camelot: &str,
) -> Result<()> {
    // Option 1: Write to Comments alongside BPM
    // Format: "3A - Energy 5 && Tags"
    
    // Option 2: Write to Grouping field
    tag.insert_text(ItemKey::ContentGroup, camelot.to_string());
    
    // Option 3: Use custom ID3 frame (TXXX:KEY)
    // More flexible but less compatible
}
```

---

## Search and Filter Integration

### Extend Search Parser
**File**: `src/utils/searchParser.ts`

Add BPM range queries:

```typescript
// Support queries like:
// "bpm:120-130"
// "bpm:>140"
// "bpm:<100"
// "key:Am"
// "key:8A"

function parseSearchToken(token: string): Filter | null {
    // BPM range
    if (token.startsWith('bpm:')) {
        const value = token.slice(4);
        
        // Range: bpm:120-130
        if (value.includes('-')) {
            const [min, max] = value.split('-').map(Number);
            return { type: 'bpm_range', min, max };
        }
        
        // Greater than: bpm:>140
        if (value.startsWith('>')) {
            return { type: 'bpm_min', value: Number(value.slice(1)) };
        }
        
        // Less than: bpm:<100
        if (value.startsWith('<')) {
            return { type: 'bpm_max', value: Number(value.slice(1)) };
        }
        
        // Exact: bpm:128
        return { type: 'bpm_exact', value: Number(value) };
    }
    
    // Key search
    if (token.startsWith('key:')) {
        const value = token.slice(4).toUpperCase();
        return { type: 'key', value };
    }
    
    return null;
}
```

### Database Query Support
**File**: `src-tauri/src/commands.rs`

Add BPM/Key filtering to search queries:

```rust
#[tauri::command]
pub fn search_tracks(
    conn: &Connection,
    query: String,
    bpm_min: Option<i64>,
    bpm_max: Option<i64>,
    key: Option<String>,
) -> Result<Vec<Track>, String> {
    let mut sql = "SELECT * FROM tracks WHERE 1=1".to_string();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![];
    
    if let Some(min) = bpm_min {
        sql.push_str(" AND bpm >= ?");
        params.push(Box::new(min));
    }
    
    if let Some(max) = bpm_max {
        sql.push_str(" AND bpm <= ?");
        params.push(Box::new(max));
    }
    
    if let Some(k) = key {
        sql.push_str(" AND grouping_raw LIKE ?");
        params.push(Box::new(format!("%{}%", k)));
    }
    
    // Execute query...
}
```

---

## UI/UX Enhancements

### BPM Range Filter Widget
Add to TrackList toolbar:

```tsx
<div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
    <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
        BPM:
    </label>
    <input
        type="number"
        placeholder="Min"
        style={{ width: '50px', padding: '4px' }}
        value={bpmMin}
        onChange={e => setBpmMin(Number(e.target.value))}
    />
    <span style={{ color: 'var(--text-secondary)' }}>—</span>
    <input
        type="number"
        placeholder="Max"
        style={{ width: '50px', padding: '4px' }}
        value={bpmMax}
        onChange={e => setBpmMax(Number(e.target.value))}
    />
    <button onClick={() => { setBpmMin(0); setBpmMax(0); }}>
        Clear
    </button>
</div>
```

### Visual BPM Indicator
Show BPM with color coding by tempo:

```tsx
function getBpmColor(bpm: number): string {
    if (bpm < 90) return '#3b82f6';   // Blue - Slow
    if (bpm < 120) return '#10b981';  // Green - Mid
    if (bpm < 140) return '#f59e0b';  // Orange - Upbeat
    return '#ef4444';                  // Red - Fast
}

// In cell render
<span style={{
    color: getBpmColor(bpm),
    fontWeight: 600,
}}>
    {bpm}
</span>
```

### Camelot Wheel Visualization (Advanced)
Interactive Camelot Wheel for harmonic mixing:

```tsx
// Component showing which keys mix well together
// Clicking a track highlights compatible keys
// Adjacent keys (±1) and same number different mode
```

---

## Performance Considerations

### Threading Strategy
```rust
use std::thread;
use std::sync::mpsc;

pub fn analyze_bpm_parallel(
    paths: Vec<String>,
    progress_callback: impl Fn(usize, usize) + Send + 'static,
) -> Vec<Result<f64>> {
    let thread_count = num_cpus::get();
    let chunk_size = (paths.len() + thread_count - 1) / thread_count;
    
    let (tx, rx) = mpsc::channel();
    
    // Spawn worker threads
    for chunk in paths.chunks(chunk_size) {
        let chunk = chunk.to_vec();
        let tx = tx.clone();
        
        thread::spawn(move || {
            for path in chunk {
                let result = analyze_bpm(&path);
                tx.send(result).unwrap();
            }
        });
    }
    
    // Collect results with progress reporting
    let mut results = Vec::new();
    for i in 0..paths.len() {
        results.push(rx.recv().unwrap());
        progress_callback(i + 1, paths.len());
    }
    
    results
}
```

### Caching Strategy
```rust
// Cache analyzed BPM to avoid re-processing
// Key: file hash or (path, mod_time)
// Store in SQLite or separate cache file

pub struct AnalysisCache {
    db: Connection,
}

impl AnalysisCache {
    pub fn get_cached_bpm(&self, path: &str, mod_time: i64) -> Option<f64> {
        // Check if we've already analyzed this file version
    }
    
    pub fn cache_bpm(&self, path: &str, mod_time: i64, bpm: f64) {
        // Store result for future lookups
    }
}
```

---

## Testing Strategy

### Unit Tests
**File**: `src-tauri/src/analysis.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_bpm_detection_known_track() {
        // Test with known BPM audio file
        let result = analyze_bpm("tests/01 Afterglow feat. Soundmouse (Original Mix).aiff")
            .expect("Analysis failed");
        
        // Verify BPM is within reasonable range of expected value
        assert!((result.bpm - 128.0).abs() < 2.0);
        assert!(result.confidence > 0.8);
    }
    
    #[test]
    fn test_bpm_range_validation() {
        // Ensure detected BPM is in valid range
        let result = analyze_bpm("tests/test_track.mp3").unwrap();
        assert!(result.bpm >= 60.0 && result.bpm <= 200.0);
    }
}
```

### Integration Tests
Test full workflow:
1. Analyze BPM via Tauri command
2. Write to metadata
3. Verify metadata persisted
4. Update database
5. Search by BPM range

---

## Migration & Compatibility

### Sync Existing Library
Provide "Analyze All" function to scan entire library:

```tsx
const analyzeEntireLibrary = async () => {
    const tracks = await invoke<Track[]>('get_all_tracks');
    const unanalyzed = tracks.filter(t => t.bpm === 0);
    
    if (unanalyzed.length === 0) {
        showToast('All tracks already analyzed');
        return;
    }
    
    const confirmed = await confirm(
        `Analyze BPM for ${unanalyzed.length} tracks? This may take several minutes.`
    );
    
    if (!confirmed) return;
    
    // Process in batches of 50
    const batchSize = 50;
    for (let i = 0; i < unanalyzed.length; i += batchSize) {
        const batch = unanalyzed.slice(i, i + batchSize);
        await handleAnalyzeBpm(batch);
        
        setAnalysisProgress({
            current: Math.min(i + batchSize, unanalyzed.length),
            total: unanalyzed.length,
        });
    }
    
    setAnalysisProgress(null);
    showToast('Library analysis complete');
};
```

### Import BPM from Existing Metadata
Many tracks may already have BPM in metadata from iTunes/MiK:

```rust
// During library import/sync
pub fn sync_bpm_from_metadata(conn: &Connection) -> Result<usize> {
    let tracks = get_all_tracks(conn)?;
    let mut updated = 0;
    
    for track in tracks {
        if track.bpm == 0 {
            if let Ok(Some(bpm)) = read_bpm_metadata(&track.file_path) {
                update_track_bpm(conn, track.id, bpm)?;
                updated += 1;
            }
        }
    }
    
    Ok(updated)
}
```

---

## Future Enhancements

1. **Genre Detection**: Classify tracks by genre using ML models
2. **Energy Level**: Calculate energy/intensity (1-10 scale)
3. **Harmonic Mixing Assistant**: Suggest next tracks based on key compatibility
4. **Auto-Playlist Generation**: Create playlists by BPM/key progression
5. **Beatgrid Visualization**: Show beats overlaid on waveform
6. **Tempo Adjustment**: Built-in pitch/tempo shifting for harmonic mixing practice
7. **Cloud Analysis**: Offload heavy processing to cloud service (optional paid feature)

---

## Documentation Updates

### User-Facing Docs
**File**: `Docs/CHANGELOG.md`

```markdown
## [Unreleased]

### Added
- Native BPM detection for audio files
- Musical key analysis (via Mixed In Key integration)
- BPM column in track list with sorting
- BPM range filtering in search
- Batch BPM analysis for multiple tracks
- Auto-detect button in BPM counter
- Camelot notation support for DJ-style harmonic mixing
```

### Developer Docs
Create `Docs/AudioAnalysis.md` with:
- Algorithm explanations
- Library choices and rationale
- Performance benchmarks
- Accuracy testing results
- Extension guide for adding new analysis features

---

## Success Criteria

### Minimum Viable Product (MVP)
- ✅ Analyze single track BPM via context menu
- ✅ Batch analyze multiple tracks
- ✅ Write BPM to file metadata (ID3 BPM field)
- ✅ Store BPM in database
- ✅ Display BPM in track list column
- ✅ Sort tracks by BPM
- ✅ Search/filter by BPM range

### Extended Goals
- ✅ Musical key detection (native or via Mixed In Key)
- ✅ Camelot notation support
- ✅ Harmonic mixing suggestions
- ✅ Progress indicator for batch operations
- ✅ Background/threaded processing
- ✅ Analysis result caching

### Performance Targets
- **Single track analysis**: < 3 seconds
- **Batch processing**: 20-30 tracks/minute
- **Accuracy**: ±2 BPM for 90% of tracks
- **UI responsiveness**: No freezing during analysis

---

## Implementation Timeline

### Week 1: Core BPM Backend
- Set up audio decoding with symphonia
- Implement BPM detection algorithm
- Create Tauri commands
- Unit tests

### Week 2: Frontend Integration
- Context menu integration
- Batch processing UI
- Progress indicators
- Database updates

### Week 3: Search & Polish
- BPM filtering in search
- Column display
- Error handling
- Documentation

### Week 4: Key Detection (Optional)
- Choose integration strategy (native vs MiK)
- Implement key analysis
- Camelot notation
- Testing and refinement

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Inaccurate BPM detection** | Use proven libraries (aubio), allow manual override, show confidence scores |
| **Slow analysis speed** | Multi-threading, progress indication, batch processing, caching |
| **Audio decoding failures** | Fallback decoders, clear error messages, skip problematic files |
| **Cross-platform compatibility** | Pure Rust libraries (avoid C dependencies), test on macOS initially |
| **Memory usage with large files** | Stream audio data, process in chunks, cleanup after analysis |

---

## References

### Academic Papers
- Scheirer, E. D. (1998). "Tempo and beat analysis of acoustic musical signals"
- Tzanetakis, G., & Cook, P. (2002). "Musical genre classification of audio signals"
- Krumhansl, C. L. (1990). "Cognitive Foundations of Musical Pitch"

### Libraries & Tools
- **aubio**: https://aubio.org/
- **Essentia**: https://essentia.upf.edu/
- **Librosa** (Python, reference): https://librosa.org/
- **KeyFinder**: https://www.ibrahimshaath.co.uk/keyfinder/
- **Mixed In Key**: https://mixedinkey.com/

### DJ Theory
- **Camelot Wheel**: Harmonic mixing notation system
- **Energy Levels**: Track intensity for DJ set progression
- **Beatmatching**: Tempo synchronization for seamless transitions
