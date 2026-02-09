import { readFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';
import { useEffect, useState, useRef, useCallback } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, Volume2, VolumeX, SkipBack, SkipForward, RotateCcw, RotateCw, Music, AlertTriangle } from 'lucide-react';
import { useDebug } from './DebugContext';

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

function getMimeType(format: string): string {
    switch (format?.toLowerCase()) {
        case 'mp3': return 'audio/mpeg';
        case 'm4a': case 'aac': return 'audio/mp4';
        case 'wav': return 'audio/wav';
        case 'aiff': case 'aif': return 'audio/aiff';
        case 'flac': return 'audio/flac';
        case 'ogg': return 'audio/ogg';
        default: return 'audio/mpeg';
    }
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
}

export function Player({ track, playlistName, onPlaylistClick, onNext, onPrev, autoPlay = false, playerMode = 'standard', onTrackError, accentColor = '#3b82f6', onArtworkClick, onTrackClick, onPlayStateChange }: Props) {
    const { debugMode } = useDebug();
    const containerRef = useRef<HTMLDivElement>(null);
    const autoPlayRef = useRef(autoPlay);
    const playerModeRef = useRef(playerMode);
    const prevTrackIdRef = useRef<number | null>(null);
    const onPlayStateChangeRef = useRef(onPlayStateChange);
    const onNextRef = useRef(onNext);

    // Keep refs up to date
    useEffect(() => {
        autoPlayRef.current = autoPlay;
        playerModeRef.current = playerMode;
        onPlayStateChangeRef.current = onPlayStateChange;
        onNextRef.current = onNext;
    }, [autoPlay, playerMode, onPlayStateChange, onNext]);

    const [wavesurfer, setWavesurfer] = useState<WaveSurfer | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentUrl, setCurrentUrl] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
    const [usingMediaFallback, setUsingMediaFallback] = useState(false);
    const [fallbackProgress, setFallbackProgress] = useState(0);
    const [fallbackDuration, setFallbackDuration] = useState(0);
    const [fallbackCurrentTime, setFallbackCurrentTime] = useState(0);
    const mediaElementRef = useRef<HTMLAudioElement | null>(null);
    const fallbackInProgressRef = useRef(false);

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

    // Initialize WaveSurfer
    useEffect(() => {
        if (!containerRef.current) {
            console.error("WaveSurfer container ref is null!");
            return;
        }

        console.log("Initializing WaveSurfer instance...");

        let ws: WaveSurfer;
        try {
            ws = WaveSurfer.create({
                container: containerRef.current,
                waveColor: '#475569', // slate-600
                progressColor: accentColor,
                cursorColor: '#f1f5f9', // slate-100
                barWidth: 2,
                barGap: 1,
                barRadius: 2,
                height: 40,
                normalize: true,
                minPxPerSec: 0, // Fit to container
                interact: true,
            });
        } catch (err) {
            console.error("Failed to create WaveSurfer:", err);
            setError(`Init Error: ${err}`);
            return;
        }

        // Event listeners
        ws.on('play', () => {
            setIsPlaying(true);
            if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(true);
        });
        ws.on('pause', () => {
            setIsPlaying(false);
            if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(false);
        });
        ws.on('finish', () => {
            setIsPlaying(false);
            if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(false);
            if (onNextRef.current) onNextRef.current();
        });
        ws.on('ready', () => {
            console.log("WaveSurfer Ready. Duration:", ws.getDuration());
            if (autoPlayRef.current) {
                console.log("Auto-play triggering...");
                ws.play().catch(e => {
                    console.warn("Auto-play validation failed:", e);
                    // Ignore "The user canceled the play request" etc.
                });
            }
        });
        
        // Initial basic error logging
        ws.on('error', (err: any) => {
            console.error("WaveSurfer internal error:", err);
            // Don't show toast for "user aborted" etc if trivial
            // setError(`WaveSurfer Error: ${err?.message || err}`);
        });

        // Add a redraw on resize just in case
        const resizeObserver = new ResizeObserver(() => {
             // ws.drawBuffer(); // v7 handles this? v7 uses internal observer usually.
        });
        resizeObserver.observe(containerRef.current);

        setWavesurfer(ws);

        return () => {
            console.log("Destroying WaveSurfer instance");
            resizeObserver.disconnect();
            try {
                ws.destroy();
            } catch (e) {
                console.warn('Error destroying WaveSurfer instance:', e);
            }
        };
    }, []); // Only on mount

    // Update WaveSurfer colors when accent/theme changes
    useEffect(() => {
        if (wavesurfer) {
            wavesurfer.setOptions({
                progressColor: accentColor
            });
        }
    }, [accentColor, wavesurfer]);

    // Helper: create a standard WaveSurfer with all event listeners
    const createStandardWaveSurfer = useCallback(() => {
        if (!containerRef.current) return null;
        const ws = WaveSurfer.create({
            container: containerRef.current,
            waveColor: '#475569',
            progressColor: accentColor,
            cursorColor: '#f1f5f9',
            barWidth: 2,
            barGap: 1,
            barRadius: 2,
            height: 40,
            normalize: true,
            interact: true,
        });
        ws.on('play', () => { setIsPlaying(true); if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(true); });
        ws.on('pause', () => { setIsPlaying(false); if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(false); });
        ws.on('finish', () => { setIsPlaying(false); if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(false); if (onNextRef.current) onNextRef.current(); });
        ws.on('ready', () => { if (autoPlayRef.current) { ws.play().catch(() => {}); } });
        // Don't set error toast from WaveSurfer's error event — loadAudio handles errors
        ws.on('error', (err: any) => { console.warn('WaveSurfer error event (handled by loadAudio):', err); });
        return ws;
    }, [accentColor]);

    // Helper: create a MediaElement-backed fallback WaveSurfer
    const createFallbackWaveSurfer = useCallback((audioEl: HTMLAudioElement) => {
        if (!containerRef.current) return null;
        const ws = WaveSurfer.create({
            container: containerRef.current,
            waveColor: '#475569',
            progressColor: accentColor,
            cursorColor: '#f1f5f9',
            barWidth: 2,
            barGap: 1,
            barRadius: 2,
            height: 40,
            normalize: true,
            interact: true,
            media: audioEl,
        });
        ws.on('play', () => { setIsPlaying(true); if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(true); });
        ws.on('pause', () => { setIsPlaying(false); if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(false); });
        ws.on('finish', () => { setIsPlaying(false); if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(false); if (onNextRef.current) onNextRef.current(); });
        ws.on('timeupdate', (currentTime: number) => {
            const dur = ws.getDuration();
            setFallbackCurrentTime(currentTime);
            setFallbackDuration(dur);
            setFallbackProgress(dur > 0 ? currentTime / dur : 0);
        });
        // WaveSurfer may still attempt a Web Audio decode for waveform rendering,
        // which will fail (that's why we're in fallback). Suppress — playback
        // goes through the <audio> element and works fine.
        ws.on('error', (fallbackErr: any) => {
            console.warn('Fallback WaveSurfer waveform decode error (expected, playback unaffected):', fallbackErr);
        });

        // Drive playback from the <audio> element directly — WaveSurfer's 'ready'
        // event is unreliable when the waveform decode fails.
        const startPlayback = () => {
            setFallbackDuration(audioEl.duration || 0);
            if (autoPlayRef.current) {
                audioEl.play().catch(e => console.warn('Auto-play (fallback) failed:', e));
            }
        };
        if (audioEl.readyState >= 3) {
            // Already loaded (HAVE_FUTURE_DATA or HAVE_ENOUGH_DATA)
            startPlayback();
        } else {
            audioEl.addEventListener('canplay', startPlayback, { once: true });
        }

        return ws;
    }, [accentColor]);


    // Load audio when track changes
    useEffect(() => {
        if (!wavesurfer) return;

        // If track is null, clear player
        if (!track) {
            setCurrentUrl(null);
            prevTrackIdRef.current = null;
            try { wavesurfer.stop(); } catch (e) { /* ignore */ }
            return;
        }

        // Check if track really changed
        if (track.id !== prevTrackIdRef.current) {
            // Track Changed -> Load New
            prevTrackIdRef.current = track.id;
            
            setError(null);
            setIsPlaying(false);

            const useWaveform = playerModeRef.current === 'waveform';

            // Clean up previous MediaElement state if needed
            const cleanupMediaElement = () => {
                if (mediaElementRef.current) {
                    mediaElementRef.current.pause();
                    mediaElementRef.current.src = '';
                    mediaElementRef.current = null;
                }
                setFallbackProgress(0);
                setFallbackDuration(0);
                setFallbackCurrentTime(0);
                fallbackInProgressRef.current = false;
            };

            // Determine if we need to rebuild WaveSurfer (mode mismatch)
            let activeWs = wavesurfer;
            const needsRebuild = (usingMediaFallback && useWaveform) || (!usingMediaFallback && !useWaveform);

            if (usingMediaFallback || needsRebuild) {
                cleanupMediaElement();
                try { wavesurfer.destroy(); } catch (_) { /* ignore */ }

                if (useWaveform) {
                    // Rebuild standard WebAudio WaveSurfer
                    setUsingMediaFallback(false);
                    const ws = createStandardWaveSurfer();
                    if (!ws) return;
                    activeWs = ws;
                    setWavesurfer(ws);
                } else {
                    // Standard mode: create a placeholder WaveSurfer that will be
                    // replaced by createFallbackWaveSurfer once the audio element is ready.
                    // We'll handle this in loadAudioStandard below.
                    activeWs = null as any; // signal to skip ws.load()
                }
            }
            
            // --- Standard mode: MediaElement path (instant playback) ---
            const loadAudioStandard = async () => {
                const trackLabel = `${track.artist || 'Unknown'} — ${track.title || 'Unknown'}`;
                try {
                    console.log(`[Standard] Reading file: ${track.file_path}`);
                    const contents = await readFile(track.file_path);
                    const mimeType = getMimeType(track.format);
                    const blob = new Blob([contents], { type: mimeType });
                    const blobUrl = URL.createObjectURL(blob);

                    const audioEl = new Audio();
                    audioEl.src = blobUrl;
                    mediaElementRef.current = audioEl;

                    // Destroy whatever WaveSurfer exists (could be stale standard or placeholder)
                    try { wavesurfer.destroy(); } catch (_) { /* ignore */ }

                    const fallbackWs = createFallbackWaveSurfer(audioEl);
                    if (!fallbackWs) {
                        setError('Playback Error: Could not create player.');
                        return;
                    }

                    setCurrentUrl(blobUrl);
                    setUsingMediaFallback(true);
                    setWavesurfer(fallbackWs);

                    console.log(`[Standard] Loaded: ${trackLabel} (${track.format}, ${formatFileSize(track.size_bytes)})`);
                } catch (err) {
                    const errStr = String(err);
                    console.error(`Error loading ${trackLabel}:`, err);
                    setError(`Failed to load audio: ${errStr}`);
                    invoke('log_from_frontend', {
                        level: 'ERROR',
                        message: `Audio load failed — ${trackLabel} | Format: ${track.format} | Path: ${track.file_path} | Error: ${errStr}`
                    }).catch(console.error);

                    invoke('mark_track_missing', { id: track.id, missing: true })
                        .then(() => { onTrackError?.(); })
                        .catch(e => console.error("Failed to mark track missing:", e));
                }
            };

            // --- Waveform mode: full decode path ---
            const loadAudioWaveform = async (ws: WaveSurfer) => {
                const trackLabel = `${track.artist || 'Unknown'} — ${track.title || 'Unknown'}`;
                try {
                     try { ws.stop(); } catch(e) { /* ignore */ }
                    
                    console.log('[Waveform] Reading file:', track.file_path);
                    const contents = await readFile(track.file_path);
                    const mimeType = getMimeType(track.format);
                    
                    const blob = new Blob([contents], { type: mimeType });
                    const blobUrl = URL.createObjectURL(blob);
                    
                    console.log(`[Waveform] Loading audio: ${trackLabel} (${track.format}, ${formatFileSize(track.size_bytes)})`);
                    setCurrentUrl(blobUrl);
                    
                    await ws.load(blobUrl);
                    
                } catch (err) {
                    const errStr = String(err);
                    const isDecodeError = errStr.includes('EncodingError') || 
                                          errStr.includes('Decoding failed') ||
                                          errStr.includes('Unable to decode');

                    if (isDecodeError) {
                        // Fall back to MediaElement (same as standard mode)
                        const msg = `Web Audio decode failed for ${trackLabel} (${track.format}). Switching to native decoder...`;
                        console.warn(msg);
                        invoke('log_from_frontend', { level: 'WARN', message: msg }).catch(console.error);

                        try {
                            const contents = await readFile(track.file_path);
                            const mimeType = getMimeType(track.format);
                            const blob = new Blob([contents], { type: mimeType });
                            const blobUrl = URL.createObjectURL(blob);

                            const audioEl = new Audio();
                            audioEl.src = blobUrl;
                            mediaElementRef.current = audioEl;

                            try { ws.destroy(); } catch (_) { /* ignore */ }

                            const fallbackWs = createFallbackWaveSurfer(audioEl);
                            if (!fallbackWs) {
                                setError('Playback Error: Could not create fallback player.');
                                return;
                            }

                            setCurrentUrl(blobUrl);
                            setUsingMediaFallback(true);
                            setWavesurfer(fallbackWs);

                            invoke('log_from_frontend', { level: 'INFO', message: `MediaElement fallback loaded for: ${track.title}` }).catch(console.error);
                        } catch (fallbackErr) {
                            console.error('MediaElement fallback failed:', fallbackErr);
                            invoke('log_from_frontend', { level: 'ERROR', message: `MediaElement fallback failed for ${trackLabel}: ${fallbackErr}` }).catch(console.error);
                            setError('Playback Error: Could not load audio file.');
                        }
                    } else {
                        const errorMessage = `Failed to load audio: ${errStr}`;
                        console.error(`Error loading ${trackLabel}:`, err);
                        setError(errorMessage);

                        invoke('log_from_frontend', { 
                            level: 'ERROR', 
                            message: `Audio load failed — ${trackLabel} | Format: ${track.format} | Path: ${track.file_path} | Error: ${errStr}` 
                        }).catch(console.error);
                        
                        invoke('mark_track_missing', { id: track.id, missing: true })
                            .then(() => {
                                console.log(`Marked track ${track.id} as missing`);
                                onTrackError?.();
                            })
                            .catch(e => console.error("Failed to mark track missing:", e));
                    }
                }
            };

            // Dispatch based on player mode
            if (useWaveform) {
                loadAudioWaveform(activeWs);
            } else {
                loadAudioStandard();
            }
        } else {
             // Exact same track ID. Handle "AutoPlay on existing track" (e.g. double click trigger)
             if (autoPlay) {
                 try {
                    if (usingMediaFallback && mediaElementRef.current) {
                        if (mediaElementRef.current.paused) {
                            mediaElementRef.current.play().catch(() => {});
                        }
                    } else if (wavesurfer.getDuration() > 0 && !wavesurfer.isPlaying()) {
                        wavesurfer.play();
                    }
                 } catch(e) { console.warn("AutoPlay trigger failed", e); }
            }
        }
        
    }, [track, wavesurfer, autoPlay, usingMediaFallback, accentColor, createStandardWaveSurfer, createFallbackWaveSurfer, onTrackError, playerMode]);
    
    // Revoke Blob URL when currentUrl changes if it was a blob
    useEffect(() => {
        const prevUrl = currentUrl;
        return () => {
             if (prevUrl && prevUrl.startsWith('blob:')) {
                URL.revokeObjectURL(prevUrl);
            }
        };
    }, [currentUrl]);

    // Handle Play/Pause
    const togglePlayPause = () => {
        console.log("Toggle Play/Pause clicked. WaveSurfer instance:", !!wavesurfer);
        if (wavesurfer) {
            try {
                wavesurfer.playPause();
                const isPlayingNow = wavesurfer.isPlaying();
                console.log("WaveSurfer isPlaying:", isPlayingNow);
                setIsPlaying(isPlayingNow);
                if (onPlayStateChangeRef.current) onPlayStateChangeRef.current(isPlayingNow); // Manual sync just in case
            } catch (e) {
                console.error("Error toggling playback:", e);
            }
        } else {
            console.warn("WaveSurfer instance not ready");
        }
    };

    const skip = (seconds: number) => {
        if (wavesurfer) {
            wavesurfer.skip(seconds);
        }
    };

    const toggleMute = () => {
        if (wavesurfer) {
            const newMuted = !isMuted;
            setIsMuted(newMuted);
            wavesurfer.setVolume(newMuted ? 0 : volume);
        }
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseFloat(e.target.value);
        setVolume(newVolume);
        setIsMuted(newVolume === 0);
        if (wavesurfer) {
            wavesurfer.setVolume(newVolume);
        }
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.code === 'Space') {
                const activeTag = document.activeElement?.tagName.toLowerCase();
                const isInput = activeTag === 'input' || activeTag === 'textarea' || (document.activeElement as HTMLElement).isContentEditable;
                
                if (!isInput) {
                    e.preventDefault();
                    togglePlayPause();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [wavesurfer, isMuted, volume]);

    const hasTrack = !!track;

    return (
        <div style={styles.container}>
            {/* Left: Track Info */}
            <div style={{ ...styles.info, display: 'flex', alignItems: 'center', opacity: hasTrack ? 1 : 0.5 }}>
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
                            {usingMediaFallback && (
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
                    <button onClick={onPrev} style={styles.iconButton} title="Previous Track">
                        <SkipBack size={20} />
                    </button>

                    {/* Rewind 5s */}
                    <button onClick={() => skip(-5)} style={styles.iconButton} title="Rewind 5s">
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
                    <button onClick={() => skip(5)} style={styles.iconButton} title="Forward 5s">
                        <RotateCw size={18} />
                    </button>

                    {/* Next Track */}
                    <button onClick={onNext} style={styles.iconButton} title="Next Track">
                        <SkipForward size={20} />
                    </button>
                </div>

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
                                    if (!wavesurfer) return;
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                                    wavesurfer.seekTo(ratio);
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
                                        width: `${fallbackProgress * 100}%`,
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
                                        left: `${fallbackProgress * 100}%`,
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
                            {/* Time labels */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '10px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                                <span>{formatTime(fallbackCurrentTime)}</span>
                                <span>{formatTime(fallbackDuration)}</span>
                            </div>
                        </div>
                    )}
                </div>
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

const styles = {
    container: {
        padding: '0 20px',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        borderTop: '1px solid var(--border-color)',
        // position: 'fixed' removed to allow flex parent to manage layout space
        width: '100%', 
        height: '80px',
        flexShrink: 0,
        position: 'relative' as 'relative', // Ensure z-index works
        display: 'flex',
        flexDirection: 'row' as const,
        alignItems: 'center', // Horizontal layout: Info | Controls
        justifyContent: 'space-between',
        zIndex: 100,
        boxShadow: '0 -4px 20px rgba(0,0,0,0.2)'
    },
    info: {
        fontSize: '14px',
        whiteSpace: 'nowrap' as const,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: '200px',
        maxWidth: '30%',
    },
    iconButton: {
        background: 'transparent',
        border: 'none',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        padding: '8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
    }
};
