import { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DndContext, useDraggable, useDroppable, DragEndEvent, DragStartEvent, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
    const [activeDragId, setActiveDragId] = useState<string | number | null>(null);
    const [activeDragType, setActiveDragType] = useState<'tag' | 'group' | null>(null);
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

    const handleDeleteTag = async (tagId: number) => {
        console.log('handleDeleteTag called with tagId:', tagId);
        try {
            console.log('Invoking delete_tag command...');
            await invoke('delete_tag', { tag_id: tagId });
            console.log('Delete successful, reloading data...');
            loadData();
        } catch (err) {
            console.error('Failed to delete tag:', err);
            setError('Failed to delete tag');
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
        const id = event.active.id;
        setActiveDragId(id);
        
        if (typeof id === 'number' || !String(id).startsWith('group-')) {
            setActiveDragType('tag');
        } else {
            setActiveDragType('group');
        }
    };

    const onDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveDragId(null);
        setActiveDragType(null);

        if (!over) return;

        if (activeDragType === 'tag') {
            const tagId = Number(active.id);
            
            // Check if dropped on delete zone
            console.log('Dropped on:', over.id);
            if (String(over.id) === 'delete-zone') {
                const tag = tags.find(t => t.id === tagId);
                console.log('Tag to delete:', tag);
                if (tag && tag.usage_count === 0) {
                    console.log('Deleting tag:', tag.name);
                    await handleDeleteTag(tagId);
                } else {
                    console.log('Tag cannot be deleted - usage count:', tag?.usage_count);
                }
                return;
            }
            
            // over.id is either "uncategorized" or "group-{id}"
            let newGroupId: number | null = null;
            
            // Check if over is a group (DroppableSection) or another sortable tag
            // Our DroppableSections use "uncategorized" or "group-{id}"
            // But we might be dropping onto another tag, which bubble up?
            // Since DraggableTag doesn't accept drops (useDraggable logic depends on context),
            // typically sorting happens inside SortableContext, but moving between groups requires Droppable containers.
            
            // Actually, in default dnd-kit, if dropping on a sortable item, the container is the over.
            // Wait, SortableContext items are also droppable areas.
            
            // Let's rely on the nearest droppable container ID which DroppableSection provides.
            // If dropping on a group header, ID is "group-{id}".
            
            const overIdStr = String(over.id);
            if (overIdStr !== 'uncategorized') {
                const parts = overIdStr.split('-');
                if (parts[0] === 'group') {
                    newGroupId = Number(parts[1]);
                } else if (over.data.current?.sortable?.containerId) {
                    // Dropped onto another tag, check its container
                    const containerId = over.data.current.sortable.containerId;
                    if (containerId !== 'uncategorized') {
                        const cParts = String(containerId).split('-');
                        if (cParts[0] === 'group') {
                            newGroupId = Number(cParts[1]);
                        }
                    }
                }
            }

            // Prevent redundant updates
            const currentTag = tags.find(t => t.id === tagId);
            if (currentTag && currentTag.group_id === newGroupId) return;

            // Optimistic update
            setTags(prev => prev.map(t => t.id === tagId ? { ...t, group_id: newGroupId } : t));

            try {
                await invoke('set_tag_group', { tagId, groupId: newGroupId });
            } catch (e) {
                console.error('Failed to move tag:', e);
                loadData();
            }
        } else if (activeDragType === 'group') {
            const activeIdStr = String(active.id); // "group-1"
            const overIdStr = String(over.id);     // "group-2"

            if (activeIdStr !== overIdStr && overIdStr.startsWith('group-')) {
                const oldIndex = groups.findIndex(g => `group-${g.id}` === activeIdStr);
                const newIndex = groups.findIndex(g => `group-${g.id}` === overIdStr);

                if (oldIndex !== -1 && newIndex !== -1) {
                    // Optimistic
                    const newGroups = arrayMove(groups, oldIndex, newIndex);
                    setGroups(newGroups);
                    
                    try {
                        await invoke('reorder_tag_groups', { orderedIds: newGroups.map(g => g.id) });
                    } catch (e) {
                         console.error("Failed to reorder groups:", e);
                         loadData(); // Revert
                    }
                }
            }
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

    const activeTag = useMemo(() => {
        if (activeDragType === 'tag' && activeDragId) {
             return tags.find(t => t.id === activeDragId);
        }
        return null;
    }, [activeDragType, activeDragId, tags]);

    const activeGroup = useMemo(() => {
        if (activeDragType === 'group' && activeDragId) {
            const id = Number(String(activeDragId).replace('group-', ''));
            return groups.find(g => g.id === id);
        }
        return null;
    }, [activeDragType, activeDragId, groups]);

    // Keyboard navigation support 
    // Ideally update this to traverse filtered tags linearly regardless of groups
    // For now, disabling keyboard list nav in favor of drag and drop focus
    // Or implementing simple "Enter selects first match"
    useEffect(() => {
        if (!keyboardMode) return;
        const _handleKeyDown = (_e: KeyboardEvent) => {
             // Simplified keyboard support for now
        };
        window.addEventListener('keydown', _handleKeyDown);
        return () => window.removeEventListener('keydown', _handleKeyDown);
    }, [keyboardMode]);

    return (
        <div style={styles.container} className="no-select">
            <div style={styles.header}>
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

                <div style={{ position: 'relative', width: '100%', display: 'flex', gap: '8px' }}>
                     <input 
                        type="text" 
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filter tags..."
                        style={{ ...styles.searchInput, flex: 1 }}
                    />
                    <button onClick={() => setIsAddingGroup(!isAddingGroup)} style={styles.iconBtn} title="Add Group">
                        <FolderPlus size={16} />
                    </button>
                </div>
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
                    <SortableContext items={groups.map(g => `group-${g.id}`)} strategy={verticalListSortingStrategy}>
                        {groups.map(group => (
                            <DroppableSection
                                key={group.id}
                                id={`group-${group.id}`}
                                title={group.name}
                                onDelete={() => handleDeleteGroup(group.id)}
                                onRename={(newName: string) => handleRenameGroup(group.id, newName)}
                                collapsed={collapsedGroups.has(group.id)}
                                onToggle={() => toggleGroupCollapse(group.id)}
                                isSortable={true} 
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
                    </SortableContext>
                </div>
                
                <DragOverlay>
                    {activeTag ? (
                         <div style={{...styles.pill, background: 'var(--accent-color)', color: '#fff', transform: 'scale(1.05)',  maxWidth: 'fit-content'}}>
                            {activeTag.name}
                        </div>
                    ) : activeGroup ? (
                        <div style={{
                            padding: '10px 15px', 
                            background: 'var(--bg-secondary)', 
                            border: '1px solid var(--accent-color)', 
                            borderRadius: '8px',
                            fontWeight: 600
                        }}>
                            {activeGroup.name}
                        </div>
                    ) : null}
                </DragOverlay>
            </DndContext>
        </div>
    );
}

// Subcomponents

function DroppableSection({ id, title, children, isUncategorized, onDelete, onRename, collapsed, onToggle, isSortable }: any) {
    // If sortable, we use useSortable. Note: useSortable creates droppable Ref too.
    // If NOT sortable (uncategorized), we use useDroppable.
    
    // Hooks cannot be called conditionally, so we check logic inside wrappers or assume useSortable for groups
    // But since we are reusing the component, we must branch or use a common hook if possible.
    // useSortable is superset of useDroppable + useDraggable.
    // But Uncategorized section is NOT draggable.
    
    // Solution: Split into two components or use component composition?
    // Or just call both hooks and ignore errors? No.
    // Better: DroppableSection is for "Uncategorized". SortableGroup is for "Groups".
    
    // For minimal refactor, let's conditionally use the hooks based on `isSortable` prop, 
    // BUT React rules forbid conditional hooks.
    // So we must move the hook calls up or split the component.
    
    return isSortable ? (
        <SortableGroupSection {...{ id, title, children, onDelete, onRename, collapsed, onToggle }} />
    ) : (
        <PlainDroppableSection {...{ id, title, children, isUncategorized, collapsed, onToggle }} />
    );
}

function PlainDroppableSection({ id, title, children, isUncategorized, collapsed, onToggle }: any) {
    const { setNodeRef, isOver } = useDroppable({ id });
    const { setNodeRef: deleteZoneRef, isOver: isOverDelete } = useDroppable({ 
        id: 'delete-zone',
        disabled: !isUncategorized 
    });
    
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
                     <span style={{fontWeight: 600, fontSize: '13px', color: 'var(--text-secondary)'}}>{title}</span>
                 </div>
                 {isUncategorized && (
                     <div 
                         ref={deleteZoneRef}
                         style={{
                             padding: '4px 8px',
                             borderRadius: 4,
                             display: 'flex',
                             alignItems: 'center',
                             gap: 4,
                             backgroundColor: isOverDelete ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255,255,255,0.05)',
                             border: isOverDelete ? '1px solid rgba(239, 68, 68, 0.5)' : '1px solid rgba(255,255,255,0.1)',
                             transition: 'all 0.2s',
                             cursor: 'pointer',
                         }}
                         title="Drop tags here to delete (zero usage only)"
                     >
                         <Trash2 size={12} style={{color: isOverDelete ? '#ef4444' : 'var(--text-secondary)'}} />
                         <span style={{fontSize: '11px', color: isOverDelete ? '#ef4444' : 'var(--text-secondary)'}}>Delete</span>
                     </div>
                 )}
            </div>
             {!collapsed && (
                 <div style={styles.tagContainer}>
                     {children}
                 </div>
             )}
         </div>
    )
}

function SortableGroupSection({ id, title, children, onDelete, onRename, collapsed, onToggle }: any) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: id,
        data: { type: 'group' }
    });
    
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        marginBottom: 15,
        borderRadius: 8,
        opacity: isDragging ? 0.3 : 1,
        position: 'relative' as const,
        touchAction: 'none'
    };

    const [isEditing, setIsEditing] = useState(false);
    const [editName, setEditName] = useState(title);

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
        <div ref={setNodeRef} style={style}>
            <div style={styles.sectionHeader}>
                <div style={{display:'flex', alignItems:'center', cursor: 'pointer', flex: 1}} >
                    <div onClick={onToggle} style={{display:'flex', alignItems:'center'}}>
                        {collapsed ? <ChevronRight size={14} style={{marginRight: 5}}/> : <ChevronDown size={14} style={{marginRight: 5}}/>}
                    </div>
                    {isEditing ? (
                        <div style={{display:'flex', alignItems: 'center', width: '100%'}}>
                             <input 
                                value={editName} 
                                onChange={e => setEditName(e.target.value)}
                                onBlur={handleSave}
                                onKeyDown={handleKeyDown}
                                autoFocus
                                style={{
                                    background: 'var(--bg-primary)', 
                                    border: '1px solid var(--accent-color)', 
                                    color: 'var(--text-primary)',
                                    padding: '2px 5px',
                                    borderRadius: 4,
                                    fontSize: '13px',
                                    width: '100%'
                                }}
                             />
                             <button onClick={handleSave} style={{marginLeft: 5, background: 'none', border:'none', cursor:'pointer', color:'var(--accent-color)'}}>
                                <Check size={14} />
                             </button>
                        </div>
                    ) : (
                        <div {...attributes} {...listeners} style={{flex: 1, cursor: 'grab', touchAction: 'none'}}>
                            <span style={{fontWeight: 600, fontSize: '13px', color: 'var(--text-secondary)'}}>{title}</span>
                        </div>
                    )}
                </div>
                
                <div className="group-actions" style={{display:'flex', gap: 5, opacity: 0.5}}>
                    <button onClick={() => setIsEditing(true)} style={styles.iconBtn} title="Rename">
                        <Pencil size={12} />
                    </button>
                    <button onClick={onDelete} style={styles.iconBtn} title="Delete Group">
                        <Trash2 size={12} />
                    </button>
                </div>
            </div>
            {!collapsed && (
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

    const handleClick = (e: React.MouseEvent) => {
        // Only trigger onClick for left-clicks, not right-clicks
        if (e.button === 0 && e.type === 'click') {
            onClick();
        }
    };

    return (
        <div 
            ref={setNodeRef}
            {...listeners}
            {...attributes}
            style={{...styles.pillWrapper, ...style}}
        >
             <div 
                onClick={handleClick}
                style={{
                    ...styles.pill,
                    background: isActive ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
                    color: isActive ? '#fff' : 'var(--text-secondary)',
                    border: tag.usage_count === 0 
                        ? '1px solid rgba(239, 68, 68, 0.6)' 
                        : (isActive ? '1px solid var(--accent-color)' : '1px solid rgba(255,255,255,0.1)'),
                    opacity: tag.usage_count === 0 ? 0.7 : 1,
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
