import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Search, X, Music, ListMusic, ChevronRight, Check, Loader2 } from 'lucide-react';
import { Track } from '../types';

interface PlaylistInfo {
    id: number;
    persistent_id: string;
    name: string;
}

interface Props {
    /** The track that will be ADDED to playlists (the new/target track) */
    targetTrack: Track;
    onClose: () => void;
    onComplete: (message: string) => void;
    onError: (message: string) => void;
    onRefresh: () => void;
}

type Step = 'pick-source' | 'confirm';

export function CopyPlaylistsModal({ targetTrack, onClose, onComplete, onError, onRefresh }: Props) {
    const [step, setStep] = useState<Step>('pick-source');
    const [searchTerm, setSearchTerm] = useState('');
    const [sourceTrack, setSourceTrack] = useState<Track | null>(null);
    const [playlists, setPlaylists] = useState<PlaylistInfo[]>([]);
    const [selectedPlaylistIds, setSelectedPlaylistIds] = useState<Set<number>>(new Set());
    const [combinePlayCounts, setCombinePlayCounts] = useState(false);
    const [removeSource, setRemoveSource] = useState(false);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [allTracks, setAllTracks] = useState<Track[]>([]);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Load all tracks on mount
    useEffect(() => {
        invoke<Track[]>('get_tracks')
            .then(setAllTracks)
            .catch(e => console.error('Failed to load tracks:', e));
    }, []);

    // Focus search input on mount
    useEffect(() => {
        setTimeout(() => searchInputRef.current?.focus(), 100);
    }, []);

    // Filter tracks for the picker (exclude the target track itself)
    const filteredTracks = useMemo(() => {
        const term = searchTerm.toLowerCase().trim();
        return allTracks
            .filter(t => t.id !== targetTrack.id)
            .filter(t => {
                if (!term) return true;
                const artist = (t.artist || '').toLowerCase();
                const title = (t.title || '').toLowerCase();
                const album = (t.album || '').toLowerCase();
                return artist.includes(term) || title.includes(term) || album.includes(term);
            })
            .slice(0, 200); // Cap results for performance
    }, [allTracks, targetTrack.id, searchTerm]);

    // When a source track is picked, fetch its playlists
    const handlePickSource = useCallback(async (track: Track) => {
        setSourceTrack(track);
        setLoading(true);
        try {
            const result = await invoke<PlaylistInfo[]>('get_playlists_for_track', { trackId: track.id });
            setPlaylists(result);
            // Pre-select all playlists
            setSelectedPlaylistIds(new Set(result.map(p => p.id)));
            setStep('confirm');
        } catch (e) {
            console.error('Failed to get playlists for track:', e);
            onError(`Failed to get playlists: ${e}`);
        } finally {
            setLoading(false);
        }
    }, [onError]);

    const togglePlaylist = (id: number) => {
        setSelectedPlaylistIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const selectAll = () => setSelectedPlaylistIds(new Set(playlists.map(p => p.id)));
    const selectNone = () => setSelectedPlaylistIds(new Set());

    const handleConfirm = async () => {
        if (!sourceTrack || selectedPlaylistIds.size === 0) return;
        setSubmitting(true);
        try {
            const result = await invoke<string>('copy_playlist_memberships', {
                targetTrackId: targetTrack.id,
                sourceTrackId: sourceTrack.id,
                playlistIds: Array.from(selectedPlaylistIds),
                combinePlayCounts,
                removeSource,
            });
            onComplete(result);
            onRefresh();
            onClose();
        } catch (e) {
            console.error('Failed to copy playlist memberships:', e);
            onError(`Failed: ${e}`);
        } finally {
            setSubmitting(false);
        }
    };

    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
    };

    // Handle Escape key
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                if (step === 'confirm') {
                    setStep('pick-source');
                    setSourceTrack(null);
                    setPlaylists([]);
                    setTimeout(() => searchInputRef.current?.focus(), 50);
                } else {
                    onClose();
                }
            }
        };
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, [step, onClose]);

    const formatDuration = (secs: number) => {
        if (!secs) return '';
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const targetLabel = `${targetTrack.artist || 'Unknown'} — ${targetTrack.title || 'Unknown'}`;

    return (
        <div className="cpm-backdrop" onClick={handleBackdropClick}>
            <div className="cpm-modal" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="cpm-header">
                    <div className="cpm-header-content">
                        <ListMusic size={18} />
                        <span className="cpm-header-title">Copy Playlist Memberships</span>
                    </div>
                    <button className="cpm-close-btn" onClick={onClose}>
                        <X size={16} />
                    </button>
                </div>

                {/* Target Track Banner */}
                <div className="cpm-target-banner">
                    <span className="cpm-target-label">Adding to playlists:</span>
                    <span className="cpm-target-track">
                        <Music size={14} />
                        {targetLabel}
                        {targetTrack.bit_rate ? <span className="cpm-bitrate">{targetTrack.bit_rate} kbps</span> : null}
                    </span>
                </div>

                {/* Step 1: Pick Source */}
                {step === 'pick-source' && (
                    <div className="cpm-step">
                        <div className="cpm-step-header">
                            <span className="cpm-step-number">1</span>
                            <span>Select the track to copy playlists <em>from</em></span>
                        </div>
                        <div className="cpm-search-box">
                            <Search size={14} />
                            <input
                                ref={searchInputRef}
                                type="text"
                                placeholder="Search by artist, title, or album…"
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="cpm-search-input"
                            />
                            {searchTerm && (
                                <button className="cpm-search-clear" onClick={() => setSearchTerm('')}>
                                    <X size={12} />
                                </button>
                            )}
                        </div>
                        <div className="cpm-track-list" ref={listRef}>
                            {loading && (
                                <div className="cpm-loading">
                                    <Loader2 size={20} className="spin" />
                                    <span>Loading playlists…</span>
                                </div>
                            )}
                            {!loading && filteredTracks.length === 0 && (
                                <div className="cpm-empty">
                                    {searchTerm ? `No tracks matching "${searchTerm}"` : 'No tracks available'}
                                </div>
                            )}
                            {!loading && filteredTracks.map(track => (
                                <div
                                    key={track.id}
                                    className="cpm-track-item"
                                    onClick={() => handlePickSource(track)}
                                >
                                    <div className="cpm-track-info">
                                        <span className="cpm-track-artist">{track.artist || 'Unknown'}</span>
                                        <span className="cpm-track-separator">—</span>
                                        <span className="cpm-track-title">{track.title || 'Unknown'}</span>
                                    </div>
                                    <div className="cpm-track-meta">
                                        {track.bit_rate ? <span className="cpm-bitrate">{track.bit_rate} kbps</span> : null}
                                        <span className="cpm-track-duration">{formatDuration(track.duration_secs)}</span>
                                        <ChevronRight size={14} className="cpm-track-arrow" />
                                    </div>
                                </div>
                            ))}
                            {!loading && filteredTracks.length === 200 && (
                                <div className="cpm-truncated">
                                    Showing first 200 results. Narrow your search.
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Step 2: Confirm */}
                {step === 'confirm' && sourceTrack && (
                    <div className="cpm-step">
                        <div className="cpm-step-header">
                            <span className="cpm-step-number">2</span>
                            <span>Confirm playlists to add to</span>
                        </div>

                        {/* Source track info */}
                        <div className="cpm-source-info">
                            <span className="cpm-source-label">Copying from:</span>
                            <span className="cpm-source-track">
                                {sourceTrack.artist || 'Unknown'} — {sourceTrack.title || 'Unknown'}
                                {sourceTrack.bit_rate ? <span className="cpm-bitrate">{sourceTrack.bit_rate} kbps</span> : null}
                            </span>
                            <button className="cpm-change-btn" onClick={() => {
                                setStep('pick-source');
                                setSourceTrack(null);
                                setPlaylists([]);
                                setTimeout(() => searchInputRef.current?.focus(), 50);
                            }}>
                                Change
                            </button>
                        </div>

                        {/* Playlist list */}
                        {playlists.length === 0 ? (
                            <div className="cpm-empty" style={{ margin: '20px 0' }}>
                                This track is not in any playlists.
                            </div>
                        ) : (
                            <>
                                <div className="cpm-playlist-actions">
                                    <button className="cpm-text-btn" onClick={selectAll}>Select All</button>
                                    <span className="cpm-separator">·</span>
                                    <button className="cpm-text-btn" onClick={selectNone}>Select None</button>
                                    <span className="cpm-playlist-count">
                                        {selectedPlaylistIds.size} of {playlists.length} selected
                                    </span>
                                </div>
                                <div className="cpm-playlist-list">
                                    {playlists.map(pl => (
                                        <label key={pl.id} className="cpm-playlist-item">
                                            <input
                                                type="checkbox"
                                                checked={selectedPlaylistIds.has(pl.id)}
                                                onChange={() => togglePlaylist(pl.id)}
                                            />
                                            <span className="cpm-checkbox-custom">
                                                {selectedPlaylistIds.has(pl.id) && <Check size={12} />}
                                            </span>
                                            <ListMusic size={14} className="cpm-playlist-icon" />
                                            <span className="cpm-playlist-name">{pl.name}</span>
                                        </label>
                                    ))}
                                </div>
                            </>
                        )}

                        {/* Options */}
                        <div className="cpm-options">
                            <label className="cpm-option">
                                <input
                                    type="checkbox"
                                    checked={combinePlayCounts}
                                    onChange={e => setCombinePlayCounts(e.target.checked)}
                                />
                                <span className="cpm-checkbox-custom">
                                    {combinePlayCounts && <Check size={12} />}
                                </span>
                                <span>Combine play counts of both tracks</span>
                            </label>
                            <label className="cpm-option">
                                <input
                                    type="checkbox"
                                    checked={removeSource}
                                    onChange={e => setRemoveSource(e.target.checked)}
                                />
                                <span className="cpm-checkbox-custom">
                                    {removeSource && <Check size={12} />}
                                </span>
                                <span>Remove source track from these playlists</span>
                            </label>
                        </div>

                        {/* Footer */}
                        <div className="cpm-footer">
                            <button className="btn" onClick={onClose}>Cancel</button>
                            <button
                                className="btn btn-primary"
                                disabled={selectedPlaylistIds.size === 0 || submitting}
                                onClick={handleConfirm}
                            >
                                {submitting ? (
                                    <>
                                        <Loader2 size={14} className="spin" />
                                        Processing…
                                    </>
                                ) : (
                                    `Add to ${selectedPlaylistIds.size} Playlist${selectedPlaylistIds.size !== 1 ? 's' : ''}`
                                )}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
