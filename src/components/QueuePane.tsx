import { CSSProperties, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DndContext, DragEndEvent, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, ListMusic, Music, Trash2, X } from 'lucide-react';
import { Track } from '../types';

interface Props {
    nowPlaying: Track | null;
    /** The manual play queue, front = plays next. */
    queue: Track[];
    /** Display-only preview of what the tracklist plays after the queue empties. */
    upcoming: Track[];
    /** Name of the context the upcoming tracks come from (playlist name or "Library"). */
    sourceName: string;
    onRemoveAt: (index: number) => void;
    onMoveItem: (from: number, to: number) => void;
    onClear: () => void;
    /** Play queue[index] immediately (drops it and everything queued before it). */
    onJumpTo: (index: number) => void;
}

const sectionHeaderStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 14px 6px',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: 'var(--text-secondary)',
};

const TrackLabel = ({ track, dimmed }: { track: Track; dimmed?: boolean }) => (
    <div style={{ minWidth: 0, flex: 1, opacity: dimmed ? 0.6 : 1 }}>
        <div style={{
            fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
            {track.title || 'Untitled'}
        </div>
        <div style={{
            fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
            {track.artist || 'Unknown Artist'}
        </div>
    </div>
);

// One sortable row in the manual queue. Sortable id is index-based ("qi-3")
// because the same track may be queued more than once.
const QueueRow = ({ track, index, onRemove, onJump }: {
    track: Track;
    index: number;
    onRemove: () => void;
    onJump: () => void;
}) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
        useSortable({ id: `qi-${index}` });
    const [hovered, setHovered] = useState(false);

    return (
        <div
            ref={setNodeRef}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                opacity: isDragging ? 0.5 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 10px 6px 6px',
                cursor: 'default',
                background: hovered ? 'var(--bg-tertiary)' : 'transparent',
            }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onDoubleClick={onJump}
            title="Double-click to play now"
        >
            <span
                {...attributes}
                {...listeners}
                style={{ display: 'flex', alignItems: 'center', cursor: 'grab', color: 'var(--text-secondary)', touchAction: 'none' }}
            >
                <GripVertical size={14} />
            </span>
            <TrackLabel track={track} />
            <button
                onClick={(e) => { e.stopPropagation(); onRemove(); }}
                style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: 'var(--text-secondary)', padding: '2px', display: 'flex',
                    alignItems: 'center', visibility: hovered ? 'visible' : 'hidden',
                }}
                title="Remove from queue"
            >
                <X size={14} />
            </button>
        </div>
    );
};

export const QueuePane = ({ nowPlaying, queue, upcoming, sourceName, onRemoveAt, onMoveItem, onClear, onJumpTo }: Props) => {
    const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

    // Same artwork fetch as Player.tsx — blob URL from raw bytes.
    useEffect(() => {
        setArtworkUrl(null);
        if (!nowPlaying) return;
        let active = true;
        invoke<number[] | null>('get_track_artwork', { id: nowPlaying.id })
            .then(data => {
                if (active && data) {
                    setArtworkUrl(URL.createObjectURL(new Blob([new Uint8Array(data)])));
                }
            })
            .catch(e => console.warn('Artwork fetch failed', e));
        return () => { active = false; };
    }, [nowPlaying?.id]);

    useEffect(() => {
        return () => { if (artworkUrl) URL.revokeObjectURL(artworkUrl); };
    }, [artworkUrl]);

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const from = Number(String(active.id).replace('qi-', ''));
        const to = Number(String(over.id).replace('qi-', ''));
        if (!Number.isNaN(from) && !Number.isNaN(to)) onMoveItem(from, to);
    };

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
            {/* Now Playing */}
            <div style={sectionHeaderStyle}><span>Now Playing</span></div>
            {nowPlaying ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '2px 14px 10px' }}>
                    <div style={{
                        width: '40px', height: '40px', borderRadius: '4px', flexShrink: 0,
                        background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', color: 'var(--text-secondary)', overflow: 'hidden',
                    }}>
                        {artworkUrl
                            ? <img src={artworkUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            : <Music size={18} />}
                    </div>
                    <TrackLabel track={nowPlaying} />
                </div>
            ) : (
                <div style={{ padding: '2px 14px 10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Nothing playing
                </div>
            )}

            {/* Manual queue */}
            <div style={sectionHeaderStyle}>
                <span>Next in Queue</span>
                {queue.length > 0 && (
                    <button
                        onClick={onClear}
                        style={{
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            color: 'var(--text-secondary)', display: 'flex', alignItems: 'center',
                            gap: '4px', fontSize: '11px', padding: '2px 4px',
                        }}
                        title="Clear queue"
                    >
                        <Trash2 size={12} />
                        Clear
                    </button>
                )}
            </div>
            {queue.length === 0 ? (
                <div style={{ padding: '2px 14px 10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Queue is empty — right-click a track or press Q
                </div>
            ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={queue.map((_, i) => `qi-${i}`)} strategy={verticalListSortingStrategy}>
                        <div>
                            {queue.map((track, i) => (
                                <QueueRow
                                    key={`qi-${i}-${track.id}`}
                                    track={track}
                                    index={i}
                                    onRemove={() => onRemoveAt(i)}
                                    onJump={() => onJumpTo(i)}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            )}

            {/* Upcoming from the tracklist (display only) */}
            <div style={sectionHeaderStyle}><span>Next up from {sourceName}</span></div>
            {upcoming.length === 0 ? (
                <div style={{ padding: '2px 14px 14px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Nothing up next
                </div>
            ) : (
                <div style={{ paddingBottom: '14px' }}>
                    {upcoming.map((track, i) => (
                        <div key={`up-${i}-${track.id}`} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px 6px 12px' }}>
                            <ListMusic size={13} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                            <TrackLabel track={track} dimmed />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
