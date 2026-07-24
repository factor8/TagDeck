import type { Track } from '../types';

/** Count tracks whose underlying file is missing on disk. */
export function countMissing(tracks: Track[]): number {
  return tracks.reduce((n, t) => n + (t.missing ? 1 : 0), 0);
}

/**
 * When `hideMissing` is true, return the list with missing-file tracks removed.
 * When false, return the same array reference unchanged (no-op, cheap).
 */
export function filterMissing(tracks: Track[], hideMissing: boolean): Track[] {
  return hideMissing ? tracks.filter(t => !t.missing) : tracks;
}
