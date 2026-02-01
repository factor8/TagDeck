import { useEffect, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { 
    useReactTable, 
    getCoreRowModel, 
    getSortedRowModel, 
    flexRender,
    createColumnHelper,
    SortingState,
    VisibilityState,
    ColumnDef
} from '@tanstack/react-table';
import { Folder, ArrowUp, ArrowDown, Settings } from 'lucide-react';
import { Track } from '../types';

interface Props {
    refreshTrigger: number;
    onSelect: (track: Track) => void;
    selectedTrackId: number | null;
}

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

export function TrackList({ refreshTrigger, onSelect, selectedTrackId }: Props) {
    const [tracks, setTracks] = useState<Track[]>([]);
    const [loading, setLoading] = useState(false);
    
    // Table State
    const [sorting, setSorting] = useState<SortingState>([]);
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
        album: false,
        format: false,
        size_bytes: false,
        modified_date: false,
        grouping_raw: false
    });
    const [isMenuOpen, setIsMenuOpen] = useState(false);

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
            header: 'Artist',
            cell: info => info.getValue(),
            size: 150,
        }),
        columnHelper.accessor('title', {
            header: 'Title',
            cell: info => info.getValue(),
            size: 200,
        }),
        columnHelper.accessor('album', {
            header: 'Album',
            cell: info => info.getValue(),
            size: 150,
        }),
        // Comment is split into User Comment and Tags
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
            header: 'Time',
            cell: info => formatDuration(info.getValue()),
            size: 60,
        }),
        columnHelper.accessor('format', {
            header: 'Format',
            cell: info => info.getValue(),
            size: 80,
        }),
        columnHelper.accessor('size_bytes', {
            header: 'Size',
            cell: info => formatSize(info.getValue()),
            size: 80,
        }),
        columnHelper.accessor('modified_date', {
            header: 'Modified',
            cell: info => formatDate(info.getValue()),
            size: 100,
        }),
        columnHelper.display({
            id: 'actions',
            size: 40,
            header: () => (
                <div style={{ textAlign: 'center' }}>
                    <Settings 
                        size={14} 
                        style={{ cursor: 'pointer', opacity: 0.7 }} 
                        onClick={(e) => {
                            e.stopPropagation();
                            setIsMenuOpen(!isMenuOpen);
                        }}
                    />
                </div>
            ),
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
        data: tracks,
        columns,
        state: {
            sorting,
            columnVisibility,
        },
        columnResizeMode: 'onChange',
        onSortingChange: setSorting,
        onColumnVisibilityChange: setColumnVisibility,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });

    return (
        <div style={{ width: '100%', fontSize: '13px', position: 'relative' }}>
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
            
            <table style={{ 
                width: table.getTotalSize(), 
                minWidth: '100%',
                borderCollapse: 'separate', 
                borderSpacing: 0,
                tableLayout: 'fixed' 
            }}>
                <thead style={{ 
                    position: 'sticky', 
                    top: 0, 
                    background: 'var(--bg-primary)', 
                    zIndex: 10,
                }}>
                    {table.getHeaderGroups().map(headerGroup => (
                        <tr key={headerGroup.id}>
                            {headerGroup.headers.map(header => (
                                <th 
                                    key={header.id} 
                                    style={{ 
                                        width: header.getSize(),
                                        padding: '12px 10px', 
                                        textAlign: 'left',
                                        borderBottom: '1px solid var(--border-color)',
                                        borderRight: '1px solid var(--border-color)',
                                        color: 'var(--text-secondary)',
                                        fontSize: '12px',
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.05em',
                                        fontWeight: 600,
                                        position: 'relative',
                                        userSelect: 'none'
                                    }}
                                >
                                    {header.isPlaceholder ? null : (
                                        <div 
                                            onClick={header.column.getToggleSortingHandler()}
                                            style={{ 
                                                cursor: header.column.getCanSort() ? 'pointer' : 'default',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '4px'
                                            }}
                                        >
                                            {flexRender(header.column.columnDef.header, header.getContext())}
                                            {{
                                                asc: <ArrowUp size={12} />,
                                                desc: <ArrowDown size={12} />,
                                            }[header.column.getIsSorted() as string] ?? null}
                                        </div>
                                    )}
                                    {/* Resizer */}
                                    <div
                                        onMouseDown={header.getResizeHandler()}
                                        onTouchStart={header.getResizeHandler()}
                                        className={`resizer ${
                                            header.column.getIsResizing() ? 'isResizing' : ''
                                        }`}
                                    />
                                </th>
                            ))}
                        </tr>
                    ))}
                </thead>
                <tbody>
                    {table.getRowModel().rows.map(row => {
                        const isSelected = selectedTrackId === row.original.id;
                        return (
                            <tr 
                                key={row.id}
                                onClick={() => onSelect(row.original)}
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
                    {tracks.length === 0 && !loading && (
                        <tr>
                            <td colSpan={columns.length} style={{ padding: '60px', textAlign: 'center', color: 'var(--text-secondary)' }}>
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
