import { useState } from 'react';
import { X, Loader2, HardDriveDownload, HardDriveUpload, CheckSquare, Square, ChevronRight, ChevronDown, Folder, ListMusic } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useToast } from '../Toast';

interface BackupTrackRef {
    persistent_id: string;
    file_path: string;
    title?: string;
    artist?: string;
}

interface BackupEntry {
    persistent_id: string;
    parent_persistent_id?: string;
    name: string;
    is_folder: boolean;
    tracks: BackupTrackRef[];
}

interface PlaylistBackupSectionProps {
    onRefresh: () => void;
}

export function PlaylistBackupSection({ onRefresh }: PlaylistBackupSectionProps) {
    const { showSuccess, showError } = useToast();

    // Backup / Restore state
    const [backupBusy, setBackupBusy] = useState(false);
    const [restoreEntries, setRestoreEntries] = useState<BackupEntry[] | null>(null);
    const [selectedRestoreIds, setSelectedRestoreIds] = useState<Set<string>>(new Set());
    const [expandedRestoreFolders, setExpandedRestoreFolders] = useState<Set<string>>(new Set());
    const [restoring, setRestoring] = useState(false);

    // ─── Backup Handlers ─────────────────────────────────────────────

    const handleExportBackup = async () => {
        try {
            const path = await save({
                defaultPath: `TagDeck-Playlist-Backup-${new Date().toISOString().slice(0, 10)}.json`,
                filters: [{ name: 'JSON Backup', extensions: ['json'] }],
            });
            if (!path) return;
            setBackupBusy(true);
            const count = await invoke<number>('export_playlist_backup', { path });
            showSuccess(`Backed up ${count} playlist${count !== 1 ? 's' : ''} successfully.`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            showError(`Error: ${msg}`);
        } finally {
            setBackupBusy(false);
        }
    };

    const handleOpenRestoreFile = async () => {
        try {
            const selected = await open({
                multiple: false,
                filters: [{ name: 'JSON Backup', extensions: ['json'] }],
            });
            if (!selected || typeof selected !== 'string') return;
            setBackupBusy(true);
            const entries = await invoke<BackupEntry[]>('read_playlist_backup', { path: selected });
            setRestoreEntries(entries);
            // Pre-select all
            setSelectedRestoreIds(new Set(entries.map(e => e.persistent_id)));
            setExpandedRestoreFolders(new Set());
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            showError(`Error: ${msg}`);
        } finally {
            setBackupBusy(false);
        }
    };

    const handleRestoreApply = async () => {
        if (!restoreEntries) return;
        const chosen = restoreEntries.filter(e => selectedRestoreIds.has(e.persistent_id));
        // Also include parent folders of chosen playlists
        const neededPids = new Set(chosen.map(e => e.persistent_id));
        for (const e of chosen) {
            if (e.parent_persistent_id) {
                // Walk up and include any ancestor folders
                let parentPid: string | undefined = e.parent_persistent_id;
                while (parentPid) {
                    neededPids.add(parentPid);
                    const parent = restoreEntries.find(p => p.persistent_id === parentPid);
                    parentPid = parent?.parent_persistent_id ?? undefined;
                }
            }
        }
        const toRestore = restoreEntries.filter(e => neededPids.has(e.persistent_id));

        try {
            setRestoring(true);
            const count = await invoke<number>('restore_playlist_backup', { entries: toRestore });
            showSuccess(`Restored ${count} playlist${count !== 1 ? 's' : ''} successfully.`);
            setRestoreEntries(null);
            onRefresh();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            showError(`Restore error: ${msg}`);
        } finally {
            setRestoring(false);
        }
    };

    const toggleRestoreSelection = (pid: string) => {
        setSelectedRestoreIds(prev => {
            const next = new Set(prev);
            if (next.has(pid)) {
                next.delete(pid);
            } else {
                next.add(pid);
            }
            return next;
        });
    };

    const toggleRestoreFolder = (pid: string) => {
        setExpandedRestoreFolders(prev => {
            const next = new Set(prev);
            if (next.has(pid)) next.delete(pid); else next.add(pid);
            return next;
        });
    };

    return (
        <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
            <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <HardDriveDownload size={14} /> Playlist Backup
            </h4>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: '1.5' }}>
                Export your playlists and track memberships to a file. Restore them later if anything goes wrong.
            </p>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                    onClick={handleExportBackup}
                    disabled={backupBusy}
                    style={{
                        fontSize: '12px', padding: '6px 12px',
                        background: 'var(--accent-hover)', border: '1px solid var(--accent-color)',
                        color: 'white', borderRadius: '6px', cursor: backupBusy ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', gap: '6px'
                    }}
                >
                    {backupBusy ? <Loader2 size={13} className="spin" /> : <HardDriveDownload size={13} />}
                    Export Backup
                </button>
                <button
                    onClick={handleOpenRestoreFile}
                    disabled={backupBusy}
                    style={{
                        fontSize: '12px', padding: '6px 12px',
                        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                        color: 'var(--text-primary)', borderRadius: '6px', cursor: backupBusy ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', gap: '6px'
                    }}
                >
                    <HardDriveUpload size={13} /> Restore from File
                </button>
            </div>

            {/* ===== Restore Picker Modal ===== */}
            {restoreEntries && (
                <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 1100,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'rgba(0, 0, 0, 0.6)',
                        animation: 'overlayFadeIn 0.15s ease-out',
                    }}
                >
                    <div style={{
                        width: '520px',
                        maxHeight: '70vh',
                        display: 'flex',
                        flexDirection: 'column',
                        backgroundColor: 'var(--bg-secondary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '12px',
                        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                        animation: 'scaleIn 0.15s ease-out',
                        overflow: 'hidden',
                    }}>
                        {/* Header */}
                        <div style={{ padding: '20px 20px 12px', borderBottom: '1px solid var(--border-color)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <HardDriveUpload size={16} /> Restore Playlists
                                </h3>
                                <button
                                    onClick={() => setRestoreEntries(null)}
                                    style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4, display: 'flex' }}
                                >
                                    <X size={16} />
                                </button>
                            </div>
                            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '8px 0 0', lineHeight: '1.4' }}>
                                Choose which playlists to restore. Parent folders will be included automatically.
                            </p>
                            {/* Select all / none */}
                            <div style={{ marginTop: '10px', display: 'flex', gap: '12px', fontSize: '12px' }}>
                                <button
                                    onClick={() => setSelectedRestoreIds(new Set(restoreEntries.map(e => e.persistent_id)))}
                                    style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', padding: 0, fontSize: 'inherit', textDecoration: 'underline' }}
                                >
                                    Select All
                                </button>
                                <button
                                    onClick={() => setSelectedRestoreIds(new Set())}
                                    style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', padding: 0, fontSize: 'inherit', textDecoration: 'underline' }}
                                >
                                    Select None
                                </button>
                                <span style={{ color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                                    {selectedRestoreIds.size} of {restoreEntries.length} selected
                                </span>
                            </div>
                        </div>

                        {/* Playlist tree */}
                        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
                            {(() => {
                                // Build tree from flat entries
                                type TreeNode = BackupEntry & { children: TreeNode[] };
                                const nodeMap = new Map<string, TreeNode>();
                                const roots: TreeNode[] = [];
                                for (const e of restoreEntries) {
                                    nodeMap.set(e.persistent_id, { ...e, children: [] });
                                }
                                for (const e of restoreEntries) {
                                    const node = nodeMap.get(e.persistent_id)!;
                                    if (e.parent_persistent_id && nodeMap.has(e.parent_persistent_id)) {
                                        nodeMap.get(e.parent_persistent_id)!.children.push(node);
                                    } else {
                                        roots.push(node);
                                    }
                                }
                                // Sort: folders first, then alpha
                                const sortTree = (nodes: TreeNode[]) => {
                                    nodes.sort((a, b) => {
                                        if (a.is_folder !== b.is_folder) return a.is_folder ? -1 : 1;
                                        return a.name.localeCompare(b.name);
                                    });
                                    nodes.forEach(n => sortTree(n.children));
                                };
                                sortTree(roots);

                                const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
                                    const isSelected = selectedRestoreIds.has(node.persistent_id);
                                    const isExpanded = expandedRestoreFolders.has(node.persistent_id);
                                    const trackCount = node.is_folder
                                        ? node.children.reduce((sum, c) => sum + (c.is_folder ? 0 : c.tracks.length), 0)
                                        : node.tracks.length;

                                    return (
                                        <div key={node.persistent_id}>
                                            <div
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '6px',
                                                    padding: `5px 16px 5px ${16 + depth * 20}px`,
                                                    fontSize: '13px',
                                                    cursor: 'pointer',
                                                    color: 'var(--text-primary)',
                                                    transition: 'background 0.1s',
                                                    userSelect: 'none',
                                                }}
                                                onClick={() => toggleRestoreSelection(node.persistent_id)}
                                                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                                                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                            >
                                                {/* Expand/collapse for folders */}
                                                {node.is_folder ? (
                                                    <div
                                                        onClick={(e) => { e.stopPropagation(); toggleRestoreFolder(node.persistent_id); }}
                                                        style={{ display: 'flex', alignItems: 'center', minWidth: 14, flexShrink: 0 }}
                                                    >
                                                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                    </div>
                                                ) : (
                                                    <div style={{ width: 14, flexShrink: 0 }} />
                                                )}

                                                {/* Checkbox */}
                                                {isSelected
                                                    ? <CheckSquare size={15} style={{ color: 'var(--accent-color)', flexShrink: 0 }} />
                                                    : <Square size={15} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                                                }

                                                {/* Icon */}
                                                {node.is_folder
                                                    ? <Folder size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                                                    : <ListMusic size={14} style={{ flexShrink: 0 }} />
                                                }

                                                {/* Name */}
                                                <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    {node.name}
                                                </span>

                                                {/* Track count badge */}
                                                {trackCount > 0 && (
                                                    <span style={{
                                                        fontSize: '11px',
                                                        color: 'var(--text-secondary)',
                                                        background: 'var(--bg-primary)',
                                                        padding: '1px 6px',
                                                        borderRadius: '8px',
                                                        flexShrink: 0,
                                                    }}>
                                                        {trackCount}
                                                    </span>
                                                )}
                                            </div>
                                            {node.is_folder && isExpanded && node.children.map(c => renderNode(c, depth + 1))}
                                        </div>
                                    );
                                };

                                return roots.map(r => renderNode(r, 0));
                            })()}
                        </div>

                        {/* Footer */}
                        <div style={{
                            padding: '12px 20px',
                            borderTop: '1px solid var(--border-color)',
                            display: 'flex',
                            justifyContent: 'flex-end',
                            gap: '8px',
                        }}>
                            <button
                                className="btn"
                                onClick={() => setRestoreEntries(null)}
                                style={{ fontSize: '13px', padding: '6px 14px' }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleRestoreApply}
                                disabled={selectedRestoreIds.size === 0 || restoring}
                                style={{
                                    fontSize: '13px', padding: '6px 14px',
                                    background: selectedRestoreIds.size === 0 ? 'var(--bg-tertiary)' : 'var(--accent-hover)',
                                    border: '1px solid var(--accent-color)',
                                    color: 'white', borderRadius: '6px',
                                    cursor: selectedRestoreIds.size === 0 || restoring ? 'not-allowed' : 'pointer',
                                    display: 'flex', alignItems: 'center', gap: '6px',
                                    opacity: selectedRestoreIds.size === 0 ? 0.5 : 1,
                                }}
                            >
                                {restoring ? <Loader2 size={14} className="spin" /> : <HardDriveUpload size={14} />}
                                {restoring ? 'Restoring…' : `Restore ${selectedRestoreIds.size} Playlist${selectedRestoreIds.size !== 1 ? 's' : ''}`}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
