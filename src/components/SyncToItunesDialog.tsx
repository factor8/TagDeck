import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, ChevronDown, Folder, Music } from 'lucide-react';
import { Playlist } from '../types';
import { buildItunesFolderTree, ItunesFolderNode } from './itunesFolderTree';
import { useToast } from './Toast';

interface SyncToItunesReport {
  added: number;
  auto_imported: number;
  skipped_missing: number;
}

interface Props {
  playlist: Playlist;
  playlists: Playlist[];
  onClose: () => void;
  onSynced: () => void;
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 10000, display: 'flex',
  alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)',
};

export function SyncToItunesDialog({ playlist, playlists, onClose, onSynced }: Props) {
  const { showSuccess, showError } = useToast();
  const tree = useMemo(() => buildItunesFolderTree(playlists), [playlists]);
  const [selected, setSelected] = useState<string | null>(null); // null = root
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (pid: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });

  const selectedName = selected
    ? playlists.find(p => p.persistent_id === selected)?.name ?? 'folder'
    : null;

  const doSync = async () => {
    setBusy(true);
    try {
      const report = await invoke<SyncToItunesReport>('sync_playlist_to_itunes', {
        playlistId: playlist.id,
        targetFolderPersistentId: selected,
      });
      const where = selectedName ? ` › ${selectedName}` : '';
      let msg = `Synced "${playlist.name}" to iTunes${where} — ${report.added} track${report.added !== 1 ? 's' : ''}`;
      const extras: string[] = [];
      if (report.auto_imported > 0) extras.push(`${report.auto_imported} imported`);
      if (report.skipped_missing > 0) extras.push(`${report.skipped_missing} skipped`);
      if (extras.length) msg += ` (${extras.join(', ')})`;
      showSuccess(msg);
      onSynced();
      onClose();
    } catch (err) {
      showError(typeof err === 'string' ? err : `Sync failed: ${err}`);
      setBusy(false);
    }
  };

  const renderNode = (node: ItunesFolderNode, level: number) => {
    const isExpanded = expanded.has(node.persistent_id);
    const hasChildren = node.children.length > 0;
    return (
      <div key={node.persistent_id}>
        <div
          className={`sti-row${selected === node.persistent_id ? ' sti-row-selected' : ''}`}
          style={{ paddingLeft: 8 + level * 16 }}
          onClick={() => setSelected(node.persistent_id)}
        >
          <span
            className="sti-caret"
            onClick={(e) => { e.stopPropagation(); if (hasChildren) toggle(node.persistent_id); }}
          >
            {hasChildren
              ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)
              : <span style={{ width: 14, display: 'inline-block' }} />}
          </span>
          <Folder size={14} /> <span>{node.name}</span>
        </div>
        {isExpanded && node.children.map(c => renderNode(c, level + 1))}
      </div>
    );
  };

  return (
    <div style={overlayStyle} onClick={busy ? undefined : onClose}>
      <div
        className="sidebar-delete-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
          borderRadius: '8px', padding: '20px', maxWidth: '380px', width: '90%',
        }}
      >
        <h3 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>
          Sync &ldquo;{playlist.name}&rdquo; to iTunes
        </h3>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)' }}>
          Choose where it should appear in your iTunes playlist tree.
        </p>
        <div className="sti-tree">
          <div
            className={`sti-row${selected === null ? ' sti-row-selected' : ''}`}
            style={{ paddingLeft: 8 }}
            onClick={() => setSelected(null)}
          >
            <span style={{ width: 14, display: 'inline-block' }} />
            <Music size={14} /> <span>(Top level / root)</span>
          </div>
          {tree.map(n => renderNode(n, 0))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={doSync} disabled={busy}>
            {busy ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      </div>
    </div>
  );
}
