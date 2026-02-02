import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface Props {
    onTagClick: (tag: string) => void;
    currentTrackTags: string[];
    refreshTrigger: number;
    keyboardMode?: boolean;
}

export function TagDeck({ onTagClick, currentTrackTags, refreshTrigger, keyboardMode = false }: Props) {
    const [tags, setTags] = useState<string[]>([]);
    const [filter, setFilter] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);

    // Keyboard navigation
    useEffect(() => {
        if (!keyboardMode) return;
        
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex(prev => Math.min(prev + 1, filteredTags.length - 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex(prev => Math.max(prev - 1, 0));
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (filteredTags[selectedIndex]) {
                    onTagClick(filteredTags[selectedIndex]);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [keyboardMode, selectedIndex, filter]); // Needs filteredTags dep implicitly through render? No, needs filteredTags from state or memo


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

    // Reset selection when filter changes
    useEffect(() => {
        setSelectedIndex(0);
    }, [filter]);

    return (
        <div style={styles.container} className="no-select">
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
                {filteredTags.map((tag, index) => {
                    const isActive = currentTrackTags.includes(tag);
                    const isSelected = keyboardMode && index === selectedIndex;
                    return (
                        <div 
                            key={tag}
                            onClick={() => onTagClick(tag)}
                            style={{
                                ...styles.pill,
                                background: isSelected 
                                    ? 'var(--accent-color)' 
                                    : isActive ? 'rgba(59, 130, 246, 0.5)' : 'rgba(255,255,255,0.05)',
                                color: isActive || isSelected ? '#fff' : 'var(--text-secondary)',
                                border: isActive ? '1px solid var(--accent-color)' : isSelected ? '1px solid #fff' : '1px solid rgba(255,255,255,0.1)',
                                transform: isSelected ? 'scale(1.05)' : 'scale(1)',
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
        padding: '2px 10px',
        borderRadius: '12px',
        fontSize: '14px',
        cursor: 'pointer',
        transition: 'all 0.1s ease',
        userSelect: 'none' as const,
    }
};
