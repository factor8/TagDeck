import { useEffect, useState, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { 
    useReactTable, 
    getCoreRowModel, 
    getSortedRowModel, 
    flexRender,
    createColumnHelper,
    SortingState,
    VisibilityState,
    ColumnSizingState,
    ColumnDef,
    Header,
    Table
} from '@tanstack/react-table';
import { 
    DndContext, 
    closestCenter, 
    KeyboardSensor, 
    PointerSensor, 
    useSensor, 
    useSensors, 
    DragEndEvent 
} from '@dnd-kit/core';
import { 
    arrayMove, 
    SortableContext, 
    sortableKeyboardCoordinates, 
    horizontalListSortingStrategy, 
    useSortable 
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Folder, ArrowUp, ArrowDown, Settings } from 'lucide-react';
import { Track } from '../types';

interface Props {
    refreshTrigger: number;
    selectedTrackIds: Set<number>;
    lastSelectedTrackId: number | null;
    onSelectionChange: (selectedIds: Set<number>, lastSelectedId: number | null, primaryTrack: Track | null, commonTags: string[]) => void;
    onTrackDoubleClick?: (track: Track) => void;
    searchTerm: string;
    playlistId: number | null;
}

export interface TrackListHandle {
    selectNext: () => void;
    selectPrev: () => void;
}

// Helper to calculate common tags
const getCommonTags = (tracks: Track[], selectedIds: Set<number>): string[] => {
    if (selectedIds.size === 0) return [];
    
    // Get all selected track objects
    const selectedTracks = tracks.filter(track => selectedIds.has(track.id));
    if (selectedTracks.length === 0) return [];
    
    // Parse tags for first track to initialize intersection
    const parse = (t: Track) => {
        if (!t.comment_raw) return [];
        const parts = t.comment_raw.split(" && ");
        if (parts.length < 2) return [];
        return parts[1].split(';').map(s => s.trim()).filter(x => x);
    };
    
    let common = new Set(parse(selectedTracks[0]));
    
    // Intersect with rest
    for (let i = 1; i < selectedTracks.length; i++) {
        const tTags = new Set(parse(selectedTracks[i]));
        common = new Set([...common].filter(x => tTags.has(x)));
        if (common.size === 0) break;
    }
    
    return Array.from(common);
};

// Format helpers
const formatDuration = (secs: number) => {
    if (!secs) return '';
    const minutes = Math.floor(secs / 60);
    const seconds = Math.floor(secs % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const formatSize = (bytes: number) => {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
};

const formatDate = (timestamp: number) => {
    if (!timestamp) return '';
    return new Date(timestamp * 1000).toLocaleDateString();
};

const formatRating = (rating: number) => {
    if (!rating) return '';
    const stars = Math.round(rating / 20);
    return '★'.repeat(stars) + '☆'.repeat(5 - stars);
};

const DraggableTableHeader = ({ header }: { header: Header<Track, unknown>, table: Table<Track> }) => {
    const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
        id: header.column.id,
    });

    const style: React.CSSProperties = {
        opacity: isDragging ? 0.8 : 1,
        position: 'relative',
        transform: CSS.Translate.toString(transform),
        transition,
        width: header.getSize(),
        zIndex: isDragging ? 1 : 0,
        padding: '4px 10px',
        textAlign: 'left',
        borderBottom: '1px solid var(--border-color)',
        borderRight: '1px solid var(--border-color)',
        color: 'var(--text-secondary)',
        fontSize: '12px',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        fontWeight: 600,
        backgroundColor: 'var(--bg-primary)', // Ensure opacity doesn't show row below
        userSelect: 'none',
        cursor: 'grab',
    };

    return (
        <th ref={setNodeRef} style={style} {...attributes} {...listeners}>
            <div style={{ display: 'flex', alignItems: 'center', height: '100%', gap: '6px' }}>
                {header.isPlaceholder ? null : (
                    <div 
                        onClick={header.column.getToggleSortingHandler()}
                        style={{ 
                            cursor: header.column.getCanSort() ? 'pointer' : 'default',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            flex: 1
                        }}
                    >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {{
                            asc: <ArrowUp size={12} />,
                            desc: <ArrowDown size={12} />,
                        }[header.column.getIsSorted() as string] ?? null}
                    </div>
                )}
            </div>
            {/* Resizer */}
            <div
                onMouseDown={header.getResizeHandler()}
                onTouchStart={header.getResizeHandler()}
                className={`resizer ${
                    header.column.getIsResizing() ? 'isResizing' : ''
                }`}
                style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    height: '100%',
                    width: '5px',
                    background: 'transparent',
                    cursor: 'col-resize',
                    zIndex: 10
                }}
            />
        </th>
    );
};

export const TrackList = forwardRef<TrackListHandle, Props>(({ refreshTrigger, onSelectionChange, onTrackDoubleClick, selectedTrackIds, lastSelectedTrackId, searchTerm, playlistId }, ref) => {
    const [tracks, setTracks] = useState<Track[]>([]);
    const [allowedTrackIds, setAllowedTrackIds] = useState<Set<number> | null>(null);
    const [loading, setLoading] = useState(false);
    
    // Load playlist filter
    useEffect(() => {
        async function loadPlaylistFilter() {
            if (playlistId === null) {
                setAllowedTrackIds(null);
                return;
            }
            try {
                // Ensure correct parameter mapping
                const ids = await invoke<number[]>('get_playlist_track_ids', { playlistId });
                setAllowedTrackIds(new Set(ids));
            } catch (e) {
                console.error("Failed to load playlist tracks", e);
                setAllowedTrackIds(new Set());
            }
        }
        loadPlaylistFilter();
    }, [playlistId]);

    // Filter tracks based on search term and playlist
    const filteredTracks = useMemo(() => {
        let result = tracks;

        // Filter by playlist
        if (allowedTrackIds !== null) {
            result = result.filter(t => allowedTrackIds.has(t.id));
        }

        if (!searchTerm) return result;
        
        // Split search terms by whitespace
        const terms = searchTerm.toLowerCase().split(/\s+/).filter(t => t.length > 0);
        if (terms.length === 0) return result;

        return result.filter(track => {
            // Combine all searchable text into one string
            const haystack = [
                track.title, 
                track.artist, 
                track.album, 
                track.comment_raw,
                track.grouping_raw,
                track.bpm ? track.bpm.toString() : ''
            ].filter(Boolean).join(' ').toLowerCase();

            // All terms must be present in the haystack
            return terms.every(term => haystack.includes(term));
        });
    }, [tracks, searchTerm, allowedTrackIds]);

    // Select All Shortcut
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
                e.preventDefault();
                const allIds = new Set(filteredTracks.map(t => t.id));
                // Only select if we have tracks
                if (allIds.size > 0) {
                    // Maintain the last selected track if it's in the list, otherwise pick the first one
                    let primaryId = lastSelectedTrackId;
                    let primaryTrack = null;

                    if (!primaryId || !allIds.has(primaryId)) {
                        primaryId = filteredTracks[0].id;
                        primaryTrack = filteredTracks[0];
                    } else {
                        primaryTrack = filteredTracks.find(t => t.id === primaryId) || filteredTracks[0];
                    }

                    const commonTags = getCommonTags(filteredTracks, allIds);
                    onSelectionChange(allIds, primaryId, primaryTrack, commonTags);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [filteredTracks, lastSelectedTrackId, onSelectionChange]);

    // Persistence Helper
    const loadState = <T,>(key: string, defaultVal: T): T => {
        try {
            const saved = localStorage.getItem(key);
            return saved ? JSON.parse(saved) : defaultVal;
        } catch {
            return defaultVal;
        }
    };

    // Table State
    const [sorting, setSorting] = useState<SortingState>(() => loadState('table_sorting_v2', []));
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => loadState('table_visibility_v3', {
        album: false,
        format: false,
        size_bytes: false,
        modified_date: false,
        grouping_raw: false,
        bit_rate: false,
        date_added: false,
        bpm: false,
        rating: true
    }));
    const [columnOrder, setColumnOrder] = useState<string[]>(() => loadState('table_order_v3', [
        'artist', 'title', 'album', 'bpm', 'comment', 'tags', 
        'rating', 'duration_secs', 'format', 'bit_rate', 'size_bytes', 'modified_date', 'date_added', 'actions'
    ]));
    const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => loadState('table_sizing_v3', {}));
    
    const [isMenuOpen, setIsMenuOpen] = useState(false);

    // Persistence Effects
    useEffect(() => { localStorage.setItem('table_sorting_v2', JSON.stringify(sorting)); }, [sorting]);
    useEffect(() => { localStorage.setItem('table_visibility_v3', JSON.stringify(columnVisibility)); }, [columnVisibility]);
    useEffect(() => { localStorage.setItem('table_order_v3', JSON.stringify(columnOrder)); }, [columnOrder]);
    useEffect(() => { localStorage.setItem('table_sizing_v3', JSON.stringify(columnSizing)); }, [columnSizing]);

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

    const columnHelper = createColumnHelper<Track>();

    const columns = useMemo<ColumnDef<Track, any>[]>(() => [
        columnHelper.accessor('artist', {
            id: 'artist',
            header: 'Artist',
            cell: info => info.getValue(),
            size: 150,
        }),
        columnHelper.accessor('title', {
            id: 'title',
            header: 'Title',
            cell: info => info.getValue(),
            size: 200,
        }),
        columnHelper.accessor('album', {
            id: 'album',
            header: 'Album',
            cell: info => info.getValue(),
            size: 150,
        }),
        columnHelper.accessor('comment_raw', {
            id: 'comment',
            header: 'Comment',
            size: 200,
            cell: info => {
                const raw = info.getValue() || '';
                const splitIndex = raw.indexOf(' && ');
                return splitIndex !== -1 ? raw.substring(0, splitIndex) : raw;
            }
        }),
        columnHelper.accessor('comment_raw', {
            id: 'tags',
            header: 'Tags',
            size: 250,
            cell: info => {
                const raw = info.getValue() || '';
                let tags: string[] = [];
                const splitIndex = raw.indexOf(' && ');
                if (splitIndex !== -1) {
                    tags = raw.substring(splitIndex + 4).split(';').map((t: string) => t.trim()).filter(Boolean);
                }
                return (
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {tags.map((tag, i) => (
                            <span key={i} style={{
                                fontSize: '11px',
                                padding: '1px 6px',
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
                );
            }
        }),
        columnHelper.accessor('duration_secs', {
            id: 'duration_secs',
            header: 'Time',
            cell: info => formatDuration(info.getValue()),
            size: 60,
        }),
        columnHelper.accessor('rating', {
            id: 'rating',
            header: 'Rating',
            cell: info => <span style={{ color: 'var(--accent-color)', letterSpacing: '2px' }}>{formatRating(info.getValue())}</span>,
            size: 100,
        }),
        columnHelper.accessor('bpm', {
            id: 'bpm',
            header: 'BPM',
            cell: info => info.getValue() || '',
            size: 60,
        }),
        columnHelper.accessor('format', {
            id: 'format',
            header: 'Format',
            cell: info => info.getValue(),
            size: 60,
        }),
        columnHelper.accessor('bit_rate', {
            id: 'bit_rate',
            header: 'Bitrate',
            cell: info => info.getValue() ? `${info.getValue()} kbps` : '',
            size: 80,
        }),
        columnHelper.accessor('size_bytes', {
            id: 'size_bytes',
            header: 'Size',
            cell: info => formatSize(info.getValue()),
            size: 80,
        }),
        columnHelper.accessor('modified_date', {
            id: 'modified_date',
            header: 'Modified',
            cell: info => formatDate(info.getValue()),
            size: 100,
        }),
        columnHelper.accessor('date_added', {
            id: 'date_added',
            header: 'Date Added',
            cell: info => formatDate(info.getValue()),
            size: 100,
        }),
        columnHelper.display({
            id: 'actions',
            size: 40,
            header: () => null,
            cell: ({ row }) => (
                <div style={{ textAlign: 'center' }}>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            invoke('show_in_finder', { path: row.original.file_path });
                        }}
                        title="Show in Finder"
                        style={{
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            color: 'var(--text-secondary)',
                            fontSize: '14px',
                            opacity: 0.5,
                            padding: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                        onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                        onMouseLeave={e => e.currentTarget.style.opacity = '0.5'}
                    >
                        <Folder size={16} />
                    </button>
                </div>
            )
        })
    ], [isMenuOpen]);

    const table = useReactTable({
        data: filteredTracks,
        columns,
        state: {
            sorting,
            columnVisibility,
            columnOrder,
            columnSizing,
        },
        columnResizeMode: 'onChange',
        onSortingChange: setSorting,
        onColumnVisibilityChange: setColumnVisibility,
        onColumnOrderChange: setColumnOrder,
        onColumnSizingChange: setColumnSizing,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });

    // Drag and Drop Sensors
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 2, // Require slight movement to start drag, allowing clicks
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    function handleDragEnd(event: DragEndEvent) {
        const { active, over } = event;
        if (active && over && active.id !== over.id) {
            setColumnOrder((order) => {
                const oldIndex = order.indexOf(active.id as string);
                const newIndex = order.indexOf(over.id as string);
                return arrayMove(order, oldIndex, newIndex);
            });
        }
    }

    // Selection Handler
    const handleRowClick = (track: Track, event: React.MouseEvent) => {
        let newSelectedIds = new Set(selectedTrackIds);
        let newLastSelectedId = track.id;
        let primaryTrack = track;

        if (event.shiftKey && lastSelectedTrackId !== null) {
            const lastIndex = rows.findIndex(r => r.original.id === lastSelectedTrackId);
            const currentIndex = rows.findIndex(r => r.original.id === track.id);
            
            if (lastIndex !== -1 && currentIndex !== -1) {
                const start = Math.min(lastIndex, currentIndex);
                const end = Math.max(lastIndex, currentIndex);
                
                if (!event.metaKey && !event.ctrlKey) {
                   newSelectedIds.clear();
                }

                for (let i = start; i <= end; i++) {
                    newSelectedIds.add(rows[i].original.id);
                }
            }
        } else if (event.metaKey || event.ctrlKey) {
            if (newSelectedIds.has(track.id)) {
                newSelectedIds.delete(track.id);
            } else {
                newSelectedIds.add(track.id);
            }
        } else {
            newSelectedIds.clear();
            newSelectedIds.add(track.id);
        }
        
        const commonTags = getCommonTags(rows.map(r => r.original), newSelectedIds);
        onSelectionChange(newSelectedIds, newLastSelectedId, primaryTrack, commonTags);
    };

    const parentRef = useRef<HTMLDivElement>(null);
    const { rows } = table.getRowModel();
    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 35,
        overscan: 20,
    });

    useImperativeHandle(ref, () => ({
        selectNext: () => {
            const currentIndex = rows.findIndex(r => r.original.id === lastSelectedTrackId);
            let nextIndex = 0;
            if (currentIndex !== -1) {
                nextIndex = currentIndex + 1;
            } else if (rows.length > 0) {
                // If nothing selected, select first
                nextIndex = 0;
            } else {
                return;
            }

            if (nextIndex < rows.length) {
                const nextTrack = rows[nextIndex].original;
                const newSet = new Set([nextTrack.id]);
                // Simply use nextTrack tags + logic since single select
                const commonTags = getCommonTags([nextTrack], newSet); 
                onSelectionChange(newSet, nextTrack.id, nextTrack, commonTags);
                rowVirtualizer.scrollToIndex(nextIndex);
            }
        },
        selectPrev: () => {
            const currentIndex = rows.findIndex(r => r.original.id === lastSelectedTrackId);
            if (currentIndex > 0) {
                const prevIndex = currentIndex - 1;
                const prevTrack = rows[prevIndex].original;
                const newSet = new Set([prevTrack.id]);
                const commonTags = getCommonTags([prevTrack], newSet);
                onSelectionChange(newSet, prevTrack.id, prevTrack, commonTags);
                rowVirtualizer.scrollToIndex(prevIndex);
            }
        }
    }));

    return (
        <div style={{ width: '100%', height: '100%', fontSize: '13px', position: 'relative', display: 'flex', flexDirection: 'column' }}>
            {/* Pinned Settings Gear */}
            <div 
                onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen(!isMenuOpen);
                }}
                style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    height: '41px', // Match header height roughly (border included)
                    width: '40px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 20,
                    background: 'var(--bg-primary)', 
                    borderBottom: '1px solid var(--border-color)',
                    borderLeft: '1px solid var(--border-color)',
                    cursor: 'pointer',
                    color: 'var(--text-secondary)'
                }}
                onMouseEnter={e => {
                     e.currentTarget.style.color = 'var(--text-primary)';
                     e.currentTarget.style.background = 'var(--bg-tertiary)';
                }}
                onMouseLeave={e => {
                     e.currentTarget.style.color = 'var(--text-secondary)';
                     e.currentTarget.style.background = 'var(--bg-primary)';
                }}
                title="Table Settings"
            >
                <Settings size={16} />
            </div>

            {loading && (
                <div style={{ padding: '20px', color: 'var(--text-secondary)', textAlign: 'center' }}>
                    Loading library...
                </div>
            )}

            {/* Column Menu Overlay */}
            {isMenuOpen && (
                <>
                    <div 
                        className="column-menu-overlay" 
                        onClick={() => setIsMenuOpen(false)}
                        style={{
                            position: 'fixed',
                            inset: 0,
                            zIndex: 40
                        }} 
                    />
                    <div className="column-menu" style={{ 
                        position: 'absolute', 
                        right: '0px', 
                        top: '40px', 
                        zIndex: 100,
                        backgroundColor: 'var(--bg-secondary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        padding: '8px',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                        minWidth: '200px'
                    }}>
                        <div style={{ marginBottom: '8px', fontWeight: 600, fontSize: '12px', padding: '0 4px' }}>
                            Toggle Columns
                        </div>
                        {table.getAllLeafColumns().map(column => {
                             if (column.id === 'actions') return null;
                            return (
                                <div key={column.id} className="column-menu-item" style={{
                                    padding: '6px 8px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    cursor: 'pointer',
                                    userSelect: 'none'
                                }}
                                onClick={() => column.toggleVisibility()}
                                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                >
                                    <input
                                        type="checkbox"
                                        checked={column.getIsVisible()}
                                        onChange={() => {}} // handled by div click
                                        style={{ cursor: 'pointer', pointerEvents: 'none' }}
                                    />
                                    <span style={{ textTransform: 'capitalize' }}>
                                        {column.columnDef.header as string}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
            
            <DndContext 
                collisionDetection={closestCenter} 
                onDragEnd={handleDragEnd} 
                sensors={sensors}
            >
                <div 
                    ref={parentRef}
                    style={{ 
                        overflow: 'auto', 
                        width: '100%',
                        flex: 1,
                        minHeight: 0,
                        position: 'relative' // Ensure container is positioned for absolute children if any
                    }}
                >
                    <table style={{ 
                        width: table.getTotalSize(), 
                        minWidth: '100%', // Allow it to grow if content is small
                        borderCollapse: 'separate', 
                        borderSpacing: 0,
                        tableLayout: 'fixed' 
                    }}>
                        <thead style={{ 
                            position: 'sticky', 
                            top: 0, 
                            zIndex: 10,
                            background: 'var(--bg-primary)'
                        }}>
                             {table.getHeaderGroups().map(headerGroup => (
                                <tr key={headerGroup.id}>
                                    <SortableContext 
                                        items={columnOrder} 
                                        strategy={horizontalListSortingStrategy}
                                    >
                                        {headerGroup.headers.map(header => (
                                            <DraggableTableHeader key={header.id} header={header} table={table} />
                                        ))}
                                    </SortableContext>
                                </tr>
                            ))}
                        </thead>
                        <tbody>
                            {rowVirtualizer.getVirtualItems().length > 0 && (
                                <tr style={{ height: `${rowVirtualizer.getVirtualItems()[0].start}px` }}>
                                    <td colSpan={table.getVisibleLeafColumns().length} style={{ border: 0, padding: 0 }} />
                                </tr>
                            )}
                            {rowVirtualizer.getVirtualItems().map(virtualRow => {
                                const row = rows[virtualRow.index];
                                const isSelected = selectedTrackIds.has(row.original.id);
                                return (
                                    <tr 
                                        key={row.id}
                                        data-index={virtualRow.index} 
                                        ref={rowVirtualizer.measureElement}
                                        onClick={(e) => handleRowClick(row.original, e)}
                                        onDoubleClick={() => onTrackDoubleClick?.(row.original)}
                                        style={{ 
                                            borderBottom: '1px solid var(--bg-secondary)',
                                            background: isSelected 
                                                ? 'rgba(59, 130, 246, 0.15)' 
                                                : virtualRow.index % 2 === 1 
                                                    ? 'rgba(255, 255, 255, 0.02)'
                                                    : 'transparent',
                                            color: isSelected ? 'var(--accent-color)' : 'var(--text-primary)',
                                            cursor: 'pointer',
                                            userSelect: 'none',
                                            WebkitUserSelect: 'none'
                                        }}
                                        onMouseEnter={(e) => {
                                            if (!isSelected) e.currentTarget.style.background = 'var(--bg-secondary)';
                                        }}
                                        onMouseLeave={(e) => {
                                            if (!isSelected) e.currentTarget.style.background = virtualRow.index % 2 === 1 ? 'rgba(255, 255, 255, 0.02)' : 'transparent';
                                        }}
                                    >
                                        {row.getVisibleCells().map(cell => (
                                            <td 
                                                key={cell.id} 
                                                style={{ 
                                                    padding: '8px 10px',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap'
                                                }}
                                            >
                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                            </td>
                                        ))}
                                    </tr>
                                );
                            })}
                            {rowVirtualizer.getVirtualItems().length > 0 && (
                                <tr style={{ height: `${rowVirtualizer.getTotalSize() - rowVirtualizer.getVirtualItems()[rowVirtualizer.getVirtualItems().length - 1].end}px` }}>
                                     <td colSpan={table.getVisibleLeafColumns().length} style={{ border: 0, padding: 0 }} />
                                </tr>
                            )}
                            {filteredTracks.length === 0 && !loading && (
                                <tr>
                                    <td colSpan={table.getVisibleLeafColumns().length} style={{ padding: '60px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                                        <div style={{ fontSize: '16px', marginBottom: '8px' }}>
                                            {searchTerm ? 'No tracks found' : 'Library is empty'}
                                        </div>
                                        <div style={{ fontSize: '13px', opacity: 0.7 }}>
                                            {searchTerm ? `No matches for "${searchTerm}"` : 'Import an iTunes XML file to get started'}
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </DndContext>
        </div>
    );
});
