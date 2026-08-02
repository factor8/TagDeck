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
