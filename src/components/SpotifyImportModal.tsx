import { useEffect, useState } from 'react';
import { Loader2, X, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from './Toast';
import { Playlist } from '../types';

interface SpotifyPlaylistSummary {
    id: string;
    name: string;
    snapshot_id: string;
    track_count: number;
    owner_name: string;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onImported: () => void;
}

export function SpotifyImportModal({ isOpen, onClose, onImported }: Props) {
    const [playlists, setPlaylists] = useState<SpotifyPlaylistSummary[] | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
    const [importing, setImporting] = useState(false);
    const { showSuccess, showError } = useToast();

    useEffect(() => {
        if (!isOpen) return;
        setPlaylists(null);
        setSelected(new Set());
        invoke<SpotifyPlaylistSummary[]>('spotify_list_playlists')
            .then(setPlaylists)
            .catch(e => { showError(String(e)); onClose(); });
        // Best-effort — used only to label already-imported playlists below.
        invoke<Playlist[]>('get_playlists')
            .then(all => setImportedIds(new Set(
                all.filter(p => p.origin === 'spotify' && p.spotify_playlist_id).map(p => p.spotify_playlist_id as string)
            )))
            .catch(() => {});
    }, [isOpen]);

    if (!isOpen) return null;

    const toggle = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const doImport = async () => {
        setImporting(true);
        try {
            const report = await invoke<{ playlists: number; tracks_added: number }>(
                'spotify_import_playlists', { playlistIds: Array.from(selected) });
            showSuccess(`Imported ${report.playlists} playlist${report.playlists === 1 ? '' : 's'} (${report.tracks_added} new tracks)`);
            onImported();
            onClose();
        } catch (e) { showError(String(e)); }
        finally { setImporting(false); }
    };

    return (
        <>
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 10000 }} onClick={onClose} />
            <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                          width: 440, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
                          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                          borderRadius: 10, zIndex: 10001, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <h3 style={{ margin: 0 }}>Import Spotify Playlists</h3>
                    <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}><X size={16} /></button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', minHeight: 120 }}>
                    {playlists === null ? (
                        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Loader2 className="spin" /></div>
                    ) : playlists.length === 0 ? (
                        <p style={{ color: 'var(--text-secondary)' }}>No playlists found on this Spotify account.</p>
                    ) : playlists.map(p => (
                        <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', cursor: 'pointer' }}>
                            <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                            {importedIds.has(p.id) && (
                                <span title="Already in TagDeck — selecting it will re-sync instead of re-import"
                                      style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0 }}>
                                    <Check size={11} /> Imported
                                </span>
                            )}
                            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{p.track_count} tracks</span>
                        </label>
                    ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                    <button onClick={onClose}>Cancel</button>
                    <button onClick={doImport} disabled={importing || selected.size === 0}>
                        {importing ? 'Importing…' : `Import ${selected.size || ''}`}
                    </button>
                </div>
            </div>
        </>
    );
}
