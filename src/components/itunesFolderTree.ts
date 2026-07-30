import { Playlist } from '../types';

export interface ItunesFolderNode {
  persistent_id: string;
  name: string;
  children: ItunesFolderNode[];
}

/**
 * Builds the iTunes folder hierarchy for the "Sync to iTunes" picker from the
 * full playlist list. Only folders that originate from iTunes are included
 * (Music.app playlists can't contain playlists). Folders nest by
 * parent_persistent_id; a folder whose parent isn't itself an included iTunes
 * folder becomes a root. Siblings are sorted by name (case-insensitive).
 */
export function buildItunesFolderTree(playlists: Playlist[]): ItunesFolderNode[] {
  const folders = playlists.filter(p => p.is_folder && p.origin === 'itunes');
  const byPid = new Map<string, ItunesFolderNode>();
  folders.forEach(f => byPid.set(f.persistent_id, {
    persistent_id: f.persistent_id,
    name: f.name,
    children: [],
  }));

  const roots: ItunesFolderNode[] = [];
  folders.forEach(f => {
    const node = byPid.get(f.persistent_id)!;
    const parent = f.parent_persistent_id ? byPid.get(f.parent_persistent_id) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });

  const sortRec = (nodes: ItunesFolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach(n => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}
