import { stat } from '@tauri-apps/plugin-fs';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { Track } from '../types';
import { useEffect, useState, useRef, useCallback } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, Volume2, VolumeX, SkipBack, SkipForward, RotateCcw, RotateCw, Music, AlertTriangle } from 'lucide-react';
import { useDebug } from './DebugContext';
import { SpotifyPlayer } from './SpotifyPlayer';
import { isTextEntryFocused } from '../utils/keyboard';
import { playerStyles } from './playerStyles';

function formatFileSize(bytes: number): string {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatTime(seconds: number): string {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface Props {
    track: Track | null;
    playlistId?: number | null;
    playlistName?: string;
    onPlaylistClick?: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    autoPlay?: boolean;
    playerMode?: 'standard' | 'waveform';
    onTrackError?: () => void;
    accentColor?: string;
    onArtworkClick?: () => void;
    onTrackClick?: () => void;
    onPlayStateChange?: (isPlaying: boolean) => void;
    onAutoPlayProcessed?: () => void;
}

export function Player(props: Props) {
    // Ghost tracks (Spotify, no local file) route to the Spotify Connect
    // transport instead of the local WaveSurfer/file-based player. This check
    // must happen before any hooks are called (component switch, not a branch
    // inside a single component), so hook order stays legal in both paths.
    if (props.track && props.track.source === 'spotify') {
        return (
            <SpotifyPlayer
                track={props.track}
                autoPlay={props.autoPlay}
                onAutoPlayProcessed={props.onAutoPlayProcessed}
                onNext={props.onNext}
                onPrev={props.onPrev}
                accentColor={props.accentColor}
                onPlayStateChange={props.onPlayStateChange}
            />
        );
    }
    return <LocalPlayer {...props} />;
}

function LocalPlayer({ track, playlistName, onPlaylistClick, onNext, onPrev, autoPlay = false, playerMode = 'standard', onTrackError, accentColor = '#3b82f6', onArtworkClick, onTrackClick, onPlayStateChange, onAutoPlayProcessed }: Props) {
    const { debugMode } = useDebug();
    const containerRef = useRef<HTMLDivElement>(null);
    const waveformRef = useRef<HTMLDivElement>(null);
    const autoPlayRef = useRef(autoPlay);
    const playerModeRef = useRef(playerMode);
    const prevTrackIdRef = useRef<number | null>(null);
    const onPlayStateChangeRef = useRef(onPlayStateChange);
    const onNextRef = useRef(onNext);
    const onAutoPlayProcessedRef = useRef(onAutoPlayProcessed);

    // Keep refs up to date
    useEffect(() => {
        autoPlayRef.current = autoPlay;
        playerModeRef.current = playerMode;
        onPlayStateChangeRef.current = onPlayStateChange;
        onNextRef.current = onNext;
        onAutoPlayProcessedRef.current = onAutoPlayProcessed;
    }, [autoPlay, playerMode, onPlayStateChange, onNext, onAutoPlayProcessed]);

    const [wavesurfer, setWavesurfer] = useState<WaveSurfer | null>(null);
    const wavesurferRef = useRef<WaveSurfer | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
    const [usingMediaFallback, setUsingMediaFallback] = useState(false);
    const [waveformRevealed, setWaveformRevealed] = useState(false);
    const [showRemaining, setShowRemaining] = useState(() => localStorage.getItem('app_time_display') === 'remaining');
    const [playbackProgress, setPlaybackProgress] = useState(0);
    const [playbackDuration, setPlaybackDuration] = useState(0);
    const [playbackCurrentTime, setPlaybackCurrentTime] = useState(0);
    const mediaElementRef = useRef<HTMLAudioElement | null>(null);
    const userPausedRef = useRef(false);
    const prevPlayerModeRef = useRef(playerMode);
    const [reloadCounter, setReloadCounter] = useState(0);
    const savedPlaybackStateRef = useRef<{ position: number; wasPlaying: boolean } | null>(null);

    // Fetch Artwork
    useEffect(() => {
        setArtworkUrl(null);
        if (!track) return;
        
        let active = true;
        const fetchArt = async () => {
             try {
                const data = await invoke<number[] | null>('get_track_artwork', { id: track.id });
                if (active && data) {
                     const blob = new Blob([new Uint8Array(data)]);
                     const url = URL.createObjectURL(blob);
                     setArtworkUrl(url);
                }
             } catch(e) {
                 console.warn("Artwork fetch failed", e);
             }
        };
        fetchArt();
        
        return () => {
             active = false;
        };
    }, [track]);

    // Cleanup Artwork URL
    useEffect(() => {
        return () => {
            if (artworkUrl) URL.revokeObjectURL(artworkUrl);
        };
    }, [artworkUrl]);

    // Error toast timer
    useEffect(() => {
        if (error) {
            const timer = setTimeout(() => setError(null), 5000);
            return () => clearTimeout(timer);
        }
    }, [error]);

    // Helper: dispose the current <audio> element without firing a spurious
    // error — setting src = '' makes WebKit emit MEDIA_ERR_SRC_NOT_SUPPORTED
    // (code 4) on the discarded element; removing the attribute doesn't.
    const disposeMediaElement = useCallback(() => {
        const el = mediaElementRef.current;
        if (el) {
            el.pause();
            el.removeAttribute('src');
            try { el.load(); } catch (_) { /* ignore */ }
            mediaElementRef.current = null;
        }
    }, []);

    // Cleanup on unmount: destroy any active WaveSurfer and audio element
    useEffect(() => {
        return () => {
            if (wavesurferRef.current) {
                try { wavesurferRef.current.destroy(); } catch (_) { /* ignore */ }
                wavesurferRef.current = null;
            }
            disposeMediaElement();
        };
    }, [disposeMediaElement]);

    // Update WaveSurfer colors when accent/theme changes
    const accentColorRef = useRef(accentColor);
    useEffect(() => {
        accentColorRef.current = accentColor;
        if (wavesurferRef.current) {
            wavesurferRef.current.setOptions({
                progressColor: accentColor
            });
        }
    }, [accentColor, wavesurfer]); // wavesurfer state triggers re-run when instance changes

    // Helper: destroy current WaveSurfer and clear waveform sub-div of ghost canvases
    // IMPORTANT: Only clear the waveform sub-div, NOT the container — the container
    // has React-managed children (scrub bar) that would crash React if removed.
    const destroyCurrentWaveSurfer = useCallback(() => {
        if (wavesurferRef.current) {
            try { wavesurferRef.current.destroy(); } catch (_) { /* ignore */ }
            wavesurferRef.current = null;
        }
        // Clear only the waveform sub-div (WaveSurfer canvases), not the React container
        if (waveformRef.current) {
            waveformRef.current.innerHTML = '';
        }
    }, []);

    // Helper: set the active WaveSurfer (both state + ref)
    const setActiveWaveSurfer = useCallback((ws: WaveSurfer | null) => {
        wavesurferRef.current = ws;
        setWavesurfer(ws);
    }, []);

    // Helper: create a media-element-backed WaveSurfer. Playback streams through
    // the <audio> element and starts on 'canplay' — never gated on waveform decode.
    // When showWaveform is true the canvas is visible and WaveSurfer decodes peaks
    // in the background; when false (standard mode) the canvas is hidden (height: 0)
    // and only the scrub bar overlay shows.
    const createMediaWaveSurfer = useCallback((audioEl: HTMLAudioElement, showWaveform: boolean) => {
        if (!waveformRef.current) return null;
        const ws = WaveSurfer.create({
            container: waveformRef.current,
            ...(showWaveform ? {
                waveColor: '#475569',
                progressColor: accentColorRef.current,
                cursorColor: '#f1f5f9',
                barWidth: 2,
                barGap: 1,
                barRadius: 2,
                height: 40,
                interact: true,
            } : {
                waveColor: 'transparent',
                progressColor: 'transparent',
                cursorColor: 'transparent',
                height: 0,
                interact: false, // scrub bar handles interaction
            }),
            normalize: true,
            media: audioEl,
        });
        ws.on('play', () => { setIsPlaying(true); if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(true); });
        ws.on('pause', () => { setIsPlaying(false); if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(false); });
        ws.on('finish', () => { setIsPlaying(false); if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(false); if (onNextRef.current) onNextRef.current(); });
        ws.on('timeupdate', (currentTime: number) => {
            const dur = ws.getDuration();
            setPlaybackCurrentTime(currentTime);
            setPlaybackDuration(dur);
            setPlaybackProgress(dur > 0 ? currentTime / dur : 0);
        });
        if (showWaveform) {
            // Peaks are decoded — roll the waveform out left to right
            ws.on('ready', () => setWaveformRevealed(true));
        }
        // The background peaks decode can fail (e.g. ALAC — Web Audio can't decode
        // it) while the <audio> element still plays natively. Playback is
        // unaffected; in waveform mode drop to the scrub-bar UI.
        ws.on('error', (decodeErr: any) => {
            if (showWaveform) {
                console.warn('Waveform decode failed (playback unaffected), using scrub bar:', decodeErr);
                invoke('log_from_frontend', { level: 'WARN', message: `Waveform decode failed, using scrub bar: ${decodeErr}` }).catch(console.error);
                setUsingMediaFallback(true);
            } else {
                console.warn('Hidden waveform decode error (playback unaffected):', decodeErr);
            }
        });

        // Drive playback from the <audio> element directly — never wait for
        // WaveSurfer's 'ready' (that's the waveform decode, not the audio).
        const startPlayback = () => {
            setPlaybackDuration(audioEl.duration || 0);
            
            // Restore saved playback state if available
            if (savedPlaybackStateRef.current) {
                const { position, wasPlaying } = savedPlaybackStateRef.current;
                console.log(`[Player] Restoring playback state (fallback): position=${position.toFixed(2)}s, wasPlaying=${wasPlaying}`);
                audioEl.currentTime = position;
                if (wasPlaying && !userPausedRef.current) {
                    userPausedRef.current = false;
                    ws.play().catch(e => console.warn('Play after restore (fallback) failed:', e));
                }
                savedPlaybackStateRef.current = null;
                if (autoPlayRef.current) {
                    onAutoPlayProcessedRef.current?.();
                }
            } else if (autoPlayRef.current && !userPausedRef.current) {
                // Use ws.play() so WaveSurfer tracks play state (enables playPause)
                userPausedRef.current = false;
                ws.play().catch(e => console.warn('Auto-play (fallback) failed:', e));
                // Notify parent that autoplay has been processed
                onAutoPlayProcessedRef.current?.();
            }
        };
        if (audioEl.readyState >= 3) {
            // Already loaded (HAVE_FUTURE_DATA or HAVE_ENOUGH_DATA)
            startPlayback();
        } else {
            audioEl.addEventListener('canplay', startPlayback, { once: true });
        }

        return ws;
    }, []); // No deps — accent color is read via ref so instances aren't recreated on theme change


    // When playerMode changes, force-reload the current track
    useEffect(() => {
        if (playerMode !== prevPlayerModeRef.current) {
            console.log(`[Player] Mode changed: ${prevPlayerModeRef.current} -> ${playerMode}`);
            prevPlayerModeRef.current = playerMode;
            playerModeRef.current = playerMode;

            // If a track is loaded, force a reload by clearing prevTrackIdRef
            // and bumping reloadCounter to trigger the load effect
            if (track && prevTrackIdRef.current !== null) {
                // Save current playback state before destroying
                const ws = wavesurferRef.current;
                if (ws) {
                    const currentTime = ws.getCurrentTime();
                    const wasPlaying = ws.isPlaying();
                    savedPlaybackStateRef.current = { position: currentTime, wasPlaying };
                    console.log(`[Player] Saved playback state: position=${currentTime.toFixed(2)}s, wasPlaying=${wasPlaying}`);
                }

                // Stop current playback and clean up
                disposeMediaElement();
                destroyCurrentWaveSurfer();
                setIsPlaying(false);
                setUsingMediaFallback(false);
                setPlaybackProgress(0);
                setPlaybackDuration(0);
                setPlaybackCurrentTime(0);
                // Reset the track ID ref so the load effect treats this as a new track
                prevTrackIdRef.current = null;
                // Bump counter to force the load effect to re-run
                setReloadCounter(c => c + 1);
            }
        }
    }, [playerMode, track, destroyCurrentWaveSurfer, disposeMediaElement]);

    // Load audio when track changes
    useEffect(() => {
        // If track is null, clear player
        if (!track) {
            prevTrackIdRef.current = null;
            if (wavesurferRef.current) {
                try { wavesurferRef.current.stop(); } catch (_) { /* ignore */ }
            }
            // Also stop any orphaned <audio> element
            disposeMediaElement();
            return;
        }

        // Check if track really changed
        if (track.id !== prevTrackIdRef.current) {
            // Track Changed -> Load New
            prevTrackIdRef.current = track.id;
            
            setError(null);
            setIsPlaying(false);
            userPausedRef.current = false;

            const useWaveform = playerModeRef.current === 'waveform';

            // Clean up everything from previous track
            disposeMediaElement();
            setPlaybackProgress(0);
            setPlaybackDuration(0);
            setPlaybackCurrentTime(0);
            setWaveformRevealed(false);

            // Destroy previous WaveSurfer and clear container DOM
            destroyCurrentWaveSurfer();

            // Stream directly from disk via the asset protocol — no full-file
            // read into memory before playback can start. Both modes share the
            // media-element path; waveform mode just shows the canvas and lets
            // peaks decode in the background.
            const trackLabel = `${track.artist || 'Unknown'} — ${track.title || 'Unknown'}`;
            const assetUrl = convertFileSrc(track.file_path);

            const audioEl = new Audio();
            audioEl.preload = 'auto';
            audioEl.src = assetUrl;
            mediaElementRef.current = audioEl;

            // Load failures now surface on the element instead of a readFile
            // throw — distinguish a missing file from an undecodable one.
            audioEl.addEventListener('error', async () => {
                // Stale element (track switched / disposed mid-load) — not the
                // one currently playing, so its errors are meaningless.
                if (mediaElementRef.current !== audioEl) return;
                const mediaErr = audioEl.error;
                const errStr = `MediaError code=${mediaErr?.code ?? '?'} ${mediaErr?.message ?? ''}`.trim();
                console.error(`Error loading ${trackLabel}:`, errStr);
                let fileMissing = false;
                try { await stat(track.file_path); } catch { fileMissing = true; }
                setError(`Failed to load audio: ${errStr}`);
                invoke('log_from_frontend', {
                    level: 'ERROR',
                    message: `Audio load failed — ${trackLabel} | Format: ${track.format} | Path: ${track.file_path} | Error: ${errStr}${fileMissing ? ' (file missing)' : ''}`
                }).catch(console.error);
                if (fileMissing) {
                    invoke('mark_track_missing', { id: track.id, missing: true })
                        .then(() => { onTrackError?.(); })
                        .catch(e => console.error("Failed to mark track missing:", e));
                }
            }, { once: true });

            const ws = createMediaWaveSurfer(audioEl, useWaveform);
            if (!ws) {
                setError('Playback Error: Could not create player.');
                return;
            }

            setUsingMediaFallback(!useWaveform);
            setActiveWaveSurfer(ws);

            console.log(`[Player] Streaming (${useWaveform ? 'waveform' : 'standard'}): ${trackLabel} (${track.format}, ${formatFileSize(track.size_bytes)})`);
        } else {
             // Exact same track ID. Handle "AutoPlay on existing track" (e.g. double click trigger)
             if (autoPlay) {
                 try {
                    const ws = wavesurferRef.current;
                    if (ws) {
                        if (!ws.isPlaying()) {
                            ws.play().catch(() => {});
                        }
                    }
                    // Notify parent that autoplay has been processed
                    onAutoPlayProcessedRef.current?.();
                 } catch(e) { console.warn("AutoPlay trigger failed", e); }
            }
        }
        
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [track, autoPlay, reloadCounter, createMediaWaveSurfer, destroyCurrentWaveSurfer, setActiveWaveSurfer, onTrackError]);

    // Handle Play/Pause — use ref for synchronous access (no stale closure issues)
    // Don't manually set isPlaying here — let WaveSurfer's play/pause events
    // handle state updates to avoid race conditions with async play().
    const togglePlayPause = useCallback(() => {
        const ws = wavesurferRef.current;
        console.log("Toggle Play/Pause clicked. WaveSurfer instance:", !!ws, "isPlaying:", ws?.isPlaying());
        if (ws) {
            try {
                if (ws.isPlaying()) {
                    userPausedRef.current = true;
                    ws.pause();
                    // Also pause underlying <audio> directly as a safety net
                    if (mediaElementRef.current) {
                        mediaElementRef.current.pause();
                    }
                } else {
                    userPausedRef.current = false;
                    ws.play().catch(e => console.warn("Play failed:", e));
                }
            } catch (e) {
                console.error("Error toggling playback:", e);
            }
        } else {
            console.warn("WaveSurfer instance not ready");
        }
    }, []);

    const skip = (seconds: number) => {
        if (wavesurferRef.current) {
            wavesurferRef.current.skip(seconds);
        }
    };

    const toggleMute = () => {
        const ws = wavesurferRef.current;
        if (ws) {
            const newMuted = !isMuted;
            setIsMuted(newMuted);
            ws.setVolume(newMuted ? 0 : volume);
        }
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseFloat(e.target.value);
        setVolume(newVolume);
        setIsMuted(newVolume === 0);
        if (wavesurferRef.current) {
            wavesurferRef.current.setVolume(newVolume);
        }
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
                // Only a real text-entry surface owns the spacebar — focused
                // buttons/checkboxes/sliders don't block play/pause.
                if (!isTextEntryFocused()) {
                    e.preventDefault();
                    togglePlayPause();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []); // togglePlayPause is stable (uses refs internally)

    const hasTrack = !!track;

    return (
        <div style={playerStyles.container}>
            {/* Left: Track Info */}
            <div style={{ ...playerStyles.info, display: 'flex', alignItems: 'center', opacity: hasTrack ? 1 : 0.5 }}>
                {/* Artwork */}
                <div 
                    onClick={hasTrack ? onArtworkClick : undefined}
                    style={{ 
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
                        cursor: hasTrack ? 'pointer' : 'default'
                    }}
                    title="Toggle sidebar artwork"
                >
                    {artworkUrl ? (
                         <img src={artworkUrl} alt="Album Art" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                         <Music size={24} color="var(--text-secondary)" opacity={0.5} />
                    )}
                </div>
                
                <div style={{ minWidth: 0 }}>
                    <div 
                        onClick={track ? onTrackClick : undefined}
                        style={{ 
                            fontWeight: 600, 
                            color: 'var(--text-primary)', 
                            whiteSpace: 'nowrap', 
                            overflow: 'hidden', 
                            textOverflow: 'ellipsis',
                            cursor: track ? 'pointer' : 'default'
                        }}
                        onMouseEnter={e => track && (e.currentTarget.style.textDecoration = 'underline')}
                        onMouseLeave={e => track && (e.currentTarget.style.textDecoration = 'none')}
                    >
                        {track ? track.title : 'Select a track'}
                    </div>
                    <div 
                        onClick={track ? onTrackClick : undefined}
                        style={{ 
                            fontSize: '12px', 
                            color: 'var(--text-secondary)', 
                            whiteSpace: 'nowrap', 
                            overflow: 'hidden', 
                            textOverflow: 'ellipsis',
                            cursor: track ? 'pointer' : 'default'
                        }}
                        onMouseEnter={e => track && (e.currentTarget.style.textDecoration = 'underline')}
                        onMouseLeave={e => track && (e.currentTarget.style.textDecoration = 'none')}
                    >
                        {track ? track.artist : 'to start playback'}
                    </div>
                    {track && (
                    <div 
                        onClick={onPlaylistClick}
                        style={{ 
                            fontSize: '10px', 
                            color: 'var(--accent-color)', 
                            marginTop: '2px', 
                            cursor: 'pointer',
                            textDecoration: 'none',
                            fontWeight: 500
                        }}
                        onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
                        onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
                    >
                        {playlistName || 'All Tracks'}
                    </div>
                    )}
                    {track && debugMode && (
                        <div style={{ 
                            fontSize: '9px', 
                            color: 'var(--text-secondary)', 
                            fontFamily: 'monospace',
                            opacity: 0.7,
                            marginTop: '1px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                        }}>
                            {track.format}{track.bit_rate ? ` ${track.bit_rate}kbps` : ''}{track.bpm ? ` ${track.bpm}bpm` : ''} • {formatFileSize(track.size_bytes)}
                            {usingMediaFallback && playerMode === 'waveform' && (
                                <span style={{ color: '#fbbf24', display: 'inline-flex', alignItems: 'center', gap: '2px' }} title="Using native audio decoder fallback (Web Audio decode failed)">
                                    <AlertTriangle size={9} /> fallback
                                </span>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Center: Controls + Waveform */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '16px', margin: '0 20px', maxWidth: '800px', opacity: hasTrack ? 1 : 0.5, pointerEvents: hasTrack ? 'auto' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {/* Previous Track */}
                    <button onClick={onPrev} style={playerStyles.iconButton} title="Previous Track">
                        <SkipBack size={20} />
                    </button>

                    {/* Rewind 5s */}
                    <button onClick={() => skip(-5)} style={playerStyles.iconButton} title="Rewind 5s">
                        <RotateCcw size={18} />
                    </button>

                    {/* Play/Pause */}
                    <button 
                        onClick={togglePlayPause}
                        style={{
                            background: 'var(--accent-color)',
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
                            margin: '0 8px'
                        }}
                    >
                        {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" style={{ marginLeft: '2px' }} />}
                    </button>

                    {/* Fast Forward 5s */}
                    <button onClick={() => skip(5)} style={playerStyles.iconButton} title="Forward 5s">
                        <RotateCw size={18} />
                    </button>

                    {/* Next Track */}
                    <button onClick={onNext} style={playerStyles.iconButton} title="Next Track">
                        <SkipForward size={20} />
                    </button>
                </div>

                {/* Elapsed time */}
                <span style={{
                    fontSize: '11px',
                    fontFamily: 'monospace',
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--text-secondary)',
                    minWidth: '38px',
                    textAlign: 'right',
                    flexShrink: 0,
                }}>
                    {formatTime(playbackCurrentTime)}
                </span>

                <div
                    id="waveform"
                    ref={containerRef}
                    style={{
                        flex: 1, 
                        minWidth: 0, // Fix flexbox overflow/sizing
                        height: '40px', 
                        cursor: 'pointer',
                        position: 'relative',
                        // Mask overflow to keep it clean
                        overflow: 'hidden',
                        width: '100%',
                    }} 
                >
                    {/* WaveSurfer renders its canvases here — separate from React children.
                        clip-path rolls the waveform out left-to-right once peaks are decoded
                        (reset instantly, no reverse wipe, when a new track loads). */}
                    <div ref={waveformRef} style={{
                        position: 'absolute',
                        inset: 0,
                        zIndex: 1,
                        clipPath: waveformRevealed ? 'inset(0 0% 0 0)' : 'inset(0 100% 0 0)',
                        transition: waveformRevealed ? 'clip-path 900ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none',
                    }} />
                    {/* Fallback scrub bar for MediaElement-decoded tracks (no waveform data) */}
                    {usingMediaFallback && (
                        <div
                            style={{
                                position: 'absolute',
                                inset: 0,
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'center',
                                zIndex: 2,
                            }}
                        >
                            {/* Progress track */}
                            <div
                                onClick={(e) => {
                                    if (!wavesurferRef.current) return;
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                                    wavesurferRef.current.seekTo(ratio);
                                }}
                                style={{
                                    position: 'relative',
                                    height: '6px',
                                    borderRadius: '3px',
                                    background: 'var(--bg-tertiary, #334155)',
                                    cursor: 'pointer',
                                    overflow: 'hidden',
                                }}
                            >
                                {/* Filled portion */}
                                <div
                                    style={{
                                        position: 'absolute',
                                        left: 0,
                                        top: 0,
                                        bottom: 0,
                                        width: `${playbackProgress * 100}%`,
                                        background: accentColor,
                                        borderRadius: '3px',
                                        transition: 'width 0.1s linear',
                                    }}
                                />
                                {/* Scrub handle */}
                                <div
                                    style={{
                                        position: 'absolute',
                                        top: '50%',
                                        left: `${playbackProgress * 100}%`,
                                        transform: 'translate(-50%, -50%)',
                                        width: '12px',
                                        height: '12px',
                                        borderRadius: '50%',
                                        background: '#f1f5f9',
                                        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                                        pointerEvents: 'none',
                                    }}
                                />
                            </div>
                        </div>
                    )}
                </div>

                {/* Total / remaining time — click to toggle, like most players */}
                <span
                    onClick={() => {
                        const next = !showRemaining;
                        setShowRemaining(next);
                        localStorage.setItem('app_time_display', next ? 'remaining' : 'total');
                    }}
                    title={showRemaining ? 'Show total duration' : 'Show remaining time'}
                    style={{
                        fontSize: '11px',
                        fontFamily: 'monospace',
                        fontVariantNumeric: 'tabular-nums',
                        color: 'var(--text-secondary)',
                        minWidth: '38px',
                        textAlign: 'left',
                        flexShrink: 0,
                        cursor: 'pointer',
                        userSelect: 'none',
                    }}
                >
                    {showRemaining
                        ? `-${formatTime(Math.max(0, playbackDuration - playbackCurrentTime))}`
                        : formatTime(playbackDuration)}
                </span>
            </div>

            {/* Right: Volume/Spacer */}
            <div style={{ width: '200px', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px' }}>
                <button 
                    onClick={toggleMute}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px' }}
                >
                    {isMuted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </button>
                <input 
                    type="range" 
                    min="0" 
                    max="1" 
                    step="0.01" 
                    value={isMuted ? 0 : volume} 
                    onChange={handleVolumeChange}
                    className="volume-slider"
                    style={{ 
                        width: '100px',
                        cursor: 'pointer',
                        background: `linear-gradient(to right, var(--accent-color) ${(isMuted ? 0 : volume) * 100}%, var(--bg-tertiary) ${(isMuted ? 0 : volume) * 100}%)`
                    }} 
                />
            </div>

            {/* Error Toast */}
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
                    textAlign: 'center'
                }}>
                    {error}
                </div>
            )}
        </div>
    );
}
