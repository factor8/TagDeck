import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface ImportResult {
  success: boolean;
  original_path: string;
  new_path?: string;
  error?: string;
}

interface ImportSummary {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  results: ImportResult[];
}

interface ImportDropZoneProps {
  /** Called after a successful import so the parent can refresh track lists. */
  onImportComplete?: () => void;
  /** If provided, files will also be added to this playlist. */
  targetPlaylistId?: number | null;
}

/**
 * Full-window drop zone overlay for importing audio files into the TagDeck
 * library. Shows a visual indicator when files are dragged over the window
 * and displays import progress / results when a drop occurs.
 */
export function ImportDropZone({ onImportComplete, targetPlaylistId }: ImportDropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const dragCounter = useRef(0);

  // We use a counter rather than a simple boolean so nested elements don't
  // cause flicker as the mouse moves between children.
  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (dragCounter.current === 1) {
      // Only show overlay if the drag payload contains files
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragOver(true);
      }
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragOver(false);

    if (!e.dataTransfer) return;

    // Tauri injects a `path` property on each File object
    const files = Array.from(e.dataTransfer.files);
    const paths = files
      .map((f) => (f as unknown as { path?: string }).path)
      .filter((p): p is string => Boolean(p));

    if (paths.length === 0) return;

    setIsImporting(true);
    setSummary(null);

    try {
      const result = await invoke<ImportSummary>('import_files', {
        filePaths: paths,
        targetPlaylistId: targetPlaylistId ?? null,
      });

      setSummary(result);
      onImportComplete?.();

      // Auto-dismiss after 4s if everything succeeded
      if (result.failed === 0 && result.skipped === 0) {
        setTimeout(() => {
          setSummary(null);
          setIsImporting(false);
        }, 4000);
      }
    } catch (err) {
      console.error('Import failed:', err);
      setSummary({
        total: paths.length,
        imported: 0,
        skipped: 0,
        failed: paths.length,
        results: [{ success: false, original_path: paths[0], error: String(err) }],
      });
    }
  }, [onImportComplete, targetPlaylistId]);

  useEffect(() => {
    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', handleDrop);

    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('drop', handleDrop);
    };
  }, [handleDragEnter, handleDragOver, handleDragLeave, handleDrop]);

  // Also listen for Tauri's native file-drop event (fallback)
  useEffect(() => {
    const unlisten = listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
      const paths = event.payload.paths;
      if (!paths || paths.length === 0) return;

      setIsImporting(true);
      setSummary(null);

      try {
        const result = await invoke<ImportSummary>('import_files', {
          filePaths: paths,
          targetPlaylistId: targetPlaylistId ?? null,
        });

        setSummary(result);
        onImportComplete?.();

        if (result.failed === 0 && result.skipped === 0) {
          setTimeout(() => {
            setSummary(null);
            setIsImporting(false);
          }, 4000);
        }
      } catch (err) {
        console.error('Import (native drop) failed:', err);
      }
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [onImportComplete, targetPlaylistId]);

  // Nothing visible when idle
  if (!isDragOver && !isImporting) return null;

  return (
    <div
      className="import-drop-zone"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: isDragOver
          ? 'rgba(59, 130, 235, 0.15)'
          : 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        border: isDragOver ? '3px dashed var(--accent-color, #3b82f6)' : 'none',
        transition: 'background 0.2s, border 0.2s',
      }}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* Import in progress / results */}
      {isImporting && summary ? (
        <div
          style={{
            background: 'var(--bg-secondary, #1e293b)',
            borderRadius: 12,
            padding: 30,
            maxWidth: 500,
            width: '90%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            color: 'var(--text-primary, #fff)',
            textAlign: 'center',
          }}
        >
          <h2 style={{ margin: '0 0 16px', fontSize: 22 }}>Import Complete</h2>

          <div style={{ display: 'flex', gap: 24, justifyContent: 'center', marginBottom: 20 }}>
            <Stat label="imported" value={summary.imported} color="#10b981" />
            {summary.skipped > 0 && <Stat label="skipped" value={summary.skipped} color="#f59e0b" />}
            {summary.failed > 0 && <Stat label="failed" value={summary.failed} color="#ef4444" />}
          </div>

          {summary.failed > 0 && (
            <div
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                borderRadius: 8,
                padding: 12,
                maxHeight: 180,
                overflowY: 'auto',
                textAlign: 'left',
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              <strong style={{ color: '#ef4444' }}>Errors:</strong>
              <ul style={{ margin: '8px 0 0', padding: '0 0 0 16px' }}>
                {summary.results
                  .filter((r) => !r.success && r.error && !r.error.includes('Already in library'))
                  .map((r, i) => (
                    <li key={i} style={{ color: '#ef4444', padding: '2px 0' }}>
                      <strong>{r.original_path.split('/').pop()}</strong>: {r.error}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <button
            onClick={() => { setSummary(null); setIsImporting(false); }}
            style={{
              padding: '8px 24px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--accent-color, #3b82f6)',
              color: '#fff',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      ) : (
        /* Drag prompt overlay */
        <div style={{ textAlign: 'center', userSelect: 'none', color: '#fff' }}>
          <div style={{ fontSize: 72, marginBottom: 16, animation: 'importBounce 1s ease-in-out infinite' }}>
            📁
          </div>
          <h2 style={{ fontSize: 28, margin: '0 0 8px' }}>Drop files to import</h2>
          <p style={{ fontSize: 15, opacity: 0.7, margin: 0 }}>
            Supported: MP3, M4A, AIFF, WAV, FLAC
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 32, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 13, opacity: 0.7 }}>{label}</div>
    </div>
  );
}
