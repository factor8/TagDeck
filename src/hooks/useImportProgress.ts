import { useEffect, useRef, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';

export type ImportItemStatus = 'queued' | 'importing' | 'imported' | 'skipped' | 'failed';

export interface ImportItem {
    index: number;
    path: string;
    /** File name only, shown in placeholder rows and the progress card. */
    name: string;
    status: ImportItemStatus;
    trackId: number | null;
    error: string | null;
}

export interface ImportBatch {
    batchId: string;
    playlistId: number | null;
    total: number;
    /** Files that have reached a terminal status (imported / skipped / failed). */
    done: number;
    imported: number;
    skipped: number;
    failed: number;
    items: ImportItem[];
    finished: boolean;
}

/** Mirrors `ImportProgress` in src-tauri/src/commands.rs (serde tag = "phase"). */
type ImportProgressEvent =
    | { phase: 'start'; batch_id: string; playlist_id: number | null; total: number; items: { index: number; path: string; name: string }[] }
    | { phase: 'item_start'; batch_id: string; index: number }
    | { phase: 'item'; batch_id: string; index: number; status: 'imported' | 'skipped' | 'failed'; track_id: number | null; error: string | null }
    | { phase: 'done'; batch_id: string; imported: number; skipped: number; failed: number };

/** How long a finished batch stays visible so the last row can flip before it vanishes. */
const FINISHED_LINGER_MS = 1500;
/** Trailing debounce for the track-list refresh fired as files land. */
const REFRESH_DEBOUNCE_MS = 600;

/**
 * Tracks live `import_files` batches from the `import-progress` event.
 *
 * `onTracksLanded` fires (debounced) whenever at least one file has been added
 * to the library/playlist, so the caller can reload the track list and the
 * placeholder rows turn into real ones as the import proceeds.
 */
export function useImportProgress(onTracksLanded?: () => void) {
    const [batches, setBatches] = useState<Map<string, ImportBatch>>(new Map());
    const landedCb = useRef(onTracksLanded);
    landedCb.current = onTracksLanded;
    const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const scheduleRefresh = useCallback(() => {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => {
            refreshTimer.current = null;
            landedCb.current?.();
        }, REFRESH_DEBOUNCE_MS);
    }, []);

    useEffect(() => {
        let unlisten: (() => void) | null = null;
        let mounted = true;
        const lingerTimers: ReturnType<typeof setTimeout>[] = [];

        listen<ImportProgressEvent>('import-progress', (event) => {
            const ev = event.payload;
            setBatches(prev => {
                const next = new Map(prev);
                if (ev.phase === 'start') {
                    next.set(ev.batch_id, {
                        batchId: ev.batch_id,
                        playlistId: ev.playlist_id,
                        total: ev.total,
                        done: 0, imported: 0, skipped: 0, failed: 0,
                        finished: false,
                        items: ev.items.map(i => ({ ...i, status: 'queued', trackId: null, error: null })),
                    });
                    return next;
                }
                const batch = next.get(ev.batch_id);
                if (!batch) return prev;
                if (ev.phase === 'item_start') {
                    const items = batch.items.map(i => i.index === ev.index ? { ...i, status: 'importing' as const } : i);
                    next.set(ev.batch_id, { ...batch, items });
                } else if (ev.phase === 'item') {
                    const items = batch.items.map(i => i.index === ev.index
                        ? { ...i, status: ev.status, trackId: ev.track_id, error: ev.error }
                        : i);
                    next.set(ev.batch_id, {
                        ...batch,
                        items,
                        done: batch.done + 1,
                        imported: batch.imported + (ev.status === 'imported' ? 1 : 0),
                        skipped: batch.skipped + (ev.status === 'skipped' ? 1 : 0),
                        failed: batch.failed + (ev.status === 'failed' ? 1 : 0),
                    });
                    if (ev.track_id != null) scheduleRefresh();
                } else if (ev.phase === 'done') {
                    next.set(ev.batch_id, { ...batch, finished: true, imported: ev.imported, skipped: ev.skipped, failed: ev.failed });
                    lingerTimers.push(setTimeout(() => {
                        if (!mounted) return;
                        setBatches(p => { const m = new Map(p); m.delete(ev.batch_id); return m; });
                    }, FINISHED_LINGER_MS));
                }
                return next;
            });
        }).then(fn => { if (mounted) unlisten = fn; else fn(); });

        return () => {
            mounted = false;
            unlisten?.();
            lingerTimers.forEach(clearTimeout);
            if (refreshTimer.current) clearTimeout(refreshTimer.current);
        };
    }, [scheduleRefresh]);

    return batches;
}

/** Per-playlist done/total counters for every active batch targeting a playlist. */
export function importingByPlaylist(batches: Map<string, ImportBatch>): Map<number, { done: number; total: number }> {
    const out = new Map<number, { done: number; total: number }>();
    for (const b of batches.values()) {
        if (b.playlistId == null || b.finished) continue;
        const cur = out.get(b.playlistId) ?? { done: 0, total: 0 };
        out.set(b.playlistId, { done: cur.done + b.done, total: cur.total + b.total });
    }
    return out;
}

/** Items that should show as grayed placeholder rows in the given playlist view
 *  (or in the Library view when `playlistId` is null): everything not yet failed. */
export function pendingImportsFor(batches: Map<string, ImportBatch>, playlistId: number | null): ImportItem[] {
    const out: ImportItem[] = [];
    for (const b of batches.values()) {
        // Library view shows all batches; a playlist view only its own.
        if (playlistId != null && b.playlistId !== playlistId) continue;
        for (const i of b.items) {
            if (i.status === 'failed') continue;
            // Skipped files with no track id weren't added anywhere — nothing to wait for.
            if (i.status === 'skipped' && i.trackId == null) continue;
            out.push(i);
        }
    }
    return out;
}
