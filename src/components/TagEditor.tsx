import { useState, useEffect } from 'react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';

interface Props {
    track: Track | null;
    onUpdate: () => void;
}

export function TagEditor({ track, onUpdate }: Props) {
    // rawComment is ONLY the Left Side (User Comment)
    const [userComment, setUserComment] = useState('');
    // tags is the Right Side parsed into pills
    const [tags, setTags] = useState<string[]>([]);
    // current input for a new tag
    const [tagInput, setTagInput] = useState('');
    
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (track && track.comment_raw) {
            const raw = track.comment_raw;
            // Split only on the FIRST " && " to separate User Comment from Tag Block
            const splitIndex = raw.indexOf(' && ');
            
            if (splitIndex !== -1) {
                const commentPart = raw.substring(0, splitIndex);
                const tagBlockPart = raw.substring(splitIndex + 4); // 4 is length of " && "
                
                setUserComment(commentPart);
                
                // Now split the Tag Block by "; " (or just ";" and trim)
                const parsedTags = tagBlockPart.split(';').map(t => t.trim()).filter(t => t.length > 0);
                setTags(parsedTags);
            } else {
                setUserComment(raw);
                setTags([]);
            }
        } else {
            setUserComment('');
            setTags([]);
        }
        setTagInput('');
    }, [track]);

    // Define handleSave inside the component scope so it can be used by the effect
    // We wrap it in a function that doesn't depend on stale 'tags' state if we pass overrides
    const saveTagsToBackend = async (tagsToSave: string[], currentComment: string) => {
        if (!track) return;
        setSaving(true);
        
        // Reconstruct: "User Comment && Tag1; Tag2; Tag3"
        let finalString = currentComment.trim();
        
        const validTags = tagsToSave.map(t => t.trim()).filter(t => t.length > 0);
        const tagBlock = validTags.join('; ');
        
        if (validTags.length > 0) {
            if (finalString.length === 0) {
                 finalString = " && " + tagBlock;
            } else {
                 finalString = finalString + " && " + tagBlock;
            }
        } 

        try {
            await invoke('write_tags', { id: track.id, newTags: finalString });
            onUpdate(); 
        } catch (e) {
            console.error(e);
            alert('Failed to save tags: ' + e);
        } finally {
            setSaving(false);
        }
    };

    // Public wrapper for the manual save button
    const handleSave = () => saveTagsToBackend(tags, userComment);

    // Listen for tags from the Deck
    useEffect(() => {
        const handleAddTag = (e: any) => {
            const rawTag = e.detail;
            if (rawTag) {
                const val = rawTag.trim().charAt(0).toUpperCase() + rawTag.trim().slice(1);
                
                // Case-insensitive check
                const exists = tags.some(t => t.toLowerCase() === val.toLowerCase());

                if (!exists) {
                     const updatedTags = [...tags, val];
                     setTags(updatedTags);
                     // Auto-Save immediately using the FRESH values we just calculated
                     saveTagsToBackend(updatedTags, userComment);
                }
            }
        };

        window.addEventListener('add-tag-deck', handleAddTag);
        return () => window.removeEventListener('add-tag-deck', handleAddTag);
    }, [tags, userComment, track]); // Re-bind when state changes to avoid stale closures

    const handleTagInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addTag();
        } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
            // Remove last tag
            setTags(prev => prev.slice(0, -1));
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
             handleSave();
        }
    };
    
    const addTag = (valOverride?: string) => {
        const rawVal = (valOverride || tagInput).trim();
        if (rawVal) {
            // Capitalize first letter
            const val = rawVal.charAt(0).toUpperCase() + rawVal.slice(1);
            
            setTags(prev => {
                // Case-insensitive duplicate check using the latest state
                const exists = prev.some(t => t.toLowerCase() === val.toLowerCase());
                if (exists) return prev;
                return [...prev, val];
            });
            
            if (!valOverride) setTagInput('');
        }
    };

    const handleTagInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        
        // Delimiter checking: semicolon, comma
        if (val.includes(';') || val.includes(',')) {
            const parts = val.split(/[;,]/);
            parts.forEach(p => addTag(p));
            setTagInput('');
            return;
        }

        // Double space delimiter
        if (val.endsWith('  ')) {
            addTag(val.trim());
            setTagInput('');
            return;
        }

        setTagInput(val);
    };

    if (!track) return null;

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <h3 style={{ margin: 0, fontSize: '12px', fontWeight: 600 }}>QUICK TAG</h3>
                <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>⌘+Enter to save</span>
            </div>
            
            {/* User Comment Section */}
            <div style={{ padding: '0px 0 5px 0' }}>
                <input 
                    type="text"
                    value={userComment}
                    onChange={e => setUserComment(e.target.value)}
                    style={styles.input}
                    placeholder="Comment..."
                    onKeyDown={e => { if(e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave(); }}
                />
            </div>

            {/* Tags Section */}
            <div style={{ padding: '0px 0 5px 0' }}>
                <div style={styles.tagContainer} onClick={() => document.getElementById('tag-input')?.focus()}>
                    {tags.map((tag, i) => (
                        <div key={i} style={styles.pill}>
                            {tag}
                            <span 
                                style={{ marginLeft: '4px', cursor: 'pointer', opacity: 0.6 }}
                                onClick={(e) => { e.stopPropagation(); setTags(tags.filter((_, idx) => idx !== i)); }}
                            >×</span>
                        </div>
                    ))}
                    <input 
                        id="tag-input"
                        type="text"
                        value={tagInput}
                        onChange={handleTagInputChange}
                        onKeyDown={handleTagInputKeyDown}
                        style={styles.ghostInput}
                        placeholder={tags.length === 0 ? "Add tags..." : ""}
                    />
                </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0px' }}>
                <button onClick={handleSave} disabled={saving} className="btn btn-primary" style={{ width: '100%', fontSize: '12px', padding: '6px' }}>
                    {saving ? 'Saving...' : 'Save Changes'}
                </button>
            </div>
        </div>
    );
}

const styles = {
    container: {
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        borderBottom: '1px solid var(--border-color)',
        padding: '10px',
        boxSizing: 'border-box' as const,
        display: 'flex',
        flexDirection: 'column' as const,
        gap: '6px'
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '4px',
        paddingBottom: '4px',
        borderBottom: '1px solid var(--border-color)'
    },
    input: {
        width: '100%',
        padding: '6px 8px',
        borderRadius: '4px',
        border: '1px solid var(--bg-tertiary)',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        fontSize: '12px',
        outline: 'none',
        marginBottom: '2px'
    },
    tagContainer: {
        display: 'flex',
        flexWrap: 'wrap' as const,
        gap: '4px',
        padding: '6px',
        borderRadius: '4px',
        border: '1px solid var(--bg-tertiary)',
        background: 'var(--bg-primary)',
        minHeight: '60px',
        cursor: 'text'
    },
    pill: {
        background: 'rgba(59, 130, 246, 0.2)', // Accent transparent
        color: 'var(--accent-color)',
        padding: '2px 8px',
        borderRadius: '10px',
        fontSize: '11px',
        display: 'flex',
        alignItems: 'center',
        border: '1px solid rgba(59, 130, 246, 0.3)'
    },
    ghostInput: {
        border: 'none',
        background: 'transparent',
        color: 'var(--text-primary)',
        fontSize: '12px',
        outline: 'none',
        flex: 1,
        minWidth: '50px'
    },
    // We use .btn class now
    button: {} 
};
