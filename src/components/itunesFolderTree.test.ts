import { describe, it, expect } from 'vitest';
import { buildItunesFolderTree } from './itunesFolderTree';
import { Playlist } from '../types';

const pl = (over: Partial<Playlist>): Playlist => ({
  id: 0, persistent_id: 'x', name: 'x', is_folder: false, origin: 'itunes',
  itunes_sync_enabled: false, sort_position: 0, created_at: 0, updated_at: 0,
  ...over,
});

describe('buildItunesFolderTree', () => {
  it('includes only iTunes folders and nests by parent', () => {
    const tree = buildItunesFolderTree([
      pl({ persistent_id: 'F1', name: 'DJ Sets', is_folder: true }),
      pl({ persistent_id: 'F2', name: '2026', is_folder: true, parent_persistent_id: 'F1' }),
      pl({ persistent_id: 'P1', name: 'A Playlist', is_folder: false, parent_persistent_id: 'F1' }),
      pl({ persistent_id: 'TD', name: 'TD Folder', is_folder: true, origin: 'tagdeck' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].persistent_id).toBe('F1');
    expect(tree[0].children.map(c => c.persistent_id)).toEqual(['F2']);
  });

  it('sorts siblings case-insensitively', () => {
    const tree = buildItunesFolderTree([
      pl({ persistent_id: 'b', name: 'beta', is_folder: true }),
      pl({ persistent_id: 'a', name: 'Alpha', is_folder: true }),
    ]);
    expect(tree.map(n => n.name)).toEqual(['Alpha', 'beta']);
  });

  it('treats a folder with a missing/foreign parent as a root', () => {
    const tree = buildItunesFolderTree([
      pl({ persistent_id: 'F2', name: 'Orphan', is_folder: true, parent_persistent_id: 'MISSING' }),
    ]);
    expect(tree.map(n => n.persistent_id)).toEqual(['F2']);
  });
});
