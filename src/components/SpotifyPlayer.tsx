import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, AudioLines } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';
import { playerStyles } from './playerStyles';
import { isTextEntryFocused } from '../utils/keyboard';

// Keys that actually move a range input's value — the keyboard seek path.
// Anything else (Tab, ⌘K, plain letters) must neither arm a scrub nor commit one.
const SEEK_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];

interface Props {
    track: Track;
    autoPlay?: boolean;
    onAutoPlayProcessed?: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    accentColor?: string;
    onPlayStateChange?: (isPlaying: boolean) => void;
}

// Transport bar for Spotify ghost tracks (source === 'spotify', no local file).
// Drives playback through Spotify Connect (the user's active device / the
// Spotify desktop app) rather than decoding any audio locally. Mirrors
// Player.tsx's footer footprint (same container/icon-button styles) so
// swapping between the two transports causes no layout shift.
export function SpotifyPlayer({ track, autoPlay, onAutoPlayProcessed, onNext, onPrev, accentColor = '#1DB954', onPlayStateChange }: Props) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [progressMs, setProgressMs] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const durationMs = Math.round(track.duration_secs * 1000);
    const lastPollRef = useRef<number>(0);
    // While the user is actively dragging the seek handle or holding an arrow
    // key on it, suppress the interpolation tick and poll overwrites so the
    // handle doesn't fight the drag; commit exactly one spotify_seek on release.
    const isScrubbingRef = useRef(false);
    // Mirrors isPlaying for the unmount-cleanup closure below, which otherwise
    // would only ever see the isPlaying value from the render that mounted it.
    const isPlayingRef = useRef(false);
    useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

    // Error toast timer
    useEffect(() => {
        if (error) {
            const timer = setTimeout(() => setError(null), 5000);
            return () => clearTimeout(timer);
        }
    }, [error]);

    // Pause Spotify playback when this transport unmounts — switching to a
    // local track (or closing the player) otherwise leaves Spotify playing
    // behind whatever comes next, so two audio streams run in parallel.
    // Empty deps: the cleanup below only runs on a real unmount, never on a
    // re-render. Fire-and-forget — there's no UI left here to show an error.
    useEffect(() => {
        return () => {
            if (isPlayingRef.current) {
                invoke('spotify_pause').catch(() => {});
            }
        };
    }, []);

    // Start playback when the track changes (double-click sets autoPlay).
    useEffect(() => {
        if (!autoPlay || !track.spotify_id) return;
        setError(null);
        // Reset unconditionally before the request goes out — if it fails
        // (non-Premium, no network, device-wake timeout), we must not be left
        // showing the previous track's progress/isPlaying, which would make
        // togglePlay send pause/resume against whatever Spotify actually has
        // active rather than this track.
        setIsPlaying(false);
        setProgressMs(0);
        invoke('spotify_play_track', { spotifyId: track.spotify_id })
            .then(() => { setIsPlaying(true); onPlayStateChange?.(true); })
            .catch(e => setError(String(e)))
            .finally(() => onAutoPlayProcessed?.());
    }, [track.id, autoPlay]);

    // Poll real state every 5s; interpolate between polls.
    useEffect(() => {
        const poll = async () => {
            try {
                const s = await invoke<{ is_playing: boolean; progress_ms: number; track_uri: string | null } | null>('spotify_get_playback');
                if (!s || s.track_uri !== `spotify:track:${track.spotify_id}`) return;
                setIsPlaying(s.is_playing);
                // Don't let a poll response overwrite the handle position while
                // the user is mid-drag/mid-keypress on the seek slider.
                if (!isScrubbingRef.current) setProgressMs(s.progress_ms);
                onPlayStateChange?.(s.is_playing);
                lastPollRef.current = Date.now();
            } catch { /* offline / no device — leave UI as-is */ }
        };
        poll();
        const pollId = setInterval(poll, 5000);
        const tickId = setInterval(() => {
            if (isScrubbingRef.current) return;
            setProgressMs(p => (isPlaying ? Math.min(p + 250, durationMs) : p));
        }, 250);
        return () => { clearInterval(pollId); clearInterval(tickId); };
    }, [track.id, isPlaying, durationMs]);

    const togglePlay = async () => {
        try {
            if (isPlaying) { await invoke('spotify_pause'); setIsPlaying(false); onPlayStateChange?.(false); }
            else { await invoke('spotify_resume'); setIsPlaying(true); onPlayStateChange?.(true); }
        } catch (e) { setError(String(e)); }
    };

    // Space toggles play/pause, same as the local player. Via a ref because
    // togglePlay closes over isPlaying and is recreated every render — the
    // listener itself binds once.
    const togglePlayRef = useRef(togglePlay);
    useEffect(() => { togglePlayRef.current = togglePlay; });
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
                if (!isTextEntryFocused()) {
                    e.preventDefault();
                    togglePlayRef.current();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // Dragging (or arrow-keying) the seek handle must not fire a network call
    // per tick — onChange only updates local UI while scrubbing; the actual
    // spotify_seek PUT is committed once, on release.
    const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setProgressMs(Number(e.target.value));
    };

    const startScrub = () => {
        isScrubbingRef.current = true;
    };

    // Keyboard path only arms on keys that actually move the slider —
    // otherwise Tab/⌘K/any letter while focused would arm a scrub that never
    // commits (focus leaves before keyup), stranding isScrubbingRef true.
    const startKeyScrub = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (SEEK_KEYS.includes(e.key)) isScrubbingRef.current = true;
    };

    // Shared release handler for both pointer (mouse/touch drag) and keyboard
    // (arrow-key) seeking — keyboard seeking has no pointerup, so onKeyUp
    // commits the same way onPointerUp does for a drag.
    const commitSeek = (e: React.SyntheticEvent<HTMLInputElement>) => {
        if (!isScrubbingRef.current) return;
        isScrubbingRef.current = false;
        const ms = Number(e.currentTarget.value);
        invoke('spotify_seek', { positionMs: ms }).catch(() => { /* ignore */ });
    };

    // Keyup side of the same gate: only a seek key's release commits, so a
    // stray letter/modifier keyup can never fire a seek (e.g. mid pointer-drag).
    const commitKeySeek = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (SEEK_KEYS.includes(e.key)) commitSeek(e);
    };

    // Abandon a scrub without committing — focus stolen mid-scrub (Tab, ⌘K
    // quick switcher, Cmd+Tab) or a cancelled pointer drag. The pending
    // position is dropped (no stale spotify_seek), and the tick/poll resume
    // driving progressMs, which self-corrects the handle.
    const cancelScrub = () => {
        isScrubbingRef.current = false;
    };

    const fmt = (ms: number) => {
        const s = Math.floor(ms / 1000);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };

    return (
        <div style={playerStyles.container}>
            {/* Left: Track Info — mirrors LocalPlayer's info block */}
            <div style={{ ...playerStyles.info, display: 'flex', alignItems: 'center' }}>
                <div style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '4px',
                    overflow: 'hidden',
                    marginRight: '12px',
                    background: 'var(--bg-tertiary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                }}>
                    <AudioLines size={22} color={accentColor} />
                </div>
                <div style={{ minWidth: 0 }}>
                    <div style={{
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}>
                        {track.title || 'Unknown'}
                    </div>
                    <div style={{
                        fontSize: '12px',
                        color: 'var(--text-secondary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}>
                        {track.artist || 'Unknown'} · via Spotify Connect
                    </div>
                </div>
            </div>

            {/* Center: Controls + Seek bar */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '16px', margin: '0 20px', maxWidth: '800px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <button onClick={onPrev} style={playerStyles.iconButton} title="Previous Track">
                        <SkipBack size={20} />
                    </button>

                    <button
                        onClick={togglePlay}
                        style={{
                            background: accentColor,
                            border: 'none',
                            borderRadius: '50%',
                            width: '40px',
                            height: '40px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            color: 'white',
                            flexShrink: 0,
                            margin: '0 8px',
                        }}
                        title={isPlaying ? 'Pause' : 'Play'}
                    >
                        {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" style={{ marginLeft: '2px' }} />}
                    </button>

                    <button onClick={onNext} style={playerStyles.iconButton} title="Next Track">
                        <SkipForward size={20} />
                    </button>
                </div>

                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{fmt(progressMs)}</span>
                    <input
                        type="range"
                        min={0}
                        max={durationMs || 0}
                        value={Math.min(progressMs, durationMs)}
                        onChange={handleSeekChange}
                        onPointerDown={startScrub}
                        onPointerUp={commitSeek}
                        onPointerCancel={cancelScrub}
                        onKeyDown={startKeyScrub}
                        onKeyUp={commitKeySeek}
                        onBlur={cancelScrub}
                        style={{ flex: 1, accentColor }}
                    />
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{fmt(durationMs)}</span>
                </div>
            </div>

            {/* Right: Spotify badge — mirrors LocalPlayer's volume column width for layout parity */}
            <div style={{ width: '200px', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                <AudioLines size={14} color={accentColor} />
                Spotify Connect
            </div>

            {/* Error Toast — same styling as LocalPlayer's */}
            {error && (
                <div style={{
                    position: 'absolute',
                    bottom: '90px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'var(--error-color)',
                    color: 'white',
                    padding: '8px 16px',
                    borderRadius: '6px',
                    fontSize: '13px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                    animation: 'fadeIn 0.3s ease-out',
                    zIndex: 200,
                    maxWidth: '80%',
                    textAlign: 'center',
                }}>
                    {error}
                </div>
            )}
        </div>
    );
}
