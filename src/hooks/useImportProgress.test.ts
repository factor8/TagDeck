import { describe, it, expect } from 'vitest';
import { importingByPlaylist, pendingImportsFor, type ImportBatch, type ImportItem } from './useImportProgress';

const item = (index: number, status: ImportItem['status'], trackId: number | null = null): ImportItem =>
    ({ index, path: `/x/${index}.aiff`, name: `${index}.aiff`, status, trackId, error: null });

const batch = (over: Partial<ImportBatch>): ImportBatch => ({
    batchId: 'b', playlistId: 7, total: 0, done: 0, imported: 0, skipped: 0, failed: 0, items: [], finished: false, ...over,
});

describe('pendingImportsFor', () => {
    const batches = new Map([['b', batch({
        items: [item(0, 'queued'), item(1, 'importing'), item(2, 'imported', 42), item(3, 'failed'), item(4, 'skipped'), item(5, 'skipped', 43)],
    })]]);

    it('keeps queued, importing, landed, and skipped-but-added items; drops failed and unplaced skips', () => {
        expect(pendingImportsFor(batches, 7).map(i => i.index)).toEqual([0, 1, 2, 5]);
    });

    it('scopes to the target playlist, but the Library view sees every batch', () => {
        expect(pendingImportsFor(batches, 8)).toEqual([]);
        expect(pendingImportsFor(batches, null)).toHaveLength(4);
    });
});

describe('importingByPlaylist', () => {
    it('sums done/total per playlist and ignores finished or untargeted batches', () => {
        const batches = new Map([
            ['a', batch({ batchId: 'a', playlistId: 7, done: 2, total: 5 })],
            ['b', batch({ batchId: 'b', playlistId: 7, done: 1, total: 1 })],
            ['c', batch({ batchId: 'c', playlistId: 9, done: 3, total: 3, finished: true })],
            ['d', batch({ batchId: 'd', playlistId: null, done: 0, total: 4 })],
        ]);
        const m = importingByPlaylist(batches);
        expect(m.get(7)).toEqual({ done: 3, total: 6 });
        expect(m.has(9)).toBe(false);
        expect(m.size).toBe(1);
    });
});
