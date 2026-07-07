import { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Search, Folder, ListMusic, Music } from 'lucide-react';
import { Playlist } from '../types';

interface PlaylistCommandPaletteProps {
    isOpen: boolean;
    onClose: () => void;
    onJump: (playlist: Playlist) => void;
}

interface ScoredPlaylist {
    playlist: Playlist;
    score: number;
}

// Case-insensitive subsequence match with a score that prefers exact
// substrings (earlier index = better), then prefix-of-word matches, then
// longer contiguous runs. Returns null when the query doesn't match at all.
function fuzzyScore(name: string, query: string): number | null {
    const n = name.toLowerCase();
    const q = query.toLowerCase();
    if (q.length === 0) return 0;

    const substringIdx = n.indexOf(q);
    if (substringIdx !== -1) {
        // Exact substring match — big bonus, more for earlier matches.
        let score = 1000 - substringIdx;
        // Extra bonus if it starts a word (start of string or after a space).
        if (substringIdx === 0 || /\s/.test(n[substringIdx - 1])) {
            score += 200;
        }
        return score;
    }

    // Subsequence match: walk through name, consuming query chars in order,
    // rewarding contiguous runs.
    let qi = 0;
    let score = 0;
    let runLength = 0;
    for (let ni = 0; ni < n.length && qi < q.length; ni++) {
        if (n[ni] === q[qi]) {
            runLength += 1;
            score += runLength; // contiguous runs score progressively higher
            qi += 1;
        } else {
            runLength = 0;
        }
    }
    if (qi < q.length) return null; // not all query chars were consumed

    return score;
}

function buildBreadcrumb(playlist: Playlist, pMap: Map<string, Playlist>): string {
    const parts: string[] = [];
    let parentId = playlist.parent_persistent_id;
    while (parentId) {
        const parent = pMap.get(parentId);
        if (!parent) break;
        parts.unshift(parent.name);
        parentId = parent.parent_persistent_id;
    }
    return parts.join(' › ');
}

export function PlaylistCommandPalette({ isOpen, onClose, onJump }: PlaylistCommandPaletteProps) {
    const [playlists, setPlaylists] = useState<Playlist[]>([]);
    const [query, setQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) return;
        setQuery('');
        setSelectedIndex(0);
        invoke<Playlist[]>('get_playlists')
            .then(setPlaylists)
            .catch((e) => console.error('Failed to load playlists', e));
        // Autofocus on open
        requestAnimationFrame(() => {
            inputRef.current?.focus();
        });
    }, [isOpen]);

    const pMap = useMemo(() => new Map(playlists.map(p => [p.persistent_id, p])), [playlists]);

    const results = useMemo(() => {
        const trimmed = query.trim();
        if (trimmed.length === 0) {
            return [...playlists].sort((a, b) => a.name.localeCompare(b.name));
        }
        const scored: ScoredPlaylist[] = [];
        for (const p of playlists) {
            const score = fuzzyScore(p.name, trimmed);
            if (score !== null) scored.push({ playlist: p, score });
        }
        scored.sort((a, b) => b.score - a.score || a.playlist.name.localeCompare(b.playlist.name));
        return scored.map(s => s.playlist);
    }, [playlists, query]);

    useEffect(() => {
        setSelectedIndex(0);
    }, [query]);

    useEffect(() => {
        if (!isOpen) return;
        const row = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
        row?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex, isOpen]);

    if (!isOpen) return null;

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            setSelectedIndex(prev => Math.min(prev + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setSelectedIndex(prev => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            const selected = results[selectedIndex];
            if (selected) {
                onJump(selected);
                onClose();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
        }
    };

    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.4)',
                zIndex: 1200,
                display: 'flex',
                justifyContent: 'center',
                animation: 'overlayFadeIn 0.15s ease-out',
            }}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                style={{
                    marginTop: '15vh',
                    width: '520px',
                    maxWidth: '90vw',
                    height: 'fit-content',
                    maxHeight: '70vh',
                    display: 'flex',
                    flexDirection: 'column',
                    backgroundColor: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '10px',
                    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                    animation: 'scaleIn 0.15s ease-out',
                    overflow: 'hidden',
                }}
            >
                {/* Search input row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px' }}>
                    <Search size={15} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                    <input
                        ref={inputRef}
                        type="text"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Jump to playlist…"
                        style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: '14px',
                            background: 'transparent',
                            border: 'none',
                            outline: 'none',
                            color: 'var(--text-primary)',
                            padding: 0,
                        }}
                    />
                </div>

                <div style={{ height: '1px', background: 'var(--border-color)', flexShrink: 0 }} />

                {/* Results list */}
                <div ref={listRef} style={{ maxHeight: '45vh', overflowY: 'auto', padding: '6px' }}>
                    {results.length === 0 ? (
                        <div style={{
                            padding: '24px 12px',
                            textAlign: 'center',
                            color: 'var(--text-secondary)',
                            fontSize: '12px',
                            fontStyle: 'italic',
                        }}>
                            No matching playlists
                        </div>
                    ) : (
                        results.map((p, index) => {
                            const isSelected = index === selectedIndex;
                            const breadcrumb = buildBreadcrumb(p, pMap);
                            const Icon = p.is_folder ? Folder : ListMusic;
                            return (
                                <div
                                    key={p.persistent_id}
                                    data-index={index}
                                    onMouseMove={() => {
                                        if (selectedIndex !== index) setSelectedIndex(index);
                                    }}
                                    onClick={() => {
                                        onJump(p);
                                        onClose();
                                    }}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        padding: '7px 12px',
                                        borderRadius: '6px',
                                        cursor: 'default',
                                        backgroundColor: isSelected ? 'var(--accent-color)' : 'transparent',
                                        color: isSelected ? '#fff' : 'var(--text-primary)',
                                    }}
                                >
                                    <Icon size={15} style={{ flexShrink: 0, opacity: isSelected ? 1 : 0.8 }} />
                                    <span style={{
                                        fontSize: '13px',
                                        whiteSpace: 'nowrap',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        flexShrink: 0,
                                        maxWidth: '55%',
                                    }}>
                                        {p.name}
                                    </span>
                                    {breadcrumb && (
                                        <span style={{
                                            fontSize: '11px',
                                            color: isSelected ? 'rgba(255, 255, 255, 0.75)' : 'var(--text-secondary)',
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            minWidth: 0,
                                        }}>
                                            {breadcrumb}
                                        </span>
                                    )}
                                    <div style={{ flex: 1 }} />
                                    {p.itunes_sync_enabled && (
                                        <span style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '3px',
                                            fontSize: '10px',
                                            flexShrink: 0,
                                            padding: '2px 6px',
                                            borderRadius: '999px',
                                            backgroundColor: isSelected ? 'rgba(255, 255, 255, 0.2)' : 'var(--bg-tertiary)',
                                            color: isSelected ? '#fff' : 'var(--text-secondary)',
                                        }}>
                                            <Music size={11} />
                                            iTunes
                                        </span>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>

                <div style={{ height: '1px', background: 'var(--border-color)', flexShrink: 0 }} />

                {/* Footer hint row */}
                <div style={{
                    display: 'flex',
                    gap: '16px',
                    padding: '8px 16px',
                    fontSize: '11px',
                    color: 'var(--text-secondary)',
                    flexShrink: 0,
                }}>
                    <span>↑↓ Navigate</span>
                    <span>↩ Open</span>
                    <span>esc Close</span>
                </div>
            </div>
        </div>
    );
}
