import { readFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';
import { useEffect, useState, useRef, useCallback } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, Volume2, VolumeX, SkipBack, SkipForward, RotateCcw, RotateCw, Music } from 'lucide-react';

interface Props {
    track: Track | null;
    onNext?: () => void;
    onPrev?: () => void;
    autoPlay?: boolean;
    onTrackError?: () => void;
    accentColor?: string;
    onArtworkClick?: () => void;
}

export function Player({ track, onNext, onPrev, autoPlay = false, onTrackError, accentColor = '#3b82f6', onArtworkClick }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const autoPlayRef = useRef(autoPlay);
    const prevTrackIdRef = useRef<number | null>(null);

    // Keep autoPlay info up to date for event listeners
    useEffect(() => {
        autoPlayRef.current = autoPlay;
    }, [autoPlay]);
    
    const [wavesurfer, setWavesurfer] = useState<WaveSurfer | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentUrl, setCurrentUrl] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [artworkUrl, setArtworkUrl] = useState<string | null>(null);

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
        if (!containerRef.current) return;

        const ws = WaveSurfer.create({
            container: containerRef.current,
            waveColor: '#475569', // slate-600
            progressColor: accentColor,
            cursorColor: '#f1f5f9', // slate-100
            barWidth: 2,
            barGap: 1,
            barRadius: 2,
            height: 40,
            normalize: true,
            // fillParent: true, // Responsiveness issue?
            minPxPerSec: 0, // Fit to container
            interact: true,
        });

        // Event listeners
        ws.on('play', () => setIsPlaying(true));
        ws.on('pause', () => setIsPlaying(false));
        ws.on('finish', () => setIsPlaying(false));
        ws.on('ready', () => {
            console.log("WaveSurfer Ready. Duration:", ws.getDuration());
            if (autoPlayRef.current) {
                ws.play();
            }
        });
        
        // Initial basic error logging
        ws.on('error', (err: any) => {
            console.error("WaveSurfer error:", err);
            setError(`WaveSurfer Error: ${err?.message || err}`);
        });

        setWavesurfer(ws);

        return () => {
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

    // Error Handling Logic
    const handlePlaybackError = useCallback(async (err: any) => {
        if (!track || !wavesurfer) return;
        
        console.log("handlePlaybackError triggered", err);
        
        try {
             if (currentUrl && currentUrl.startsWith('blob:')) {
                 console.error("Blob fallback also failed.");
                 setError(`Playback Error: Could not load audio via Asset or Blob.`);
                 return;
             }
             
             // If the error happens immediately on load, currentUrl should faithfully reflect the failed assetUrl.

             const contents = await readFile(track.file_path);
             const mimeType = track.format === 'mp3' ? 'audio/mpeg' : 
                            track.format === 'm4a' ? 'audio/mp4' : 
                            track.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
                            
             const blob = new Blob([contents], { type: mimeType });
             const blobUrl = URL.createObjectURL(blob);
             
             console.log("Fallback to Blob URL:", blobUrl);
             setCurrentUrl(blobUrl);
             wavesurfer.load(blobUrl);
             
        } catch (fallbackErr) {
            console.error('Fallback failed:', fallbackErr);
            setError(`Playback Error: Could not load audio via Asset or Blob.`);
            invoke('mark_track_missing', { id: track.id, missing: true })
                .then(() => onTrackError?.());
        }
    }, [track, currentUrl, wavesurfer, onTrackError]);

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
            
            const loadAudio = async () => {
                try {
                     try { wavesurfer.stop(); } catch(e) { /* ignore */ }
                    
                    // Try reading file directly to Blob first (most robust for local files in Tauri)
                    // This bypasses potential CORS/Range-request issues with Web Audio API + asset://
                    console.log('Reading file for playback:', track.file_path);
                    const contents = await readFile(track.file_path);
                    const mimeType = track.format === 'mp3' ? 'audio/mpeg' : 
                                   track.format === 'm4a' ? 'audio/mp4' : 
                                   track.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
                    
                    const blob = new Blob([contents], { type: mimeType });
                    const blobUrl = URL.createObjectURL(blob);
                    
                    console.log('Loading Blob URL:', blobUrl);
                    setCurrentUrl(blobUrl);
                    
                    await wavesurfer.load(blobUrl);
                    
                } catch (err) {
                    console.error("Error loading audio file:", err);
                    setError(`Failed to load audio: ${err}`);
                    
                    // If we can't read the file, it's likely missing
                    invoke('mark_track_missing', { id: track.id, missing: true })
                        .then(() => {
                            console.log(`Marked track ${track.id} as missing`);
                            onTrackError?.();
                        })
                        .catch(e => console.error("Failed to mark track missing:", e));
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
        
    }, [track, wavesurfer, autoPlay]);
    
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

    if (!track) return <div style={styles.container}><div style={{ color: 'var(--text-secondary)' }}>Select a track to play</div></div>;

    return (
        <div style={styles.container}>
            {/* Left: Track Info */}
            <div style={{ ...styles.info, display: 'flex', alignItems: 'center' }}>
                {/* Artwork */}
                <div 
                    onClick={onArtworkClick}
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
                        cursor: 'pointer'
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
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {track.title || 'Unknown Title'}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {track.artist || 'Unknown Artist'}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', opacity: 0.5, marginTop: '2px' }}>
                        {track.format} • {track.file_path.split('/').pop()}
                    </div>
                </div>
            </div>

            {/* Center: Controls + Waveform */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '16px', margin: '0 20px', maxWidth: '800px' }}>
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
                        width: '80px',
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
        position: 'relative', // Ensure z-index works
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
