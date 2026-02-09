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
    onTrackError?: () => void;
    accentColor?: string;
    onArtworkClick?: () => void;
    onTrackClick?: () => void;
    onPlayStateChange?: (isPlaying: boolean) => void;
}

export function Player({ track, playlistName, onPlaylistClick, onNext, onPrev, autoPlay = false, onTrackError, accentColor = '#3b82f6', onArtworkClick, onTrackClick, onPlayStateChange }: Props) {
    const { debugMode } = useDebug();
    const containerRef = useRef<HTMLDivElement>(null);
    const autoPlayRef = useRef(autoPlay);
    const prevTrackIdRef = useRef<number | null>(null);
    const onPlayStateChangeRef = useRef(onPlayStateChange);
    const onNextRef = useRef(onNext);

    // Keep refs up to date
    useEffect(() => {
        autoPlayRef.current = autoPlay;
        onPlayStateChangeRef.current = onPlayStateChange;
        onNextRef.current = onNext;
    }, [autoPlay, onPlayStateChange, onNext]);

    const [wavesurfer, setWavesurfer] = useState<WaveSurfer | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentUrl, setCurrentUrl] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
    const [usingMediaFallback, setUsingMediaFallback] = useState(false);
    const mediaElementRef = useRef<HTMLAudioElement | null>(null);

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

    // Error Handling Logic — fallback to MediaElement-backed WaveSurfer
    // Web Audio's decodeAudioData() is strict and fails on MP3s with junk/padding
    // between the ID3 tag and the first MPEG frame (common in old iTunes rips,
    // Traktor-tagged files, etc.). The <audio> element uses Core Audio on macOS
    // which is far more tolerant — same decoder iTunes uses.
    const handlePlaybackError = useCallback(async (err: any) => {
        if (!track || !wavesurfer || !containerRef.current) return;
        
        const errStr = String(err?.message || err);
        const isDecodeError = errStr.includes('EncodingError') || 
                              errStr.includes('Decoding failed') ||
                              errStr.includes('Unable to decode');

        const trackLabel = `${track.artist || 'Unknown'} — ${track.title || 'Unknown'} (${track.format}, ${track.file_path})`;

        if (isDecodeError && !usingMediaFallback) {
            // Attempt MediaElement fallback
            const warnMsg = `Web Audio decode failed for ${trackLabel}. Falling back to native audio decoder.`;
            console.warn(warnMsg);
            invoke('log_from_frontend', { level: 'WARN', message: warnMsg }).catch(console.error);

            try {
                const contents = await readFile(track.file_path);
                const mimeType = getMimeType(track.format);
                const blob = new Blob([contents], { type: mimeType });
                const blobUrl = URL.createObjectURL(blob);

                // Create a fresh <audio> element for the MediaElement backend
                const audioEl = new Audio();
                audioEl.src = blobUrl;
                mediaElementRef.current = audioEl;

                // Destroy the old WaveSurfer and create a new one with media backend
                try { wavesurfer.destroy(); } catch (_) { /* ignore */ }

                const ws = WaveSurfer.create({
                    container: containerRef.current!,
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
                    if (autoPlayRef.current) {
                        ws.play().catch(e => console.warn("Auto-play (fallback) failed:", e));
                    }
                });
                ws.on('error', (fallbackErr: any) => {
                    const msg = `Native audio decode also failed for ${trackLabel}: ${fallbackErr}`;
                    console.error(msg);
                    invoke('log_from_frontend', { level: 'ERROR', message: msg }).catch(console.error);
                    setError('Playback Error: This file cannot be decoded.');
                });

                setCurrentUrl(blobUrl);
                setUsingMediaFallback(true);
                setWavesurfer(ws);

                invoke('log_from_frontend', { level: 'INFO', message: `MediaElement fallback loaded successfully for: ${track.title}` }).catch(console.error);

            } catch (fallbackErr) {
                const msg = `MediaElement fallback failed for ${trackLabel}: ${fallbackErr}`;
                console.error(msg);
                invoke('log_from_frontend', { level: 'ERROR', message: msg }).catch(console.error);
                setError('Playback Error: Could not load audio file.');
            }
        } else if (!isDecodeError) {
            // Not a decode error — file may actually be missing / unreadable
            const msg = `Audio load error for ${trackLabel}: ${errStr}`;
            console.error(msg);
            invoke('log_from_frontend', { level: 'ERROR', message: msg }).catch(console.error);
            setError(`Playback Error: ${errStr}`);

            // Only mark missing if we truly can't read the file
            invoke('mark_track_missing', { id: track.id, missing: true })
                .then(() => onTrackError?.())
                .catch(e => console.error("Failed to mark track missing:", e));
        } else {
            // Decode error AND already using fallback — nothing more we can do
            const msg = `All decoders failed for ${trackLabel}: ${errStr}`;
            console.error(msg);
            invoke('log_from_frontend', { level: 'ERROR', message: msg }).catch(console.error);
            setError('Playback Error: This file cannot be decoded.');
        }
    }, [track, currentUrl, wavesurfer, onTrackError, accentColor, usingMediaFallback]);

    // Attach Error Handler with Dependencies
    useEffect(() => {
        if (!wavesurfer) return;

        const errorListener = (err: any) => {
            handlePlaybackError(err);
        };

        wavesurfer.on('error', errorListener);
        
        return () => {
            try {
                wavesurfer.un('error', errorListener);
            } catch (e) {
                console.warn("Failed to unregister error listener:", e);
            }
        };
    }, [wavesurfer, handlePlaybackError]);


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

            // If we were using the MediaElement fallback for the previous track,
            // rebuild a standard (WebAudio) WaveSurfer for the new track.
            if (usingMediaFallback && containerRef.current) {
                setUsingMediaFallback(false);
                if (mediaElementRef.current) {
                    mediaElementRef.current.pause();
                    mediaElementRef.current.src = '';
                    mediaElementRef.current = null;
                }
                try { wavesurfer.destroy(); } catch (_) { /* ignore */ }

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
                ws.on('error', (err: any) => { console.error("WaveSurfer internal error:", err); });
                setWavesurfer(ws);
                // The new WaveSurfer will trigger this effect again on next render
                return;
            }
            
            const loadAudio = async () => {
                const trackLabel = `${track.artist || 'Unknown'} — ${track.title || 'Unknown'}`;
                try {
                     try { wavesurfer.stop(); } catch(e) { /* ignore */ }
                    
                    console.log('Reading file for playback:', track.file_path);
                    const contents = await readFile(track.file_path);
                    const mimeType = getMimeType(track.format);
                    
                    const blob = new Blob([contents], { type: mimeType });
                    const blobUrl = URL.createObjectURL(blob);
                    
                    console.log(`Loading audio: ${trackLabel} (${track.format}, ${formatFileSize(track.size_bytes)})`);
                    setCurrentUrl(blobUrl);
                    
                    await wavesurfer.load(blobUrl);
                    
                } catch (err) {
                    const errStr = String(err);
                    const isDecodeError = errStr.includes('EncodingError') || 
                                          errStr.includes('Decoding failed') ||
                                          errStr.includes('Unable to decode');

                    if (isDecodeError) {
                        // Don't show a scary error toast — the fallback handler will take over
                        const msg = `Web Audio decode failed for ${trackLabel} (${track.format}, path: ${track.file_path}). Attempting native fallback...`;
                        console.warn(msg);
                        invoke('log_from_frontend', { level: 'WARN', message: msg }).catch(console.error);
                        // The WaveSurfer error event will trigger handlePlaybackError
                    } else {
                        const errorMessage = `Failed to load audio: ${errStr}`;
                        console.error(`Error loading ${trackLabel}:`, err);
                        setError(errorMessage);

                        invoke('log_from_frontend', { 
                            level: 'ERROR', 
                            message: `Audio load failed — ${trackLabel} | Format: ${track.format} | Path: ${track.file_path} | Error: ${errStr}` 
                        }).catch(console.error);
                        
                        // Only mark missing for file-not-found type errors
                        invoke('mark_track_missing', { id: track.id, missing: true })
                            .then(() => {
                                console.log(`Marked track ${track.id} as missing`);
                                onTrackError?.();
                            })
                            .catch(e => console.error("Failed to mark track missing:", e));
                    }
                }
            };
    
            loadAudio();
        } else {
             // Exact same track ID. Handle "AutoPlay on existing track" (e.g. double click trigger)
             if (autoPlay) {
                 try {
                    if (wavesurfer.getDuration() > 0 && !wavesurfer.isPlaying()) {
                        wavesurfer.play();
                    }
                 } catch(e) { console.warn("AutoPlay trigger failed", e); }
            }
        }
        
    }, [track, wavesurfer, autoPlay, usingMediaFallback, accentColor]);
    
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
                />
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
