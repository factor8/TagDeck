import { useEffect, useState, useMemo, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { StarRating } from './StarRating';
import { parseSearchQuery } from '../utils/searchParser';
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
    Row,
    Table
} from '@tanstack/react-table';
import { 
    useDraggable,
    DndContext,
    DragEndEvent,
    closestCenter,
    PointerSensor,
    useSensor,
    useSensors
} from '@dnd-kit/core';
import { 
    SortableContext, 
    horizontalListSortingStrategy, 
    verticalListSortingStrategy,
    useSortable,
    arrayMove
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Folder, ArrowUp, ArrowDown, Settings, Volume2, Volume1 } from 'lucide-react';
import { Track } from '../types';

interface Props {
    refreshTrigger: number;
    selectedTrackIds: Set<number>;
    lastSelectedTrackId: number | null;
    playingTrackId?: number | null;
    isPlaying?: boolean; // New prop
    onSelectionChange: (selectedIds: Set<number>, lastSelectedId: number | null, primaryTrack: Track | null, commonTags: string[]) => void;
    onTrackDoubleClick?: (track: Track) => void;
    searchTerm: string;
    playlistId: number | null;
    onRefresh?: () => void;
}

export interface TrackListHandle {
    selectNext: () => void;
    selectPrev: () => void;
    getNextTrack: (fromId: number | null) => Track | null;
    getPrevTrack: (fromId: number | null) => Track | null;
    handleColumnReorder: (activeId: string, overId: string) => void;
}

interface TrackRowProps {
    row: Row<Track>;
    virtualRow: any; // VirtualItem type not easily imported without adding import. Let's use any or update import.
    measureElement: (element: Element | null) => void;
    isSelected: boolean;
    isPlaying: boolean;
    isMissing: boolean;
    handleRowClick: (track: Track, event: React.MouseEvent) => void;
    onTrackDoubleClick?: (track: Track) => void;
    onContextMenu: (e: React.MouseEvent) => void;
}

const TrackRow = ({ 
    row, 
    virtualRow, 
    measureElement, 
    isSelected, 
    isPlaying, 
    isMissing, 
    handleRowClick, 
    onTrackDoubleClick,
    onContextMenu 
}: TrackRowProps) => {
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: `track-${row.original.id}`,
        data: {
            type: 'Track',
            track: row.original,
            id: row.original.id
        }
    });

    const style: React.CSSProperties = {
        transform: CSS.Translate.toString(transform),
        borderBottom: '1px solid var(--bg-secondary)',
        background: isSelected 
                ? 'rgba(59, 130, 246, 0.15)' 
                : virtualRow.index % 2 === 1 
                    ? 'rgba(255, 255, 255, 0.02)'
                    : 'transparent',
        color: isSelected 
                ? 'var(--accent-color)' 
                : (isPlaying ? 'var(--accent-color)' : 'var(--text-primary)'),
        fontWeight: isPlaying ? '600' : 'normal',
        opacity: isDragging ? 0.5 : (isMissing ? 0.5 : 1),
        cursor: isMissing ? 'default' : 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        position: 'relative',
        zIndex: isDragging ? 100 : 'auto',
    };

    return (
        <tr 
            key={row.id}
            data-index={virtualRow.index} 
            ref={(node) => {
                measureElement(node);
                setNodeRef(node);
            }}
            onClick={(e) => handleRowClick(row.original, e)}
            onContextMenu={onContextMenu}
            onDoubleClick={() => !isMissing && onTrackDoubleClick?.(row.original)}
            style={style}
             onMouseEnter={(e) => {
                if (!isSelected) e.currentTarget.style.background = 'var(--bg-secondary)';
            }}
            onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = virtualRow.index % 2 === 1 ? 'rgba(255, 255, 255, 0.02)' : 'transparent';
            }}
            {...attributes} 
            {...listeners}
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
};

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
        <th ref={setNodeRef} className="no-select" style={style} {...attributes} {...listeners}>
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
                onPointerDown={(e) => e.stopPropagation()} 
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

const SortableMenuItem = ({ column, label }: { column: any, label: string }) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id: column.id });

    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        padding: '6px 8px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        cursor: isDragging ? 'grabbing' : 'pointer',
        userSelect: 'none' as const,
        zIndex: isDragging ? 10 : 1,
        position: 'relative' as const,
        opacity: isDragging ? 0.5 : 1,
        backgroundColor: isDragging ? 'var(--bg-tertiary)' : 'transparent',
    };

    return (
        <div 
            ref={setNodeRef} 
            style={style} 
            {...attributes} 
            {...listeners}
            onClick={() => column.toggleVisibility()}
            onMouseEnter={(e) => !isDragging && (e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)')}
            onMouseLeave={(e) => !isDragging && (e.currentTarget.style.backgroundColor = 'transparent')}
        >
            <input
                type="checkbox"
                checked={column.getIsVisible()}
                onChange={() => {}} 
                style={{ cursor: 'pointer', pointerEvents: 'none' }}
            />
            <span style={{ textTransform: 'capitalize' }}>
                {label}
            </span>
        </div>
    );
};

export const TrackList = forwardRef<TrackListHandle, Props>(({ refreshTrigger, onSelectionChange, onTrackDoubleClick, selectedTrackIds, lastSelectedTrackId, playingTrackId, isPlaying, searchTerm, playlistId, onRefresh }, ref) => {
    const [tracks, setTracks] = useState<Track[]>([]);
    const [allowedTrackIds, setAllowedTrackIds] = useState<Set<number> | null>(null);
    const [playlistTrackOrder, setPlaylistTrackOrder] = useState<number[] | null>(null);
    const [loading, setLoading] = useState(false);
    
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                delay: 200,
                tolerance: 5,
            },
        })
    );

    const handleMenuDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (active.id !== over?.id) {
            setColumnOrder((items) => {
                const oldIndex = items.indexOf(active.id as string);
                const newIndex = items.indexOf(over?.id as string);
                return arrayMove(items, oldIndex, newIndex);
            });
        }
    };

    // Load playlist filter
    useEffect(() => {
        async function loadPlaylistFilter() {
            if (playlistId === null) {
                setAllowedTrackIds(null);
                setPlaylistTrackOrder(null);
                return;
            }
            try {
                // Ensure correct parameter mapping
                const ids = await invoke<number[]>('get_playlist_track_ids', { playlistId });
                setAllowedTrackIds(new Set(ids));
                setPlaylistTrackOrder(ids);
            } catch (e) {
                console.error("Failed to load playlist tracks", e);
                invoke('log_error', { message: `Failed to load playlist tracks: ${e}` }).catch(console.error);
                setAllowedTrackIds(new Set());
                setPlaylistTrackOrder([]);
            }
        }
        loadPlaylistFilter();
    }, [playlistId]);



    // Map for O(1) position lookup
    const playlistOrderMap = useMemo(() => {
        if (!playlistTrackOrder) return null;
        return new Map(playlistTrackOrder.map((id, index) => [id, index]));
    }, [playlistTrackOrder]);

    // Filter tracks based on search term and playlist
    const filteredTracks = useMemo(() => {
        let result = tracks;

        // Filter by playlist
        if (allowedTrackIds !== null) {
            result = result.filter(t => allowedTrackIds.has(t.id));
            
            // Sort by playlist order if available
            if (playlistOrderMap) {
               result.sort((a, b) => {
                   const posA = playlistOrderMap.get(a.id) ?? Infinity;
                   const posB = playlistOrderMap.get(b.id) ?? Infinity;
                   return posA - posB;
               });
            }
        }

        if (!searchTerm) return result;
        
        const query = parseSearchQuery(searchTerm);

        return result.filter(track => {
            // 1. Check Numeric Filters
            for (const filter of query.numericFilters) {
                // Only BPM is supported in Track for now
                let val: number | undefined;
                if (filter.field === 'bpm') val = track.bpm;
                // Add year support if available in Track interface
                // if (filter.field === 'year') val = ...; 
                
                if (val === undefined) return false; 

                if (filter.operator === 'range') {
                    if (val < filter.value || (filter.maxValue !== undefined && val > filter.maxValue)) return false;
                } else if (filter.operator === '>') {
                    if (val <= filter.value) return false;
                } else if (filter.operator === '>=') {
                    if (val < filter.value) return false;
                } else if (filter.operator === '<') {
                    if (val >= filter.value) return false;
                } else if (filter.operator === '<=') {
                    if (val > filter.value) return false;
                } else if (filter.operator === '=') {
                    if (val !== filter.value) return false;
                }
            }

            // 2. Check String Filters
            for (const filter of query.stringFilters) {
                const targetValue = filter.value.toLowerCase();
                let match = false;

                if (filter.field === 'any') {
                    // Search all fields
                    const haystack = [
                        track.title, 
                        track.artist, 
                        track.album, 
                        track.comment_raw,
                        track.grouping_raw,
                        track.bpm ? track.bpm.toString() : ''
                    ].filter(Boolean).join(' ').toLowerCase();

                    // If exact is true (quoted), simple includes matches the phrase "house music"
                    // If exact is false (unquoted), simple includes matches the token "house"
                    match = haystack.includes(targetValue);

                } else {
                    // Specific field
                    let fieldValue: string | undefined = '';
                    switch (filter.field) {
                        case 'artist': fieldValue = track.artist; break;
                        case 'title': fieldValue = track.title; break;
                        case 'album': fieldValue = track.album; break;
                        case 'tag': fieldValue = track.comment_raw; break;
                        case 'label': fieldValue = track.grouping_raw; break;
                        case 'key': 
                            // Try parsing key from comment or look for future key field
                            // For now, if we match in comment or grouping?
                            // Let's treat key searches as searching the 'key' substring in comment/grouping as fallback?
                            // Or just fail. Let's fail safe:
                            fieldValue = undefined; 
                            break;
                        default: fieldValue = undefined;
                    }

                    if (fieldValue) {
                        const val = fieldValue.toLowerCase();
                        match = val.includes(targetValue);
                    } else {
                        match = false;
                    }
                }

                if (filter.negate) {
                    if (match) return false;
                } else {
                    if (!match) return false;
                }
            }

            return true;
        });
    }, [tracks, searchTerm, allowedTrackIds]);

    // Keyboard Shortcuts (Select All, Enter to Play)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if in input/textarea
            const activeTag = document.activeElement?.tagName.toLowerCase();
            const isInput = activeTag === 'input' || activeTag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable;
            
            if (isInput) return;

            // Cmd+A / Ctrl+A -> Select All
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

            // Enter -> Play Selected Track
            if (e.key === 'Enter') {
                if (lastSelectedTrackId && onTrackDoubleClick) {
                    const trackToPlay = filteredTracks.find(t => t.id === lastSelectedTrackId);
                    if (trackToPlay) {
                        e.preventDefault();
                        onTrackDoubleClick(trackToPlay);
                    }
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [filteredTracks, lastSelectedTrackId, onSelectionChange, onTrackDoubleClick]);

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
        rating: true,
        position: true // Explicitly enable position
    }));
    const [columnOrder, setColumnOrder] = useState<string[]>(() => {
        const saved = loadState<string[]>('table_order_v3', []);
        const defaultOrder = [
            'position', 'artist', 'title', 'album', 'bpm', 'comment', 'tags', 
            'rating', 'duration_secs', 'format', 'bit_rate', 'size_bytes', 'modified_date', 'date_added', 'actions'
        ];
        
        if (saved && saved.length > 0) {
            if (!saved.includes('position')) {
                return ['position', ...saved];
            }
            return saved;
        }
        return defaultOrder;
    });
    const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => loadState('table_sizing_v3', {
        position: 40
    }));
    
    const [isMenuOpen, setIsMenuOpen] = useState(false);

    // Persistence Effects
    useEffect(() => { localStorage.setItem('table_sorting_v2', JSON.stringify(sorting)); }, [sorting]);
    useEffect(() => { localStorage.setItem('table_visibility_v3', JSON.stringify(columnVisibility)); }, [columnVisibility]);
    useEffect(() => { localStorage.setItem('table_order_v3', JSON.stringify(columnOrder)); }, [columnOrder]);
    useEffect(() => { localStorage.setItem('table_sizing_v3', JSON.stringify(columnSizing)); }, [columnSizing]);

    // Refs to hold latest selection props so we can use them in loadTracks
    // without triggering it when they change.
    const lastSelectedTrackIdRef = useRef(lastSelectedTrackId);
    const selectedTrackIdsRef = useRef(selectedTrackIds);
    useEffect(() => {
        lastSelectedTrackIdRef.current = lastSelectedTrackId;
        selectedTrackIdsRef.current = selectedTrackIds;
    }, [lastSelectedTrackId, selectedTrackIds]);

    const loadTracks = useCallback(async () => {
        setLoading(true);
        try {
            const result = await invoke<Track[]>('get_tracks');
            setTracks(result);

            // Update parent selection if we have an active selection
            // This ensures App.tsx (and TagEditor/MetadataViewer) get the FRESH track object
            // instead of holding onto a stale one from before the refresh.
            const currentLastId = lastSelectedTrackIdRef.current;
            const currentIds = selectedTrackIdsRef.current;

            if (currentLastId && currentIds && currentIds.size > 0 && onSelectionChange) {
                const freshPrimary = result.find(t => t.id === currentLastId);
                if (freshPrimary) {
                    // We only re-emit if single selection for simplicity/safety, 
                    // or we could re-calculate for multi-select.
                    // For now, let's fix the single-select edit case.
                    if (currentIds.size === 1) {
                        const raw = freshPrimary.comment_raw || "";
                        // Helper to parse tags matching App.tsx logic
                        const tags = raw.indexOf(" && ") !== -1 
                            ? raw.substring(raw.indexOf(" && ") + 4).split(';').map(t => t.trim()).filter(Boolean) 
                            : [];
                        
                        onSelectionChange(currentIds, freshPrimary.id, freshPrimary, tags);
                    } else {
                        // For multi-select, we should ideally re-calc common tags, 
                        // but updating just the primary track reference is better than nothing.
                        // We'll leave commonTags as is for now to avoid expensive calc here, 
                        // as the user edit flow usually updates them anyway? 
                        // Actually, if we just edited a single file, we are in single select mode.
                    }
                }
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    }, [onSelectionChange]); // Removed selection deps

    useEffect(() => {
        loadTracks();
    }, [refreshTrigger, loadTracks]);

    const handleRatingChange = async (trackId: number, newRating: number) => {
        setTracks(prev => prev.map(t => 
            t.id === trackId ? { ...t, rating: newRating } : t
        ));

        try {
           await invoke('update_rating', { trackId, rating: newRating });
        } catch (error) {
           console.error("Failed to update rating", error);
           loadTracks();
        }
    };

    const columnHelper = createColumnHelper<Track>();

    const columns = useMemo<ColumnDef<Track, any>[]>(() => [
        columnHelper.accessor(
            row => {
                if (playlistOrderMap) {
                    return playlistOrderMap.get(row.id) ?? Number.MAX_SAFE_INTEGER;
                }
                return row.id;
            },
            {
            id: 'position',
            header: '#',
            cell: info => {
                if (playlistOrderMap) {
                    const val = info.getValue() as number;
                    return val < Number.MAX_SAFE_INTEGER ? val + 1 : '';
                }
                return info.row.index + 1;
            },
            size: 40,
        }),
        columnHelper.accessor('artist', {
            id: 'artist',
            header: 'Artist',
            cell: info => {
                const isCurrentTrack = playingTrackId === info.row.original.id;
                return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {isCurrentTrack && (
                             isPlaying 
                             ? <Volume2 size={12} color="var(--accent-color)" style={{ flexShrink: 0 }} />
                             : <Volume1 size={12} style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />
                        )}
                        <span>{info.getValue()}</span>
                    </div>
                );
            },
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
            cell: info => (
                <div onClick={(e) => e.stopPropagation()}>
                    <StarRating 
                        value={info.getValue() || 0} 
                        onChange={(val) => handleRatingChange(info.row.original.id, val)}
                    />
                </div>
            ),
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
            header: () => <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}><Folder size={16} /></div>,
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
    ], [isMenuOpen, playingTrackId, isPlaying, handleRatingChange, playlistOrderMap]);

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
    // Selection Handler
    const handleRowClick = (track: Track, event: React.MouseEvent) => {
        try {
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
            
            // Optimization: Avoid mapping all rows if we just need tags for the clicked track
            let commonTags: string[] = [];
            
            const parse = (t: Track) => {
                if (!t.comment_raw) return [];
                const parts = t.comment_raw.split(" && ");
                if (parts.length < 2) return [];
                return parts[1].split(';').map(s => s.trim()).filter(x => x);
            };

            // Fast path for single selection (most common case)
            if (newSelectedIds.size === 1 && newSelectedIds.has(track.id)) {
                commonTags = parse(track);
            } else {
                // For multi-selection, only process the selected rows
                const selectedRows = rows.filter(r => newSelectedIds.has(r.original.id));
                const selectedTracks = selectedRows.map(r => r.original);
                
                if (selectedTracks.length > 0) {
                    let common = new Set(parse(selectedTracks[0]));
                    for (let i = 1; i < selectedTracks.length; i++) {
                        const tTags = new Set(parse(selectedTracks[i]));
                        common = new Set([...common].filter(x => tTags.has(x)));
                        if (common.size === 0) break;
                    }
                    commonTags = Array.from(common);
                }
            }
            
            onSelectionChange(newSelectedIds, newLastSelectedId, primaryTrack, commonTags);
        } catch (e) {
            console.error("Error in handleRowClick:", e);
        }
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
        },
        getNextTrack: (fromId: number | null) => {
            const currentIndex = rows.findIndex(r => r.original.id === fromId);
            if (currentIndex !== -1 && currentIndex < rows.length - 1) {
                return rows[currentIndex + 1].original;
            }
            if (currentIndex === -1 && rows.length > 0 && fromId === null) {
                return rows[0].original;
            }
            return null;
        },
        getPrevTrack: (fromId: number | null) => {
            const currentIndex = rows.findIndex(r => r.original.id === fromId);
            if (currentIndex > 0) {
                return rows[currentIndex - 1].original;
            }
            return null;
        },
        handleColumnReorder: (activeId: string, overId: string) => {
             setColumnOrder((order) => {
                const oldIndex = order.indexOf(activeId);
                const newIndex = order.indexOf(overId);
                return arrayMove(order, oldIndex, newIndex);
            });
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

            {/* Loading indicator removed per user request to prevent jitter */}

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
                        minWidth: '200px',
                        userSelect: 'none',
                        WebkitUserSelect: 'none'
                    }}>
                        <div style={{ marginBottom: '8px', padding: '0 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <span style={{ fontWeight: 600, fontSize: '12px' }}>Toggle Columns</span>
                            <span style={{ fontSize: '10px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>hold to reorder</span>
                        </div>
                        <DndContext 
                            sensors={sensors} 
                            collisionDetection={closestCenter} 
                            onDragEnd={handleMenuDragEnd}
                        >
                            <SortableContext 
                                items={table.getAllLeafColumns().map(c => c.id)}
                                strategy={verticalListSortingStrategy}
                            >
                                {table.getAllLeafColumns().map(column => {
                                    const label = column.id === 'actions' ? 'File Link' 
                                        : (typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id);
                                    
                                    return <SortableMenuItem key={column.id} column={column} label={label as string} />;
                                })}
                            </SortableContext>
                        </DndContext>
                    </div>
                </>
            )}
            
            {/* DndContext removed */}
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
                                const isPlaying = playingTrackId === row.original.id;
                                const isMissing = row.original.missing;
                                
                                return (
                                    <TrackRow
                                        key={row.id}
                                        row={row}
                                        virtualRow={virtualRow}
                                        measureElement={rowVirtualizer.measureElement}
                                        isSelected={isSelected}
                                        isPlaying={isPlaying}
                                        isMissing={Boolean(isMissing)}
                                        handleRowClick={handleRowClick}
                                        onTrackDoubleClick={onTrackDoubleClick}
                                        onContextMenu={(e) => {
                                            if (isMissing) {
                                                e.preventDefault();
                                                const shouldReset = window.confirm("Reset missing file status?");
                                                if (shouldReset) {
                                                     invoke('mark_track_missing', { id: row.original.id, missing: false })
                                                        .then(() => onRefresh?.());
                                                }
                                            }
                                        }}
                                    />
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
        </div>
    );
});
