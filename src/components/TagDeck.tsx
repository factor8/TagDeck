import { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DndContext, useDraggable, useDroppable, DragEndEvent, DragStartEvent, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { Tag, TagGroup } from '../types';
import { ChevronRight, ChevronDown, Trash2, FolderPlus, Pencil, Check } from 'lucide-react';

interface Props {
    onTagClick: (tag: string) => void;
    currentTrackTags: string[];
    refreshTrigger: number;
    keyboardMode?: boolean;
}

export function TagDeck({ onTagClick, currentTrackTags, refreshTrigger, keyboardMode = false }: Props) {
    const [tags, setTags] = useState<Tag[]>([]);
    const [groups, setGroups] = useState<TagGroup[]>([]);
    const [filter, setFilter] = useState('');
    const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set());
    const [newGroupName, setNewGroupName] = useState('');
    const [draggedTagId, setDraggedTagId] = useState<number | null>(null);
    const [isAddingGroup, setIsAddingGroup] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8,
            },
        })
    );

    useEffect(() => {
        loadData();
    }, [refreshTrigger]);

    const loadData = async () => {
        try {
            setError(null);
            const [fetchedTags, fetchedGroups] = await Promise.all([
                invoke<Tag[]>('get_all_tags'),
                invoke<TagGroup[]>('get_tag_groups')
            ]);
            console.log("Loaded tags:", fetchedTags.length, "groups:", fetchedGroups.length);
            setTags(fetchedTags);
            setGroups(fetchedGroups);
        } catch (e: any) {
            console.error('Failed to load tag data:', e);
            setError(e.toString());
        }
    };

    const handleCreateGroup = async () => {
        if (!newGroupName.trim()) return;
        try {
            await invoke('create_tag_group', { name: newGroupName });
            setNewGroupName('');
            setIsAddingGroup(false);
            loadData();
        } catch (e) {
            console.error('Failed to create group:', e);
        }
    };

    const handleDeleteGroup = async (id: number) => {
        if (!confirm('Are you sure you want to delete this group? Tags will be ungrouped.')) return;
        try {
            await invoke('delete_tag_group', { id });
            loadData();
        } catch (e) {
            console.error('Failed to delete group:', e);
        }
    };

    const handleRenameGroup = async (id: number, newName: string) => {
        if (!newName.trim()) return;
        try {
            await invoke('update_tag_group', { id, name: newName });
            loadData();
        } catch (e) {
            console.error('Failed to rename group:', e);
        }
    };

    const toggleGroupCollapse = (id: number) => {
        const newCollapsed = new Set(collapsedGroups);
        if (newCollapsed.has(id)) {
            newCollapsed.delete(id);
        } else {
            newCollapsed.add(id);
        }
        setCollapsedGroups(newCollapsed);
    };

    const onDragStart = (event: DragStartEvent) => {
        setDraggedTagId(Number(event.active.id));
    };

    const onDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        setDraggedTagId(null);

        if (!over) return;

        const tagId = Number(active.id);
        // over.id is either "uncategorized" or "group-{id}"
        let newGroupId: number | null = null;
        
        if (over.id !== 'uncategorized') {
            const parts = String(over.id).split('-');
            if (parts[0] === 'group') {
                newGroupId = Number(parts[1]);
            }
        }

        // Optimistic update
        setTags(prev => prev.map(t => t.id === tagId ? { ...t, group_id: newGroupId } : t));

        try {
            await invoke('set_tag_group', { tagId, groupId: newGroupId });
            // Ideally reload to confirm, or just stay optimistic
        } catch (e) {
            console.error('Failed to move tag:', e);
            loadData(); // Revert on fail
        }
    };

    // Organizing tags
    const organizedTags = useMemo(() => {
        const filtered = tags.filter(t => t.name.toLowerCase().includes(filter.toLowerCase()));
        
        const uncategorized = filtered.filter(t => !t.group_id);
        const grouped: Record<number, Tag[]> = {};
        
        groups.forEach(g => {
            grouped[g.id] = filtered.filter(t => t.group_id === g.id);
        });

        return { uncategorized, grouped };
    }, [tags, groups, filter]);

    const activeTag = tags.find(t => t.id === draggedTagId);

    // Keyboard navigation support 
    // Ideally update this to traverse filtered tags linearly regardless of groups
    // For now, disabling keyboard list nav in favor of drag and drop focus
    // Or implementing simple "Enter selects first match"
    useEffect(() => {
        if (!keyboardMode) return;
        const handleKeyDown = (e: KeyboardEvent) => {
             // Simplified keyboard support for now
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [keyboardMode]);

    return (
        <div style={styles.container} className="no-select">
            <div style={styles.header}>
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 10}}>
                     <h3 style={styles.title}>Tag Deck</h3>
                     <button onClick={() => setIsAddingGroup(!isAddingGroup)} style={styles.iconBtn} title="Add Group">
                        <FolderPlus size={16} />
                     </button>
                </div>
                
                {error && <div style={{color: 'red', fontSize: '12px', marginBottom: 5}}>{error}</div>}

                {isAddingGroup && (
                    <div style={{display: 'flex', gap: 5, marginBottom: 10}}>
                        <input 
                            value={newGroupName}
                            onChange={e => setNewGroupName(e.target.value)}
                            placeholder="Group Name"
                            style={styles.searchInput}
                            onKeyDown={e => e.key === 'Enter' && handleCreateGroup()}
                            autoFocus
                        />
                        <button onClick={handleCreateGroup} style={styles.saveBtn}>Save</button>
                    </div>
                )}

                <input 
                    type="text" 
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter tags..."
                    style={styles.searchInput}
                />
            </div>
            
            <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
                <div style={styles.grid}>
                    {/* Uncategorized Section */}
                    <DroppableSection id="uncategorized" title="Uncategorized" isUncategorized>
                        {organizedTags.uncategorized.map(tag => (
                            <DraggableTag 
                                key={tag.id} 
                                tag={tag} 
                                isActive={currentTrackTags.includes(tag.name)}
                                onClick={() => onTagClick(tag.name)}
                            />
                        ))}
                        {organizedTags.uncategorized.length === 0 && !filter && (
                           <div style={styles.emptyText}>Drop tags here to ungroup</div>
                        )}
                    </DroppableSection>

                    {/* Groups */}
                    {groups.map(group => (
                        <DroppableSection
                            key={group.id}
                            id={`group-${group.id}`}
                            title={group.name}
                            onDelete={() => handleDeleteGroup(group.id)}
                            onRename={(newName: string) => handleRenameGroup(group.id, newName)}
                            collapsed={collapsedGroups.has(group.id)}
                            onToggle={() => toggleGroupCollapse(group.id)}
                        >
                            {organizedTags.grouped[group.id]?.map(tag => (
                                <DraggableTag 
                                    key={tag.id} 
                                    tag={tag} 
                                    isActive={currentTrackTags.includes(tag.name)}
                                    onClick={() => onTagClick(tag.name)}
                                />
                            ))}
                        </DroppableSection>
                    ))}
                </div>
                
                <DragOverlay>
                    {activeTag ? (
                         <div style={{...styles.pill, background: 'var(--accent-color)', color: '#fff', transform: 'scale(1.05)',  maxWidth: 'fit-content'}}>
                            {activeTag.name}
                        </div>
                    ) : null}
                </DragOverlay>
            </DndContext>
        </div>
    );
}

// Subcomponents

function DroppableSection({ id, title, children, isUncategorized, onDelete, onRename, collapsed, onToggle }: any) {
    const { setNodeRef, isOver } = useDroppable({ id });
    const [isEditing, setIsEditing] = useState(false);
    const [editName, setEditName] = useState(title);

    // Update editName if title prop changes
    useEffect(() => {
        setEditName(title);
    }, [title]);

    const handleSave = () => {
        if (editName !== title) {
            onRename(editName);
        }
        setIsEditing(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // Stop propagation consistently to prevent global shortcuts like Play/Pause
        e.stopPropagation();

        if (e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        }
        if (e.key === 'Escape') {
             e.preventDefault();
             setEditName(title);
             setIsEditing(false);
        }
    };
    
    return (
        <div 
            ref={setNodeRef} 
            style={{ 
                marginBottom: 15, 
                backgroundColor: isOver ? 'rgba(255,255,255,0.03)' : 'transparent',
                borderRadius: 8,
                transition: 'background 0.2s',
            }}
        >
            <div style={styles.sectionHeader}>
                <div style={{display:'flex', alignItems:'center', cursor: 'pointer', flex: 1}} >
                    <div onClick={onToggle} style={{display:'flex', alignItems:'center'}}>
                        {!isUncategorized && (
                            collapsed ? <ChevronRight size={14} style={{marginRight: 5}}/> : <ChevronDown size={14} style={{marginRight: 5}}/>
                        )}
                    </div>
                    {isEditing ? (
                        <div style={{display:'flex', alignItems: 'center', width: '100%'}}>
                             <input 
                                value={editName} 
                                onChange={e => setEditName(e.target.value)}
                                onBlur={handleSave}
                                onKeyDown={handleKeyDown}
                                autoFocus
                                onClick={(e) => e.stopPropagation()} 
                                style={styles.editInput}
                             />
                             <button 
                                onMouseDown={(e) => {
                                    // Use onMouseDown to prevent blur from firing first on the input
                                    e.preventDefault(); 
                                    handleSave();
                                }}
                                style={{...styles.iconBtn, marginLeft: 5, color: 'var(--accent-color)'}} 
                                title="Save"
                             >
                                <Check size={14} />
                             </button>
                         </div>
                     ) : (
                         <span onClick={onToggle} style={{fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)'}}>{title}</span>
                     )}
                </div>
                {!isUncategorized && !isEditing && (
                    <div style={{display:'flex', gap: 5}}>
                         <button onClick={() => setIsEditing(true)} style={styles.iconBtn} title="Rename Group">
                            <Pencil size={12} />
                         </button>
                        {onDelete && (
                            <button onClick={onDelete} style={{...styles.iconBtn, opacity: 0.5}} className="delete-group-btn" title="Delete Group">
                                <Trash2 size={12} />
                            </button>
                        )}
                    </div>
                )}
            </div>
            
            {(!collapsed || isUncategorized) && (
                <div style={styles.tagContainer}>
                    {children}
                </div>
            )}
        </div>
    );
}

function DraggableTag({ tag, isActive, onClick }: { tag: Tag, isActive: boolean, onClick: () => void }) {
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: tag.id,
    });
    
    const style = transform ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        zIndex: 999,
        opacity: isDragging ? 0 : 1, // Hide original when dragging
    } : undefined;

    return (
        <div 
            ref={setNodeRef}
            {...listeners}
            {...attributes}
            style={{...styles.pillWrapper, ...style}}
        >
             <div 
                onClick={onClick}
                style={{
                    ...styles.pill,
                    background: isActive ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
                    color: isActive ? '#fff' : 'var(--text-secondary)',
                    border: isActive ? '1px solid var(--accent-color)' : '1px solid rgba(255,255,255,0.1)',
                }}
            >
                {tag.name}
            </div>
        </div>
    );
}


const styles: Record<string, React.CSSProperties> = {
    container: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-secondary)',
    },
    header: {
        padding: '15px',
        borderBottom: '1px solid var(--border-color)',
    },
    title: {
        margin: 0,
        fontSize: '14px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '1px',
        color: 'var(--text-secondary)',
    },
    iconBtn: {
        background: 'none',
        border: 'none',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        padding: 4,
        display: 'flex',
        alignItems: 'center',
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
        overflowY: 'auto',
        flex: 1,
    },
    pillWrapper: {
        display: 'inline-block',
        touchAction: 'none', 
    },
    pill: {
        padding: '2px 10px',
        borderRadius: '12px',
        fontSize: '14px',
        cursor: 'pointer',
        transition: 'all 0.1s ease',
        userSelect: 'none',
        whiteSpace: 'nowrap',
    },
    sectionHeader: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 8,
        padding: '0 5px'
    },
    tagContainer: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        minHeight: '20px', // Drop target area
    },
    emptyText: {
        color: 'var(--text-secondary)', 
        fontSize: '12px', 
        fontStyle: 'italic', 
        padding: '5px'
    },
    saveBtn: {
        background: 'var(--accent-color)',
        border: 'none',
        color: '#fff',
        borderRadius: 4,
        padding: '0 10px',
        cursor: 'pointer',
        fontSize: '12px',
    },
    editInput: {
        background: 'var(--bg-primary)',
        border: '1px solid var(--accent-color)',
        borderRadius: '2px',
        color: '#fff',
        fontSize: '13px',
        fontWeight: 600,
        padding: '2px 5px',
        width: '100%',
        marginLeft: '5px',
    },
};
