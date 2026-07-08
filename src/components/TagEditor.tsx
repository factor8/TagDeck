import { useState, useEffect, useCallback } from 'react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Info, Sparkles, Loader2, Plus } from 'lucide-react';
import { Track } from '../types';
import { useToast } from './Toast';
import { MetadataViewer } from './MetadataViewer';

interface Props {
    track: Track | null;
    onUpdate: () => void;
    selectedTrackIds?: Set<number>;
    commonTags?: string[];
}

interface Suggestion {
    tag_id: number;
    name: string;
    group_id?: number | null;
    score: number;
    source: string;
}

interface NewTagSuggestion {
    candidate_id: number;
    name: string;
    group_id?: number | null;
    score: number;
}

interface SuggestionsResponse {
    analyzed: boolean;
    suggestions: Suggestion[];
    new_tags: NewTagSuggestion[];
}

// Result of batch_add_tag / batch_remove_tag. Anything in failed_ids (file
// unwritable) or missing_ids (id no longer in DB, e.g. a stale Spotify-ghost id
// left behind by a merge) was NOT persisted and must be surfaced, not hidden.
interface BatchTagResult {
    updated: number;
    failed_ids: number[];
    missing_ids: number[];
}

const batchTagFailures = (res: BatchTagResult): number[] =>
    [...(res.missing_ids || []), ...(res.failed_ids || [])];

export function TagEditor({ track, onUpdate, selectedTrackIds, commonTags }: Props) {
    const { showError } = useToast();
    // rawComment is ONLY the Left Side (User Comment)
    const [userComment, setUserComment] = useState('');
    // tags is the Right Side parsed into pills
    const [tags, setTags] = useState<string[]>([]);

    // current input for a new tag
    const [tagInput, setTagInput] = useState('');
    
    const [showInfo, setShowInfo] = useState(false);

    // AI tag suggestions (single-select only).
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [analyzed, setAnalyzed] = useState(true);
    const [dismissed, setDismissed] = useState<Set<number>>(new Set());
    const [analyzing, setAnalyzing] = useState(false);
    const [newTags, setNewTags] = useState<NewTagSuggestion[]>([]);
    const [dismissedNew, setDismissedNew] = useState<Set<number>>(new Set());

    const isMultiSelect = selectedTrackIds && selectedTrackIds.size > 1;

    const fetchSuggestions = useCallback(async (trackId: number) => {
        try {
            const resp = await invoke<SuggestionsResponse>('get_tag_suggestions', { trackId });
            setAnalyzed(resp.analyzed);
            setSuggestions(resp.suggestions);
            setNewTags(resp.new_tags ?? []);
        } catch (e) {
            // No model / no embeddings yet — stay silent, just show nothing.
            console.debug('get_tag_suggestions:', e);
            setSuggestions([]);
            setNewTags([]);
        }
    }, []);

    // Load suggestions when a single track is selected; clear on multi/none.
    useEffect(() => {
        setDismissed(new Set());
        setDismissedNew(new Set());
        if (track && !isMultiSelect) {
            fetchSuggestions(track.id);
        } else {
            setSuggestions([]);
            setNewTags([]);
            setAnalyzed(true);
        }
    }, [track, isMultiSelect, fetchSuggestions]);

    // Refresh suggestions for the current track when a batch analysis finishes
    // (its embedding may have just been created).
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let active = true;
        listen('analysis-complete', () => {
            setAnalyzing(false);
            if (track && !isMultiSelect) fetchSuggestions(track.id);
        }).then((u) => {
            if (active) unlisten = u;
            else u();
        });
        return () => {
            active = false;
            unlisten?.();
        };
    }, [track, isMultiSelect, fetchSuggestions]);

    const acceptSuggestion = async (s: Suggestion) => {
        setSuggestions((prev) => prev.filter((x) => x.tag_id !== s.tag_id));
        await addTag(s.name);
    };

    const acceptNewTag = async (c: NewTagSuggestion) => {
        // Optimistically hide the chip.
        setDismissedNew((prev) => new Set(prev).add(c.candidate_id));
        // Reuse the normal write path — this creates the tag via sync_tags.
        await addTag(c.name);
        try {
            // File it in its group + copy the curated description + retire the candidate.
            await invoke('finalize_accepted_candidate', { candidateId: c.candidate_id });
        } catch (e) {
            // Tag was still created (just uncategorized) — non-fatal.
            console.error('finalize_accepted_candidate failed', e);
        }
        onUpdate();
        if (track) fetchSuggestions(track.id);
    };

    const dismissSuggestion = (tagId: number) => {
        setDismissed((prev) => new Set(prev).add(tagId));
    };

    const analyzeThisTrack = async () => {
        if (!track) return;
        setAnalyzing(true);
        try {
            await invoke('analyze_tracks', { trackIds: [track.id], force: false });
            // `analysis-complete` listener refetches and clears `analyzing`.
        } catch (e) {
            setAnalyzing(false);
            const msg = String(e);
            if (msg.includes('not downloaded')) {
                showError('Enable AI suggestions in Settings → AI Tags first.');
            } else {
                showError(`Analysis failed: ${msg}`);
            }
        }
    };

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
                    showError("Batch editing of raw text not yet supported. Use the Tag Deck to apply tags to multiple tracks.");
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
            const msg = 'Failed to save tags: ' + e;
            showError(msg);
            invoke('log_error', { message: msg }).catch(console.error);
        }
    };

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

                invoke<BatchTagResult>(command, { ids: idsToUpdate, tag: val })
                    .then((res) => {
                         const failed = batchTagFailures(res);
                         if (failed.length > 0) {
                             const msg = `${failed.length} of ${idsToUpdate.length} track${idsToUpdate.length === 1 ? '' : 's'} couldn't be tagged — file unavailable or out of sync.`;
                             showError(msg);
                             invoke('log_error', { message: `${command}: ${msg} ids=[${failed.join(',')}]` }).catch(console.error);
                         }
                         // Optimistically toggle the primary pill only if everything
                         // persisted; otherwise let onUpdate()'s refresh show the truth.
                         if (track && failed.length === 0) {
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
                        const msg = "Batch tag error: " + err;
                        showError(msg);
                        invoke('log_error', { message: msg }).catch(console.error);
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
            const lastTag = tags[tags.length - 1];
            removeTag(lastTag, tags.length - 1);
        }
    };
    
    const removeTag = async (tagToRemove: string, index: number) => {
        if (isMultiSelect) {
            const ids = Array.from(selectedTrackIds || []);
            try {
                const res = await invoke<BatchTagResult>('batch_remove_tag', { ids, tag: tagToRemove });
                const failed = batchTagFailures(res);
                if (failed.length > 0) {
                    showError(`${failed.length} of ${ids.length} track${ids.length === 1 ? '' : 's'} couldn't be updated — file unavailable or out of sync.`);
                } else {
                    setTags(prev => prev.filter((_, idx) => idx !== index));
                }
                onUpdate();
            } catch (e) {
                console.error(e);
            }
        } else {
            const newTags = tags.filter((_, idx) => idx !== index);
            setTags(newTags);
            await saveTagsToBackend(newTags, userComment);
        }
    };

    const addTag = async (valOverride?: string) => {
        // Strip out "&&" to prevent separator conflicts
        const rawVal = (valOverride || tagInput).replace(/&&/g, '').trim();

        if (rawVal) {
            // Capitalize first letter
            const val = rawVal.charAt(0).toUpperCase() + rawVal.slice(1);
            
            if (isMultiSelect) {
                const ids = Array.from(selectedTrackIds || []);
                try {
                    const res = await invoke<BatchTagResult>('batch_add_tag', { ids, tag: val });
                    const failed = batchTagFailures(res);
                    if (failed.length > 0) {
                        showError(`${failed.length} of ${ids.length} track${ids.length === 1 ? '' : 's'} couldn't be tagged — file unavailable or out of sync.`);
                    } else {
                        setTags(prev => {
                            const exists = prev.some(t => t.toLowerCase() === val.toLowerCase());
                            if (exists) return prev;
                            return [...prev, val];
                        });
                    }
                    onUpdate();
                } catch (e) {
                    console.error("Batch add failed", e);
                    invoke('log_error', { message: `Batch add failed: ${e}` }).catch(console.error);
                }
            } else {
                
                // Case-insensitive duplicate check using the latest state
                const exists = tags.some(t => t.toLowerCase() === val.toLowerCase());
                if (!exists) {
                    const newTags = [...tags, val];
                    setTags(newTags);
                    await saveTagsToBackend(newTags, userComment);
                }
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
            {/* Header Removed */}
            <div style={styles.header}>
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                    
                    <span 
                        title={isMultiSelect ? `${selectedTrackIds?.size} Files Selected` : `${track.artist} - ${track.title}`}
                        style={{ 
                            fontSize: '14px', 
                            color: 'var(--accent-color)', 
                            fontWeight: 600,
                            whiteSpace: 'nowrap', 
                            overflow: 'hidden', 
                            textOverflow: 'ellipsis',
                            marginTop: '1px'
                        }}
                    >
                        {isMultiSelect 
                            ? `${selectedTrackIds?.size || 0} Files Selected` 
                            : `${track.artist} - ${track.title}`
                        }
                    </span>
                </div>
                 {!isMultiSelect && (
                    <button 
                        onClick={() => setShowInfo(!showInfo)}
                        style={{
                            background: showInfo ? 'var(--bg-tertiary)' : 'transparent',
                            border: 'none',
                            color: showInfo ? 'var(--accent-color)' : 'var(--text-secondary)',
                            cursor: 'pointer',
                            padding: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            borderRadius: '4px',
                            marginLeft: '8px'
                        }}
                        title="Technical Info"
                    >
                        <Info size={14} />
                    </button>
                )}
            </div>
            
            {showInfo && !isMultiSelect && (
                <div style={{marginBottom: '5px'}}>
                    <MetadataViewer track={track} />
                </div>
            )}

            {/* Tags Section only - Comment UI removed */}
            <div style={{ padding: '0px' }}>
                <div style={styles.tagContainer} onClick={() => document.getElementById('tag-input')?.focus()}>
                    {tags.map((tag, i) => (
                        <div key={i} style={styles.pill}>
                            {tag}
                            <span 
                                style={{ marginLeft: '4px', cursor: 'pointer', opacity: 0.6 }}
                                onClick={(e) => { 
                                    e.stopPropagation(); 
                                    removeTag(tag, i);
                                }}
                            >×</span>
                        </div>
                    ))}
                    <input
                        id="tag-input"
                        type="text"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        value={tagInput}
                        onChange={handleTagInputChange}
                        onKeyDown={handleTagInputKeyDown}
                        style={styles.ghostInput}
                        placeholder={tags.length === 0 ? "Add tags..." : ""}
                    />
                </div>

                {!isMultiSelect && (() => {
                    const applied = new Set(tags.map(t => t.toLowerCase()));
                    const visible = suggestions.filter(
                        s => !dismissed.has(s.tag_id) && !applied.has(s.name.toLowerCase())
                    );
                    if (visible.length > 0) {
                        return (
                            <div style={styles.suggestRow}>
                                <span style={styles.suggestLabel}>
                                    <Sparkles size={11} /> Suggested
                                </span>
                                {visible.map(s => (
                                    <div
                                        key={s.tag_id}
                                        style={styles.ghostChip}
                                        onClick={() => acceptSuggestion(s)}
                                        title={`${Math.round(s.score * 100)}% match — click to add`}
                                    >
                                        {s.name}
                                        <span style={styles.ghostPct}>{Math.round(s.score * 100)}%</span>
                                        <span
                                            style={{ marginLeft: '2px', cursor: 'pointer', opacity: 0.5 }}
                                            onClick={(e) => { e.stopPropagation(); dismissSuggestion(s.tag_id); }}
                                        >×</span>
                                    </div>
                                ))}
                            </div>
                        );
                    }
                    if (!analyzed) {
                        return (
                            <div style={styles.suggestRow}>
                                <button
                                    onClick={analyzeThisTrack}
                                    disabled={analyzing}
                                    style={styles.analyzeBtn}
                                    title="Analyze this track's audio to suggest tags"
                                >
                                    {analyzing ? <Loader2 size={11} className="spin" /> : <Sparkles size={11} />}
                                    {analyzing ? 'Analyzing…' : 'Suggest tags'}
                                </button>
                            </div>
                        );
                    }
                    return null;
                })()}

                {!isMultiSelect && (() => {
                    const applied = new Set(tags.map((t) => t.toLowerCase()));
                    const visibleNew = newTags.filter(
                        (c) => !dismissedNew.has(c.candidate_id) && !applied.has(c.name.toLowerCase())
                    );
                    if (visibleNew.length === 0) return null;
                    return (
                        <div style={styles.suggestRow}>
                            <span style={styles.suggestLabel}>
                                <Plus size={11} /> New tags
                            </span>
                            {visibleNew.map((c) => (
                                <span
                                    key={c.candidate_id}
                                    style={styles.newTagChip}
                                    title={`${Math.round(c.score * 100)}% match — click to add “${c.name}”`}
                                    onClick={() => acceptNewTag(c)}
                                >
                                    {c.name}
                                    <span style={styles.newTagBadge}>new</span>
                                    <span style={styles.ghostPct}>{Math.round(c.score * 100)}%</span>
                                    <span
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setDismissedNew((prev) => new Set(prev).add(c.candidate_id));
                                        }}
                                        style={{ marginLeft: 2, cursor: 'pointer', opacity: 0.6 }}
                                    >
                                        ×
                                    </span>
                                </span>
                            ))}
                        </div>
                    );
                })()}
            </div>
        </div>
    );
}

const styles = {
    container: {
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        borderBottom: '1px solid var(--border-color)',
        padding: '0 10px 10px 10px', // Reduced top padding handled by header margins
        paddingTop: '8px',
        boxSizing: 'border-box' as const,
        display: 'flex',
        flexDirection: 'column' as const,
        gap: '4px'
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '2px',
        paddingBottom: '4px',
        // borderBottom: '1px solid var(--border-color)' // Remove header border for compactness if needed, lets keep it subtle?
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
        padding: '4px 6px',
        borderRadius: '4px',
        border: '1px solid var(--bg-tertiary)',
        background: 'var(--bg-primary)',
        minHeight: '32px', // Compact height
        cursor: 'text'
    },
    pill: {
        background: 'rgba(59, 130, 246, 0.5)', 
        color: '#fff',
        padding: '1px 8px',
        borderRadius: '10px',
        fontSize: '12px',
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        border: '1px solid var(--accent-color)',
        userSelect: 'none' as const,
    },
    ghostInput: {
        border: 'none',
        background: 'transparent',
        color: 'var(--text-primary)',
        fontSize: '12px',
        outline: 'none',
        flex: 1,
        minWidth: '50px',
        padding: 0,
        height: '20px'
    },
    suggestRow: {
        display: 'flex',
        flexWrap: 'wrap' as const,
        alignItems: 'center',
        gap: '4px',
        marginTop: '6px',
    },
    suggestLabel: {
        display: 'flex',
        alignItems: 'center',
        gap: '3px',
        fontSize: '10px',
        textTransform: 'uppercase' as const,
        letterSpacing: '0.04em',
        color: 'var(--text-secondary)',
        fontWeight: 600,
        marginRight: '2px',
    },
    ghostChip: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '1px 8px',
        borderRadius: '10px',
        fontSize: '12px',
        fontWeight: 500,
        color: 'var(--text-secondary)',
        background: 'transparent',
        border: '1px dashed var(--accent-color)',
        cursor: 'pointer',
        userSelect: 'none' as const,
    },
    newTagChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 9px',
        border: '1px dashed #22c55e',
        background: 'transparent',
        color: 'var(--text-secondary)',
        borderRadius: '10px',
        fontWeight: 500,
        fontSize: '12px',
        cursor: 'pointer',
        userSelect: 'none' as const,
    },
    newTagBadge: {
        fontSize: '9px',
        textTransform: 'uppercase' as const,
        letterSpacing: '0.04em',
        color: '#22c55e',
        fontWeight: 700,
    },
    ghostPct: {
        fontSize: '10px',
        opacity: 0.6,
        fontVariantNumeric: 'tabular-nums' as const,
    },
    analyzeBtn: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 10px',
        borderRadius: '10px',
        fontSize: '11px',
        color: 'var(--text-secondary)',
        background: 'transparent',
        border: '1px dashed var(--border-color)',
        cursor: 'pointer',
    },
    button: {}
};
