import { CSSProperties, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DndContext, DragEndEvent, PointerSensor, closestCenter, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, ListPlus, Music, Plus, Search, X } from 'lucide-react';
import { Playlist, Track } from '../types';
import { useArmedDroppableId } from './DragArmContext';

interface Props {
    /** The playlist being built, or null to show the picker. */
    targetPlaylistId: number | null;
    /** Ordered track ids currently in the target playlist. */
    trackIds: number[];
    onSetTarget: (playlistId: number) => void;
    onCreateAndTarget: (name: string) => void;
    onClearTarget: () => void;
    onRemove: (trackId: number) => void;
    onReorder: (orderedTrackIds: number[]) => void;
    onPlay: (track: Track) => void;
    /** Bumped by App when playlist membership changes, forces a reload. */
    refreshTrigger: number;
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

const inputStyle: CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    fontSize: '13px',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: '4px',
    color: 'var(--text-primary)',
    outline: 'none',
};

// h:mm:ss for long totals, m:ss otherwise.
const formatTotal = (secs: number) => {
    const s = Math.round(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
};

const TrackLabel = ({ track }: { track: Track }) => (
    <div style={{ minWidth: 0, flex: 1 }}>
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

const BuilderRow = ({ track, onRemove, onPlay }: {
    track: Track;
    onRemove: () => void;
    onPlay: () => void;
}) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
        useSortable({ id: String(track.id) });
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
            onDoubleClick={onPlay}
            title="Double-click to play"
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
                title="Remove from playlist"
            >
                <X size={14} />
            </button>
        </div>
    );
};

export const PlaylistBuilderPane = ({
    targetPlaylistId, trackIds, onSetTarget, onCreateAndTarget, onClearTarget,
    onRemove, onReorder, onPlay, refreshTrigger,
}: Props) => {
    const [playlists, setPlaylists] = useState<Playlist[]>([]);
    const [trackMap, setTrackMap] = useState<Map<number, Track>>(new Map());
    const [pickerFilter, setPickerFilter] = useState('');
    const [newName, setNewName] = useState('');
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

    useEffect(() => {
        invoke<Playlist[]>('get_playlists')
            .then(setPlaylists)
            .catch(e => console.warn('Builder: get_playlists failed', e));
    }, [refreshTrigger]);

    // Load the library once (and on refresh) to resolve ids -> Track for display.
    useEffect(() => {
        if (targetPlaylistId == null) return;
        invoke<Track[]>('get_tracks')
            .then(tracks => setTrackMap(new Map(tracks.map(t => [t.id, t]))))
            .catch(e => console.warn('Builder: get_tracks failed', e));
    }, [targetPlaylistId, refreshTrigger]);

    const target = useMemo(
        () => playlists.find(p => p.id === targetPlaylistId) ?? null,
        [playlists, targetPlaylistId],
    );

    const rows = useMemo(
        () => trackIds.map(id => trackMap.get(id)).filter((t): t is Track => !!t),
        [trackIds, trackMap],
    );

    const totalSecs = useMemo(() => rows.reduce((sum, t) => sum + (t.duration_secs || 0), 0), [rows]);

    const dropId = targetPlaylistId != null ? `playlist-${targetPlaylistId}` : 'builder-no-target';
    const { setNodeRef: setDropRef, isOver } = useDroppable({ id: dropId });
    // Held past the dwell → "release to add"; hovering but not yet armed → "hold to add…".
    const isArmed = useArmedDroppableId() === dropId;

    const handleReorderEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const from = trackIds.indexOf(Number(active.id));
        const to = trackIds.indexOf(Number(over.id));
        if (from === -1 || to === -1) return;
        const next = [...trackIds];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        onReorder(next);
    };

    // ---- No target: picker ----
    if (targetPlaylistId == null) {
        const candidates = playlists.filter(p =>
            !p.is_folder &&
            p.origin !== 'spotify' &&
            p.name.toLowerCase().includes(pickerFilter.toLowerCase())
        );
        return (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
                <div style={sectionHeaderStyle}><span>Build a playlist</span></div>
                <div style={{ padding: '2px 14px 10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Pick a playlist to fill, then add songs from the list.
                </div>

                {/* Create new */}
                <div style={{ padding: '0 14px 12px', display: 'flex', gap: '6px' }}>
                    <input
                        style={inputStyle}
                        placeholder="New playlist name…"
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter' && newName.trim()) {
                                onCreateAndTarget(newName.trim());
                                setNewName('');
                            }
                        }}
                    />
                    <button
                        onClick={() => { if (newName.trim()) { onCreateAndTarget(newName.trim()); setNewName(''); } }}
                        disabled={!newName.trim()}
                        style={{
                            display: 'flex', alignItems: 'center', gap: '4px', padding: '0 10px',
                            background: 'var(--accent-color)', color: '#fff', border: 'none',
                            borderRadius: '4px', cursor: newName.trim() ? 'pointer' : 'default',
                            opacity: newName.trim() ? 1 : 0.5, fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap',
                        }}
                        title="Create a new playlist and build it"
                    >
                        <Plus size={14} /> New
                    </button>
                </div>

                {/* Pick existing */}
                <div style={{ padding: '0 14px 8px', position: 'relative' }}>
                    <Search size={13} style={{ position: 'absolute', left: '22px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
                    <input
                        style={{ ...inputStyle, paddingLeft: '26px' }}
                        placeholder="Search playlists…"
                        value={pickerFilter}
                        onChange={e => setPickerFilter(e.target.value)}
                    />
                </div>
                <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '14px' }}>
                    {candidates.length === 0 ? (
                        <div style={{ padding: '8px 14px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                            No playlists match.
                        </div>
                    ) : candidates.map(p => (
                        <button
                            key={p.id}
                            onClick={() => onSetTarget(p.id)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
                                padding: '7px 14px', background: 'transparent', border: 'none',
                                color: 'var(--text-primary)', cursor: 'pointer', fontSize: '13px', textAlign: 'left',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                            <ListPlus size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    // ---- Target set: build list ----
    return (
        <div ref={setDropRef} style={{
            height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto',
            outline: isArmed ? '2px solid var(--accent-color)'
              : isOver ? '2px dashed var(--accent-color)'
              : '2px solid transparent',
            outlineOffset: '-2px',
            background: isArmed ? 'rgba(59, 130, 246, 0.08)' : undefined,
            transition: 'background-color 0.2s ease',
        }}>
            <div style={{ ...sectionHeaderStyle, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                    <div style={{ color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, textTransform: 'none', letterSpacing: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {target?.name ?? 'Playlist'}
                    </div>
                    <div style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, marginTop: '2px' }}>
                        {rows.length} track{rows.length === 1 ? '' : 's'} · {formatTotal(totalSecs)}
                    </div>
                </div>
                <button
                    onClick={onClearTarget}
                    style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--text-secondary)', display: 'flex', alignItems: 'center',
                        gap: '4px', fontSize: '11px', padding: '2px 4px', flexShrink: 0,
                    }}
                    title="Choose a different playlist"
                >
                    Change
                </button>
            </div>

            {rows.length === 0 ? (
                <div style={{ padding: '10px 14px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Empty — add songs with the <Plus size={11} style={{ verticalAlign: 'middle' }} /> button, drag them here, or right-click a track.
                </div>
            ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleReorderEnd}>
                    <SortableContext items={trackIds.map(String)} strategy={verticalListSortingStrategy}>
                        <div style={{ paddingBottom: '14px' }}>
                            {rows.map(track => (
                                <BuilderRow
                                    key={track.id}
                                    track={track}
                                    onRemove={() => onRemove(track.id)}
                                    onPlay={() => onPlay(track)}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            )}

            {rows.length === 0 && (
                <div style={{ padding: '0 14px', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'center', marginTop: '10px' }}>
                    <Music size={28} style={{ opacity: 0.3 }} />
                </div>
            )}
        </div>
    );
};
