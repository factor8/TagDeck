import { describe, it, expect } from 'vitest';
import { recheckableIds, recheckFoundSomething, summarizeRecheck, type RecheckReport } from './recheckMissing';
import type { Track } from '../types';

function track(id: number, missing: boolean): Track {
  return {
    id,
    persistent_id: `P${id}`,
    file_path: `/Music/${id}.mp3`,
    duration_secs: 100,
    format: 'MP3',
    size_bytes: 1000,
    bit_rate: 320,
    modified_date: 0,
    rating: 0,
    date_added: 0,
    bpm: 0,
    missing,
    source: 'local',
  };
}

function report(over: Partial<RecheckReport> = {}): RecheckReport {
  return { checked: 0, restored: 0, relocated: 0, still_missing: 0, itunes_lookup_error: null, ...over };
}

describe('recheckableIds', () => {
  it('keeps only tracks flagged missing', () => {
    expect(recheckableIds([track(1, true), track(2, false), track(3, true)])).toEqual([1, 3]);
  });
  it('treats an absent missing flag as present-on-disk', () => {
    const t = track(4, false);
    delete t.missing;
    expect(recheckableIds([t])).toEqual([]);
  });
  it('returns nothing for an empty selection', () => {
    expect(recheckableIds([])).toEqual([]);
  });
});

describe('recheckFoundSomething', () => {
  it('is true when anything was restored or relocated', () => {
    expect(recheckFoundSomething(report({ checked: 2, restored: 1, still_missing: 1 }))).toBe(true);
    expect(recheckFoundSomething(report({ checked: 2, relocated: 2 }))).toBe(true);
  });
  it('is false when everything is still missing', () => {
    expect(recheckFoundSomething(report({ checked: 3, still_missing: 3 }))).toBe(false);
  });
});

describe('summarizeRecheck', () => {
  it('reports each outcome that occurred', () => {
    expect(summarizeRecheck(report({ checked: 7, restored: 4, relocated: 1, still_missing: 2 })))
      .toBe('Rechecked 7 missing files: 4 restored, 1 relocated, 2 still missing');
  });
  it('omits outcomes that did not occur', () => {
    expect(summarizeRecheck(report({ checked: 3, restored: 3 })))
      .toBe('Rechecked 3 missing files: 3 restored');
  });
  it('singularizes a one-track recheck', () => {
    expect(summarizeRecheck(report({ checked: 1, still_missing: 1 })))
      .toBe('Rechecked 1 missing file: 1 still missing');
  });
  it('short-circuits when there was nothing to check', () => {
    expect(summarizeRecheck(report())).toBe('No missing files to recheck');
  });
  it('flags a failed Music.app lookup without failing the run', () => {
    expect(summarizeRecheck(report({ checked: 2, restored: 1, still_missing: 1, itunes_lookup_error: 'sidecar died' })))
      .toBe("Rechecked 2 missing files: 1 restored, 1 still missing — couldn't read the Music app library");
  });
});
