import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';

interface Props {
    refreshTrigger: number;
    onSelect: (track: Track) => void;
    selectedTrackId: number | null;
}

export function TrackList({ refreshTrigger, onSelect, selectedTrackId }: Props) {
    const [tracks, setTracks] = useState<Track[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        loadTracks();
    }, [refreshTrigger]);

    const loadTracks = async () => {
        setLoading(true);
        try {
            const result = await invoke<Track[]>('get_tracks');
            setTracks(result);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{ width: '100%', fontSize: '14px' }}>
            {loading && (
                <div style={{ padding: '20px', color: 'var(--text-secondary)', textAlign: 'center' }}>
                    Loading library...
                </div>
            )}
            
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', userSelect: 'none' }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-primary)', zIndex: 10 }}>
                    <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        <th style={{ padding: '12px 20px', fontWeight: 600 }}>Artist</th>
                        <th style={{ padding: '12px 20px', fontWeight: 600 }}>Title</th>
                        <th style={{ padding: '12px 20px', fontWeight: 600 }}>Comment</th>
                        <th style={{ padding: '12px 20px', fontWeight: 600 }}>Tags</th>
                        <th style={{ width: '40px' }}></th>
                    </tr>
                </thead>
                <tbody>
                    {tracks.map(track => {
                        const isSelected = selectedTrackId === track.id;
                        
                        // Parse Comment vs Tags
                        let userComment = track.comment_raw || '';
                        let tagList: string[] = [];
                        
                        const splitIndex = userComment.indexOf(' && ');
                        if (splitIndex !== -1) {
                            const rawTags = userComment.substring(splitIndex + 4);
                            userComment = userComment.substring(0, splitIndex);
                            // Split tags by "; "
                            tagList = rawTags.split(';').map(t => t.trim()).filter(t => t.length > 0);
                        }
                        
                        return (
                            <tr 
                                key={track.id} 
                                onClick={() => onSelect(track)}
                                style={{ 
                                    borderBottom: '1px solid var(--bg-secondary)',
                                    background: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                                    color: isSelected ? 'var(--accent-color)' : 'var(--text-primary)',
                                    cursor: 'pointer',
                                    transition: 'background 0.1s ease'
                                }}
                                onMouseEnter={(e) => {
                                    if (!isSelected) e.currentTarget.style.background = 'var(--bg-secondary)';
                                }}
                                onMouseLeave={(e) => {
                                    if (!isSelected) e.currentTarget.style.background = 'transparent';
                                }}
                            >
                                <td style={{ padding: '10px 20px', fontWeight: 500 }}>{track.artist}</td>
                                <td style={{ padding: '10px 20px' }}>{track.title}</td>
                                <td style={{ padding: '10px 20px', color: 'var(--text-secondary)', fontSize: '13px' }}>
                                    {userComment}
                                </td>
                                <td style={{ padding: '10px 20px' }}>
                                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                        {tagList.map((tag, i) => (
                                            <span key={i} style={{
                                                fontSize: '11px',
                                                padding: '2px 8px',
                                                borderRadius: '10px',
                                                background: 'var(--bg-tertiary)',
                                                color: 'var(--text-primary)',
                                                border: '1px solid var(--border-color)',
                                                whiteSpace: 'nowrap'
                                            }}>
                                                {tag}
                                            </span>
                                        ))}
                                    </div>
                                </td>
                                <td style={{ padding: '10px 20px', textAlign: 'right' }}>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            invoke('show_in_finder', { path: track.file_path });
                                        }}
                                        title="Show in Finder"
                                        style={{
                                            background: 'transparent',
                                            border: 'none',
                                            cursor: 'pointer',
                                            color: 'var(--text-secondary)',
                                            fontSize: '14px',
                                            opacity: 0.5,
                                            padding: '4px'
                                        }}
                                        onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                        onMouseLeave={e => e.currentTarget.style.opacity = '0.5'}
                                    >
                                        📂
                                    </button>
                                </td>
                            </tr>
                        );
                    })}
                    {tracks.length === 0 && !loading && (
                        <tr>
                            <td colSpan={5} style={{ padding: '60px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                                <div style={{ fontSize: '16px', marginBottom: '8px' }}>Library is empty</div>
                                <div style={{ fontSize: '13px', opacity: 0.7 }}>Import an iTunes XML file to get started</div>
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}
