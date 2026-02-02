import { useState, useEffect } from 'react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';

interface Props {
    track: Track | null;
    onUpdate: () => void;
    selectedTrackIds?: Set<number>;
    commonTags?: string[];
}

export function TagEditor({ track, onUpdate, selectedTrackIds, commonTags }: Props) {
    // rawComment is ONLY the Left Side (User Comment)
    const [userComment, setUserComment] = useState('');
    // tags is the Right Side parsed into pills
    const [tags, setTags] = useState<string[]>([]);
    // current input for a new tag
    const [tagInput, setTagInput] = useState('');
    
    const [saving, setSaving] = useState(false);
    
    const isMultiSelect = selectedTrackIds && selectedTrackIds.size > 1;

    useEffect(() => {
        if (isMultiSelect) {
            setUserComment('');
            setTags(commonTags || []);
        } else if (track && track.comment_raw) {
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
    }, [track, isMultiSelect, commonTags]);

    // Define handleSave inside the component scope so it can be used by the effect
    // We wrap it in a function that doesn't depend on stale 'tags' state if we pass overrides
    const saveTagsToBackend = async (tagsToSave: string[], currentComment: string) => {
        if (!track) return;
        setSaving(true);
        
        try {
            const validTags = tagsToSave.map(t => t.trim()).filter(t => t.length > 0);
            const tagBlock = validTags.join('; ');

            // If we have multiple tracks selected, we handle them differently
            // But wait, the backend isn't ready for multi-write yet based on previous files.
            // Oh, we are implementing batch editing now.
            // Phase 3 requirement: "Multi-select tracks... Apply/remove tags across selection"

            // If multiple tracks are selected, we must iterate them or implement a bulk endpoint.
            // For now, let's just loop over the IDs if they are provided.
            
            const idsToUpdate = selectedTrackIds && selectedTrackIds.size > 0 
                ? Array.from(selectedTrackIds) 
                : [track.id];

            // NOTE: This implementation currently OVERWRITES tags for all selected tracks
            // with the state of the editor. This matches "Apply... across selection" if we assume
            // the user wants to sync them. 
            // However, a true "Batch Add" usually means "Preserve existing, add new".
            // The PRD says: "clicking a pill: adds it if absent... Text input: creates new"
            // "Batch Tagging... apply/remove tags across selection"
            
            // For the simplest robust implementation without a dedicated bulk backend command:
            // We should ideally call a modified backend command that can handle merging.
            // But `write_tags` takes the full string.
            
            // If we are just writing ONE track, do the old logic
            if (idsToUpdate.length === 1) {
                // Reconstruct: "User Comment && Tag1; Tag2; Tag3"
                let finalString = currentComment.trim();
                
                if (validTags.length > 0) {
                    if (finalString.length === 0) {
                        finalString = " && " + tagBlock;
                    } else {
                        finalString = finalString + " && " + tagBlock;
                    }
                } 
                await invoke('write_tags', { id: idsToUpdate[0], newTags: finalString });
            } else {
                // Bulk update!
                // We need to decide behavior: Overwrite or Merge?
                // Usually "Tag Editor" implies "Set the tags to THIS".
                // So Overwrite is the expected behavior for an explicit save from this UI.
                // However, preserving the INDIVIDUAL user comments is critical.
                
                // We don't have the User Comments for the other tracks!
                // We only have `track.comment_raw`.
                
                // We need a backend command for "Batch Apply Tags" that preserves comments.
                // For now, let's warn or just support the single track.
                
                // Let's create a new backend command: `batch_update_tags`
                // But since I cannot edit Rust right now without switching context, 
                // let's use `invoke` to loop? No, that's slow.
                
                // Actually, I can edit Rust. I see the Rust files.
                // Let's implement `batch_update_tags` in Rust?
                // Wait, I should stick to UI first if possible.
                // But doing 50 invokes is bad.
                
                // Let's do the Loop in frontend for now (MVP phase 3), 
                // but we need to fetch the data for those tracks to preserve their comments?
                // Or maybe we just blindly invoke `update_tags`?
                
                // BETTER: The PRD says "Batch operations are atomic per track".
                // Let's implement a 'batch_apply_tags' command in Rust that takes a list of IDs and a list of Tags to ADD/REMOVE/SET.
                
                // For this specific 'save' button which represents "Current State", it's a SET operation regarding text.
                // But showing the "Effective State" of multiple tracks is hard.
                // Usually iTunes shows "Mixed" or empty.
                
                // Simplification for Phase 3:
                // Only support Single Track editing fully.
                // For Batch, maybe we only support "Add Tag" actions via the Deck?
                
                // Let's stick effectively to single track saving for the "Text Input" field for now,
                // and make the "Tag Deck" clicks trigger a BATCH ADD/REMOVE.
                
                // If I click a tag in the deck, I want it added to ALL selected tracks.
                // If I click "Save" in the editor... that's ambiguous for batch.
                // Let's Disable the manual "Save" button and text editor for batch selection for now?
                // Or make it apply to all.
                
                // Let's assume for now `write_tags` is only for single track.
                // We will implement `batch_add_tag` and `batch_remove_tag` for the Deck interaction.
                
                if (idsToUpdate.length > 1) {
                    alert("Batch editing of raw text not yet supported. Use the Tag Deck to apply tags to multiple tracks.");
                    return;
                }
                
                let finalString = currentComment.trim();
                 if (validTags.length > 0) {
                    if (finalString.length === 0) {
                         finalString = " && " + tagBlock;
                    } else {
                         finalString = finalString + " && " + tagBlock;
                    }
                } 
                await invoke('write_tags', { id: track.id, newTags: finalString });
            }

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
                
                const idsToUpdate = selectedTrackIds && selectedTrackIds.size > 0 
                ? Array.from(selectedTrackIds) 
                : (track ? [track.id] : []);

                if (idsToUpdate.length === 0) return;

                // Determine Toggle Mode:
                // If current primary track HAS the tag -> REMOVE from ALL
                // If current primary track DOES NOT have the tag -> ADD to ALL
                
                // Case-insensitive check against current state representing primary track
                const isPresent = tags.some(t => t.toLowerCase() === val.toLowerCase());
                
                const command = isPresent ? 'batch_remove_tag' : 'batch_add_tag';
                
                console.log(`Executing ${command} on ${idsToUpdate.length} tracks for tag: ${val}`);

                invoke(command, { ids: idsToUpdate, tag: val })
                    .then(() => {
                         // Optimistic update for Primary Track (UI feedback)
                         if (track) {
                             setTags(prev => {
                                 if (isPresent) {
                                     // Remove
                                     return prev.filter(t => t.toLowerCase() !== val.toLowerCase());
                                 } else {
                                     // Add
                                     return [...prev, val];
                                 }
                             });
                         }
                         onUpdate();
                    })
                    .catch(err => {
                        console.error(err);
                        alert("Batch tag error: " + err);
                    });
            }
        };

        window.addEventListener('add-tag-deck', handleAddTag);
        return () => window.removeEventListener('add-tag-deck', handleAddTag);
    }, [tags, userComment, track, selectedTrackIds]); // Re-bind when state changes to avoid stale closures


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
    
    const addTag = async (valOverride?: string) => {
        const rawVal = (valOverride || tagInput).trim();
        
        // Validation: forbid " && "
        if (rawVal.includes(" && ")) {
            alert("Tags cannot contain ' && ' as it is used as a separator.");
            return;
        }

        if (rawVal) {
            // Capitalize first letter
            const val = rawVal.charAt(0).toUpperCase() + rawVal.slice(1);
            
            if (isMultiSelect) {
                const ids = Array.from(selectedTrackIds || []);
                try {
                    await invoke('batch_add_tag', { ids, tag: val });
                    setTags(prev => {
                        const exists = prev.some(t => t.toLowerCase() === val.toLowerCase());
                        if (exists) return prev;
                        return [...prev, val];
                    });
                    onUpdate();
                } catch (e) {
                    console.error("Batch add failed", e);
                }
            } else {
                setTags(prev => {
                    // Case-insensitive duplicate check using the latest state
                    const exists = prev.some(t => t.toLowerCase() === val.toLowerCase());
                    if (exists) return prev;
                    return [...prev, val];
                });
            }
            
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
            {!isMultiSelect && (
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
            )}

            {/* Tags Section */}
            <div style={{ padding: '0px 0 5px 0' }}>
                <div style={styles.tagContainer} onClick={() => document.getElementById('tag-input')?.focus()}>
                    {tags.map((tag, i) => (
                        <div key={i} style={styles.pill}>
                            {tag}
                            <span 
                                style={{ marginLeft: '4px', cursor: 'pointer', opacity: 0.6 }}
                                onClick={(e) => { 
                                    e.stopPropagation(); 
                                    if (isMultiSelect) {
                                         const ids = Array.from(selectedTrackIds || []);
                                         invoke('batch_remove_tag', { ids, tag }).then(() => {
                                             setTags(tags.filter((_, idx) => idx !== i));
                                             onUpdate();
                                         }).catch(console.error);
                                    } else {
                                        setTags(tags.filter((_, idx) => idx !== i)); 
                                    }
                                }}
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
                <button onClick={handleSave} disabled={saving || isMultiSelect} className="btn btn-primary" style={{ 
                    width: '100%', 
                    fontSize: '12px', 
                    padding: '6px',
                    opacity: isMultiSelect ? 0.5 : 1,
                    cursor: isMultiSelect ? 'default' : 'pointer'
                }}>
                    {isMultiSelect ? 'Batch Editing Active' : (saving ? 'Saving...' : 'Save Changes')}
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
