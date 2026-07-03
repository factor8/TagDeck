import { useEffect, useState, ReactElement } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ClipboardList, X, Loader2, AlertTriangle, Plus, Minus, Pencil, ListMusic } from 'lucide-react';

// ===== Backend contract types (mirrors src-tauri sync review commands) =====

export interface AddedTrack { itunes_pid: string; title: string | null; artist: string | null }
export interface RemovedTrack { track_id: number; itunes_pid: string; title: string | null; artist: string | null }
export interface FieldChange { field: string; old_value: string; new_value: string }
export interface MetadataChange { itunes_pid: string; title: string | null; artist: string | null; changes: FieldChange[]; conflict: boolean }
export interface RatingBpmChange { itunes_pid: string; title: string | null; artist: string | null; old_rating: number; new_rating: number; old_bpm: number; new_bpm: number; conflict: boolean }
export interface PlaylistChange { persistent_id: string; name: string; change_type: 'Added' | 'Modified' | 'Removed' }

export interface SyncPreview {
    added: AddedTrack[];
    added_total: number;
    removed: RemovedTrack[];
    metadata: MetadataChange[];
    rating_bpm: RatingBpmChange[];
    playlists: PlaylistChange[];
}

export interface SyncDecisions {
    import_pids: string[];
    remove_keep_pids: string[];
    remove_delete_pids: string[];
    // Metadata section rows (title/artist/album/comment/grouping):
    apply_itunes_metadata_pids: string[];  // accepted / conflict resolved to iTunes
    keep_tagdeck_metadata_pids: string[];  // conflict resolved to TagDeck
    // Rating/BPM section rows:
    apply_itunes_rating_pids: string[];    // accepted / conflict resolved to iTunes
    keep_tagdeck_rating_pids: string[];    // conflict resolved to TagDeck
    playlist_pids: string[];
}

export interface AppliedSummary {
    imported: number;
    unlinked: number;
    deleted: number;
    tracks_applied: number;
    tracks_kept: number;
    playlists_applied: number;
}

interface Props {
    preview: SyncPreview;
    removalsOnly?: boolean;
    onClose: () => void;
    onApplied: (summary: AppliedSummary) => void;
}

type RemovedChoice = 'keep' | 'delete';
type ConflictChoice = 'itunes' | 'tagdeck';

const trackLabel = (artist: string | null, title: string | null) =>
    `${artist || 'Unknown Artist'} – ${title || 'Unknown Title'}`;

const cardStyle: React.CSSProperties = {
    padding: '16px',
    background: 'var(--bg-tertiary)',
    borderRadius: '8px',
};

const sectionHeaderStyle: React.CSSProperties = {
    fontSize: '13px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '10px',
    marginTop: 0,
    color: 'var(--text-secondary)',
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
};

const textBtnStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    color: 'var(--accent-color)',
    cursor: 'pointer',
    fontSize: '12px',
    padding: 0,
    fontWeight: 500,
};

function SegmentedChoice<T extends string>({
    options,
    value,
    onChange,
}: {
    options: { value: T; label: string }[];
    value: T;
    onChange: (v: T) => void;
}) {
    return (
        <div style={{ display: 'flex', border: '1px solid var(--border-color)', borderRadius: '6px', overflow: 'hidden', flexShrink: 0 }}>
            {options.map((opt, i) => {
                const active = opt.value === value;
                return (
                    <button
                        key={opt.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange(opt.value)}
                        style={{
                            fontSize: '11px',
                            padding: '5px 10px',
                            border: 'none',
                            borderLeft: i === 0 ? 'none' : '1px solid var(--border-color)',
                            background: active ? 'var(--accent-color)' : 'var(--bg-secondary)',
                            color: active ? 'white' : 'var(--text-primary)',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}

export function SyncReviewModal({ preview, removalsOnly = false, onClose, onApplied }: Props) {
    const [addedSelected, setAddedSelected] = useState<Set<string>>(
        () => new Set(preview.added.map(a => a.itunes_pid))
    );
    const [removedDecision, setRemovedDecision] = useState<Record<string, RemovedChoice>>(
        () => Object.fromEntries(preview.removed.map(r => [r.itunes_pid, 'keep' as RemovedChoice]))
    );
    const [metaSelected, setMetaSelected] = useState<Set<string>>(
        () => new Set(preview.metadata.filter(m => !m.conflict).map(m => m.itunes_pid))
    );
    const [metaConflictChoice, setMetaConflictChoice] = useState<Record<string, ConflictChoice>>(
        () => Object.fromEntries(preview.metadata.filter(m => m.conflict).map(m => [m.itunes_pid, 'tagdeck' as ConflictChoice]))
    );
    const [rbSelected, setRbSelected] = useState<Set<string>>(
        () => new Set(preview.rating_bpm.filter(r => !r.conflict).map(r => r.itunes_pid))
    );
    const [rbConflictChoice, setRbConflictChoice] = useState<Record<string, ConflictChoice>>(
        () => Object.fromEntries(preview.rating_bpm.filter(r => r.conflict).map(r => [r.itunes_pid, 'tagdeck' as ConflictChoice]))
    );
    const [playlistSelected, setPlaylistSelected] = useState<Set<string>>(
        () => new Set(preview.playlists.map(p => p.persistent_id))
    );
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !submitting) {
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, [onClose, submitting]);

    const toggleInSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => {
        setter(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    };

    const allAddedSelected = preview.added.length > 0 && addedSelected.size === preview.added.length;
    const toggleAllAdded = () => setAddedSelected(allAddedSelected ? new Set() : new Set(preview.added.map(a => a.itunes_pid)));

    const allPlaylistsSelected = preview.playlists.length > 0 && playlistSelected.size === preview.playlists.length;
    const toggleAllPlaylists = () => setPlaylistSelected(allPlaylistsSelected ? new Set() : new Set(preview.playlists.map(p => p.persistent_id)));

    const setAllRemoved = (choice: RemovedChoice) =>
        setRemovedDecision(Object.fromEntries(preview.removed.map(r => [r.itunes_pid, choice])));

    const totalChanges =
        addedSelected.size +
        preview.removed.length +
        metaSelected.size + Object.keys(metaConflictChoice).length +
        rbSelected.size + Object.keys(rbConflictChoice).length +
        playlistSelected.size;

    const hasAnySection =
        preview.added.length > 0 ||
        preview.removed.length > 0 ||
        preview.metadata.length > 0 ||
        preview.rating_bpm.length > 0 ||
        preview.playlists.length > 0;

    const buildDecisions = (): SyncDecisions => {
        // Per-category decision lists: metadata rows and rating/BPM rows are resolved
        // independently so accepting one category never smuggles in the other.
        const applyItunesMetadata = Array.from(metaSelected);
        const keepTagDeckMetadata: string[] = [];
        Object.entries(metaConflictChoice).forEach(([pid, choice]) =>
            (choice === 'itunes' ? applyItunesMetadata : keepTagDeckMetadata).push(pid));

        const applyItunesRating = Array.from(rbSelected);
        const keepTagDeckRating: string[] = [];
        Object.entries(rbConflictChoice).forEach(([pid, choice]) =>
            (choice === 'itunes' ? applyItunesRating : keepTagDeckRating).push(pid));

        return {
            import_pids: Array.from(addedSelected),
            remove_keep_pids: Object.entries(removedDecision).filter(([, v]) => v === 'keep').map(([k]) => k),
            remove_delete_pids: Object.entries(removedDecision).filter(([, v]) => v === 'delete').map(([k]) => k),
            apply_itunes_metadata_pids: applyItunesMetadata,
            keep_tagdeck_metadata_pids: keepTagDeckMetadata,
            apply_itunes_rating_pids: applyItunesRating,
            keep_tagdeck_rating_pids: keepTagDeckRating,
            playlist_pids: Array.from(playlistSelected),
        };
    };

    const handleApply = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const summary = await invoke<AppliedSummary>('apply_sync_changes', { decisions: buildDecisions() });
            onApplied(summary);
            onClose();
        } catch (e) {
            console.error('Failed to apply sync changes:', e);
            setError(String(e));
        } finally {
            setSubmitting(false);
        }
    };

    const changeTypeColor: Record<PlaylistChange['change_type'], string> = {
        Added: '#10b981',
        Modified: '#3b82f6',
        Removed: '#f43f5e',
    };
    const changeTypeIcon: Record<PlaylistChange['change_type'], ReactElement> = {
        Added: <Plus size={11} />,
        Modified: <Pencil size={11} />,
        Removed: <Minus size={11} />,
    };

    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1100,
                animation: 'overlayFadeIn 0.15s ease-out',
            }}
        >
            <div
                onClick={e => e.stopPropagation()}
                style={{
                    width: '640px',
                    maxHeight: '85vh',
                    display: 'flex',
                    flexDirection: 'column',
                    backgroundColor: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '12px',
                    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                    animation: 'scaleIn 0.15s ease-out',
                }}
            >
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px 0' }}>
                    <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <ClipboardList size={18} />
                        Sync Review
                    </h3>
                    <button
                        onClick={onClose}
                        aria-label="Close"
                        style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}
                    >
                        <X size={18} />
                    </button>
                </div>

                {removalsOnly && (
                    <div style={{ padding: '12px 24px 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        These tracks were removed in iTunes. What should TagDeck do with its copies?
                    </div>
                )}

                {/* Body */}
                <div style={{ padding: '16px 24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {!hasAnySection && (
                        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                            No changes detected.
                        </div>
                    )}

                    {/* Added */}
                    {preview.added.length > 0 && (
                        <div style={cardStyle}>
                            <div style={sectionHeaderStyle}>
                                <span>Added in iTunes ({preview.added_total})</span>
                                <button style={textBtnStyle} onClick={toggleAllAdded}>
                                    {allAddedSelected ? 'Select None' : 'Select All'}
                                </button>
                            </div>
                            {preview.added_total > preview.added.length && (
                                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic', marginBottom: '8px' }}>
                                    Showing first {preview.added.length} of {preview.added_total}; applying imports only the listed items — run again for the rest.
                                </div>
                            )}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {preview.added.map(a => (
                                    <label key={a.itunes_pid} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={addedSelected.has(a.itunes_pid)}
                                            onChange={() => toggleInSet(setAddedSelected, a.itunes_pid)}
                                            style={{ accentColor: 'var(--accent-color)' }}
                                        />
                                        {trackLabel(a.artist, a.title)}
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Removed */}
                    {preview.removed.length > 0 && (
                        <div style={cardStyle}>
                            <div style={sectionHeaderStyle}>
                                <span>Removed from iTunes ({preview.removed.length})</span>
                                <div style={{ display: 'flex', gap: '10px' }}>
                                    <button style={textBtnStyle} onClick={() => setAllRemoved('keep')}>Keep All</button>
                                    <button style={textBtnStyle} onClick={() => setAllRemoved('delete')}>Remove All</button>
                                </div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                {preview.removed.map(r => (
                                    <div key={r.itunes_pid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                                        <span style={{ fontSize: '13px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {trackLabel(r.artist, r.title)}
                                        </span>
                                        <SegmentedChoice
                                            options={[
                                                { value: 'keep', label: 'Keep in TagDeck' },
                                                { value: 'delete', label: 'Remove from TagDeck' },
                                            ]}
                                            value={removedDecision[r.itunes_pid] ?? 'keep'}
                                            onChange={v => setRemovedDecision(prev => ({ ...prev, [r.itunes_pid]: v }))}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Changed metadata */}
                    {preview.metadata.length > 0 && (
                        <div style={cardStyle}>
                            <div style={sectionHeaderStyle}>
                                <span>Changed in iTunes ({preview.metadata.length})</span>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {preview.metadata.map(m => (
                                    <div
                                        key={m.itunes_pid}
                                        style={{
                                            padding: '8px 10px',
                                            borderRadius: '6px',
                                            background: m.conflict ? 'rgba(245, 158, 11, 0.08)' : 'var(--bg-secondary)',
                                            border: m.conflict ? '1px solid rgba(245, 158, 11, 0.4)' : '1px solid var(--border-color)',
                                        }}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                                            {!m.conflict && (
                                                <input
                                                    type="checkbox"
                                                    checked={metaSelected.has(m.itunes_pid)}
                                                    onChange={() => toggleInSet(setMetaSelected, m.itunes_pid)}
                                                    style={{ accentColor: 'var(--accent-color)', marginTop: '2px' }}
                                                />
                                            )}
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-primary)', marginBottom: '4px' }}>
                                                    {trackLabel(m.artist, m.title)}
                                                    {m.conflict && (
                                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.15)', padding: '1px 6px', borderRadius: '999px' }}>
                                                            <AlertTriangle size={10} /> Edited in both
                                                        </span>
                                                    )}
                                                </div>
                                                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                                    {m.changes.map((c, i) => (
                                                        <span key={i}><strong style={{ color: 'var(--text-primary)' }}>{c.field}:</strong> {c.old_value || '(empty)'} → {c.new_value || '(empty)'}</span>
                                                    ))}
                                                </div>
                                            </div>
                                            {m.conflict && (
                                                <SegmentedChoice
                                                    options={[
                                                        { value: 'itunes', label: 'Use iTunes' },
                                                        { value: 'tagdeck', label: 'Keep TagDeck' },
                                                    ]}
                                                    value={metaConflictChoice[m.itunes_pid] ?? 'tagdeck'}
                                                    onChange={v => setMetaConflictChoice(prev => ({ ...prev, [m.itunes_pid]: v }))}
                                                />
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Rating / BPM changes */}
                    {preview.rating_bpm.length > 0 && (
                        <div style={cardStyle}>
                            <div style={sectionHeaderStyle}>
                                <span>Rating / BPM Changed in iTunes ({preview.rating_bpm.length})</span>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {preview.rating_bpm.map(r => (
                                    <div
                                        key={r.itunes_pid}
                                        style={{
                                            padding: '8px 10px',
                                            borderRadius: '6px',
                                            background: r.conflict ? 'rgba(245, 158, 11, 0.08)' : 'var(--bg-secondary)',
                                            border: r.conflict ? '1px solid rgba(245, 158, 11, 0.4)' : '1px solid var(--border-color)',
                                        }}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                                            {!r.conflict && (
                                                <input
                                                    type="checkbox"
                                                    checked={rbSelected.has(r.itunes_pid)}
                                                    onChange={() => toggleInSet(setRbSelected, r.itunes_pid)}
                                                    style={{ accentColor: 'var(--accent-color)', marginTop: '2px' }}
                                                />
                                            )}
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-primary)', marginBottom: '4px' }}>
                                                    {trackLabel(r.artist, r.title)}
                                                    {r.conflict && (
                                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.15)', padding: '1px 6px', borderRadius: '999px' }}>
                                                            <AlertTriangle size={10} /> Edited in both
                                                        </span>
                                                    )}
                                                </div>
                                                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                                    {r.old_rating !== r.new_rating && (
                                                        <span><strong style={{ color: 'var(--text-primary)' }}>Rating:</strong> {r.old_rating} → {r.new_rating}</span>
                                                    )}
                                                    {r.old_bpm !== r.new_bpm && (
                                                        <span><strong style={{ color: 'var(--text-primary)' }}>BPM:</strong> {r.old_bpm} → {r.new_bpm}</span>
                                                    )}
                                                </div>
                                            </div>
                                            {r.conflict && (
                                                <SegmentedChoice
                                                    options={[
                                                        { value: 'itunes', label: 'Use iTunes' },
                                                        { value: 'tagdeck', label: 'Keep TagDeck' },
                                                    ]}
                                                    value={rbConflictChoice[r.itunes_pid] ?? 'tagdeck'}
                                                    onChange={v => setRbConflictChoice(prev => ({ ...prev, [r.itunes_pid]: v }))}
                                                />
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Playlists */}
                    {preview.playlists.length > 0 && (
                        <div style={cardStyle}>
                            <div style={sectionHeaderStyle}>
                                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><ListMusic size={13} /> Playlists ({preview.playlists.length})</span>
                                <button style={textBtnStyle} onClick={toggleAllPlaylists}>
                                    {allPlaylistsSelected ? 'Select None' : 'Select All'}
                                </button>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {preview.playlists.map(p => (
                                    <label key={p.persistent_id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={playlistSelected.has(p.persistent_id)}
                                            onChange={() => toggleInSet(setPlaylistSelected, p.persistent_id)}
                                            style={{ accentColor: 'var(--accent-color)' }}
                                        />
                                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '10px', fontWeight: 600, color: changeTypeColor[p.change_type] }}>
                                            {changeTypeIcon[p.change_type]} {p.change_type}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', flexShrink: 0 }}>
                    {error && (
                        <span style={{ fontSize: '12px', color: '#f43f5e', marginRight: 'auto', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {error}
                        </span>
                    )}
                    <button className="btn" onClick={onClose} disabled={submitting}>Cancel</button>
                    <button
                        className="btn btn-primary"
                        onClick={handleApply}
                        disabled={submitting || totalChanges === 0}
                        style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                    >
                        {submitting && <Loader2 size={14} className="spin" />}
                        {submitting ? 'Applying…' : `Apply (${totalChanges} change${totalChanges !== 1 ? 's' : ''})`}
                    </button>
                </div>
            </div>
        </div>
    );
}
