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
  // The pointer being over a list row means "reorder" — the caller then resolves
  // the exact row with closestCenter (robust for sortable lists). An add only
  // happens when the pointer is genuinely over an add target and NOT over a row.
  it('is reorder when a track row is under the pointer (even if an add-target also is)', () => {
    expect(pickTrackCollision([{ id: 'playlist-3' }, { id: 'track-9' }])).toEqual({ mode: 'reorder' });
  });

  it('is reorder when only a track row is under the pointer', () => {
    expect(pickTrackCollision([{ id: 'track-9' }])).toEqual({ mode: 'reorder' });
  });

  it('is add when only an add-target is under the pointer', () => {
    expect(pickTrackCollision([{ id: 'playlist-3' }])).toEqual({ mode: 'add', collision: { id: 'playlist-3' } });
  });

  it('is add for the builder-no-target droppable', () => {
    expect(pickTrackCollision([{ id: 'builder-no-target' }])).toEqual({ mode: 'add', collision: { id: 'builder-no-target' } });
  });

  it('is reorder when the pointer is over nothing droppable (empty list space)', () => {
    expect(pickTrackCollision([])).toEqual({ mode: 'reorder' });
  });

  it('is reorder when only a non-add, non-row id (column) is present', () => {
    expect(pickTrackCollision([{ id: 'col-title' }])).toEqual({ mode: 'reorder' });
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
