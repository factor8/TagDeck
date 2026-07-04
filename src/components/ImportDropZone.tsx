import { useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isNativeDragOutActive } from '../utils/dragOut';

export interface ImportSummary {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  imported_track_ids: number[];
  results: { success: boolean; original_path: string; new_path?: string; error?: string }[];
}

interface ImportDropZoneProps {
  /** Called with the summary after every import attempt. */
  onImportComplete?: (summary: ImportSummary) => void;
  /** Notify parent when an external file drag enters/leaves the window. */
  onDragChange?: (active: boolean) => void;
  /** If provided, files dropped on the background fall back to this playlist. */
  targetPlaylistId?: number | null;
}

/**
 * Invisible import handler — no blocking overlay.
 *
 * Listens to Tauri native drag events to detect external file drags and
 * fires tauri://drag-drop as a fallback when the drop isn't caught by a
 * more specific component (e.g. a sidebar playlist row or a track-list row).
 */
export function ImportDropZone({ onImportComplete, onDragChange, targetPlaylistId }: ImportDropZoneProps) {
  const tauriDropHandled = useRef(false);
  // Track drag state so we can suppress the Tauri fallback when HTML5 already handled it.
  const isDragActive = useRef(false);

  const runImport = useCallback(async (paths: string[], playlistId?: number | null): Promise<ImportSummary | null> => {
    if (paths.length === 0) return null;
    try {
      const result = await invoke<ImportSummary>('import_files', {
        filePaths: paths,
        targetPlaylistId: playlistId ?? targetPlaylistId ?? null,
      });
      onImportComplete?.(result);
      return result;
    } catch (err) {
      const errorSummary: ImportSummary = {
        total: paths.length,
        imported: 0,
        skipped: 0,
        failed: paths.length,
        imported_track_ids: [],
        results: [{ success: false, original_path: paths[0], error: String(err) }],
      };
      onImportComplete?.(errorSummary);
      return errorSummary;
    }
  }, [onImportComplete, targetPlaylistId]);

  // ── Tauri native drag events ───────────────────────────────────────────────
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    listen('tauri://drag-enter', () => {
      if (isNativeDragOutActive()) return;
      isDragActive.current = true;
      onDragChange?.(true);
    }).then(fn => unlisteners.push(fn));

    listen('tauri://drag-leave', () => {
      if (isNativeDragOutActive()) return;
      isDragActive.current = false;
      onDragChange?.(false);
    }).then(fn => unlisteners.push(fn));

    listen<{ paths: string[]; position: { x: number; y: number } }>(
      'tauri://drag-drop',
      async (event) => {
        if (isNativeDragOutActive()) return;
        isDragActive.current = false;
        onDragChange?.(false);

        // Give HTML5 drop handlers a tick to mark themselves first.
        await new Promise(r => setTimeout(r, 0));
        if (tauriDropHandled.current) {
          tauriDropHandled.current = false;
          return;
        }

        const paths = event.payload?.paths ?? [];
        await runImport(paths);
      }
    ).then(fn => unlisteners.push(fn));

    return () => unlisteners.forEach(fn => fn());
  }, [runImport, onDragChange]);

  // ── HTML5 events — mark handled so Tauri fallback is suppressed ───────────
  useEffect(() => {
    const handleDrop = () => {
      // Any HTML5 drop (from sidebar rows or track-list rows) marks itself here.
      tauriDropHandled.current = true;
    };

    document.addEventListener('drop', handleDrop, true); // capture phase
    return () => document.removeEventListener('drop', handleDrop, true);
  }, []);

  // This component renders nothing — visual feedback is handled by the
  // individual drop targets (sidebar rows, track-list rows).
  return null;
}

// Convenience export so callers can invoke a file import directly.
export async function importFiles(
  paths: string[],
  targetPlaylistId: number | null,
): Promise<ImportSummary> {
  return invoke<ImportSummary>('import_files', {
    filePaths: paths,
    targetPlaylistId,
  });
}
