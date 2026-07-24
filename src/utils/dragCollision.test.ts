import { describe, it, expect } from 'vitest';
import {
  isTrackId,
  isAddTargetId,
  pickTrackCollision,
  shouldCommitAdd,
  nextDwellAction,
} from './dragCollision';

describe('isTrackId', () => {
  it('matches track- prefixed ids', () => {
    expect(isTrackId('track-5')).toBe(true);
    expect(isTrackId('track-0')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isTrackId('playlist-5')).toBe(false);
    expect(isTrackId('builder-no-target')).toBe(false);
    expect(isTrackId('col-title')).toBe(false);
  });
});

describe('isAddTargetId', () => {
  it('matches sidebar/builder playlist droppables', () => {
    expect(isAddTargetId('playlist-12')).toBe(true);
    expect(isAddTargetId('builder-no-target')).toBe(true);
  });
  it('rejects track rows and columns', () => {
    expect(isAddTargetId('track-5')).toBe(false);
    expect(isAddTargetId('col-artist')).toBe(false);
  });
});

describe('pickTrackCollision', () => {
  it('prefers a track-row hit (reorder) even when an add-target is also present', () => {
    const hits = [{ id: 'playlist-3' }, { id: 'track-9' }];
    expect(pickTrackCollision(hits)).toEqual({ kind: 'reorder', collision: { id: 'track-9' } });
  });

  it('returns add when only an add-target is under the pointer', () => {
    const hits = [{ id: 'playlist-3' }];
    expect(pickTrackCollision(hits)).toEqual({ kind: 'add', collision: { id: 'playlist-3' } });
  });

  it('returns add for the builder-no-target droppable', () => {
    const hits = [{ id: 'builder-no-target' }];
    expect(pickTrackCollision(hits)).toEqual({ kind: 'add', collision: { id: 'builder-no-target' } });
  });

  it('falls back when the pointer is over nothing droppable (empty list space)', () => {
    expect(pickTrackCollision([])).toEqual({ kind: 'fallback' });
  });

  it('falls back when only non-droppable-ish (column) ids are present', () => {
    const hits = [{ id: 'col-title' }];
    expect(pickTrackCollision(hits)).toEqual({ kind: 'fallback' });
  });
});

describe('shouldCommitAdd', () => {
  it('commits when the armed target matches the drop target', () => {
    expect(shouldCommitAdd('playlist-7', 'playlist-7')).toBe(true);
    expect(shouldCommitAdd('builder-no-target', 'builder-no-target')).toBe(true);
  });
  it('does not commit when nothing is armed (dwell not yet elapsed)', () => {
    expect(shouldCommitAdd(null, 'playlist-7')).toBe(false);
  });
  it('does not commit when a different target is armed', () => {
    expect(shouldCommitAdd('playlist-2', 'playlist-7')).toBe(false);
  });
  it('does not commit onto a non-add target even if ids match', () => {
    expect(shouldCommitAdd('track-7', 'track-7')).toBe(false);
  });
});

describe('nextDwellAction', () => {
  it('starts a timer when a track first enters a new add-target', () => {
    expect(nextDwellAction(null, 'playlist-4', true)).toEqual({ action: 'start', target: 'playlist-4' });
  });
  it('keeps the running timer while still over the same target', () => {
    expect(nextDwellAction('playlist-4', 'playlist-4', true)).toEqual({ action: 'keep', target: 'playlist-4' });
  });
  it('restarts when moving from one add-target to another', () => {
    expect(nextDwellAction('playlist-4', 'playlist-9', true)).toEqual({ action: 'start', target: 'playlist-9' });
  });
  it('clears when the pointer leaves onto a track row (reorder)', () => {
    expect(nextDwellAction('playlist-4', 'track-2', true)).toEqual({ action: 'clear', target: null });
  });
  it('clears when the pointer is over nothing', () => {
    expect(nextDwellAction('playlist-4', null, true)).toEqual({ action: 'clear', target: null });
  });
  it('clears for a non-track drag (columns never arm adds)', () => {
    expect(nextDwellAction(null, 'playlist-4', false)).toEqual({ action: 'clear', target: null });
  });
});
