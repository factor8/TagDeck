import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface Props {
    onTagClick: (tag: string) => void;
    currentTrackTags: string[];
    refreshTrigger: number;
}

export function TagDeck({ onTagClick, currentTrackTags, refreshTrigger }: Props) {
    const [tags, setTags] = useState<string[]>([]);
    const [filter, setFilter] = useState('');

    useEffect(() => {
        loadTags();
    }, [refreshTrigger]);

    const loadTags = async () => {
        try {
            const allTags = await invoke<string[]>('get_global_tags');
            setTags(allTags);
        } catch (e) {
            console.error('Failed to load global tags:', e);
        }
    };

    const filteredTags = tags.filter(t => 
        t.toLowerCase().includes(filter.toLowerCase())
    );

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <h3 style={styles.title}>Tag Deck</h3>
                <input 
                    type="text" 
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter tags..."
                    style={styles.searchInput}
                />
            </div>
            
            <div style={styles.grid}>
                {filteredTags.map(tag => {
                    const isActive = currentTrackTags.includes(tag);
                    return (
                        <div 
                            key={tag}
                            onClick={() => onTagClick(tag)}
                            style={{
                                ...styles.pill,
                                background: isActive ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
                                color: isActive ? '#fff' : 'var(--text-secondary)',
                                border: isActive ? '1px solid var(--accent-color)' : '1px solid rgba(255,255,255,0.1)',
                            }}
                        >
                            {tag}
                        </div>
                    );
                })}
                {filteredTags.length === 0 && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '13px', fontStyle: 'italic', padding: '10px' }}>
                        No tags found. Add tags to tracks to build your deck.
                    </div>
                )}
            </div>
        </div>
    );
}

const styles = {
    container: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column' as const,
        background: 'var(--bg-secondary)',
    },
    header: {
        padding: '15px',
        borderBottom: '1px solid var(--border-color)',
    },
    title: {
        margin: '0 0 10px 0',
        fontSize: '14px',
        fontWeight: 600,
        textTransform: 'uppercase' as const,
        letterSpacing: '1px',
        color: 'var(--text-secondary)',
    },
    searchInput: {
        width: '100%',
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-color)',
        borderRadius: '4px',
        padding: '8px',
        color: '#fff',
        fontSize: '13px',
    },
    grid: {
        padding: '15px',
        overflowY: 'auto' as const,
        display: 'flex',
        flexWrap: 'wrap' as const,
        gap: '8px',
        alignContent: 'flex-start' as const,
        flex: 1,
    },
    pill: {
        padding: '4px 10px',
        borderRadius: '12px',
        fontSize: '12px',
        cursor: 'pointer',
        transition: 'all 0.1s ease',
        userSelect: 'none' as const,
    }
};
