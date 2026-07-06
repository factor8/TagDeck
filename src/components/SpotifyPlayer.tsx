import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, AudioLines } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';
import { playerStyles } from './Player';

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

    // Start playback when the track changes (double-click sets autoPlay).
    useEffect(() => {
        if (!autoPlay || !track.spotify_id) return;
        setError(null);
        invoke('spotify_play_track', { spotifyId: track.spotify_id })
            .then(() => { setIsPlaying(true); setProgressMs(0); onPlayStateChange?.(true); })
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
                setProgressMs(s.progress_ms);
                onPlayStateChange?.(s.is_playing);
                lastPollRef.current = Date.now();
            } catch { /* offline / no device — leave UI as-is */ }
        };
        poll();
        const pollId = setInterval(poll, 5000);
        const tickId = setInterval(() => {
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

    const seek = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const ms = Number(e.target.value);
        setProgressMs(ms);
        try { await invoke('spotify_seek', { positionMs: ms }); } catch { /* ignore */ }
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
                        onChange={seek}
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
