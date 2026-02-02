import { readFile } from '@tauri-apps/plugin-fs';
import { Track } from '../types';
import { useEffect, useState, useRef, useCallback } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, Volume2, VolumeX } from 'lucide-react';

interface Props {
    track: Track | null;
}

export function Player({ track }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [wavesurfer, setWavesurfer] = useState<WaveSurfer | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentUrl, setCurrentUrl] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);

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
            progressColor: '#3b82f6', // blue-500
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
            // ws.play(); 
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
    }, [track]);

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
        }
    }, [track, currentUrl, wavesurfer]);

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
        if (!track || !wavesurfer) {
            if (!track) setCurrentUrl(null);
            return;
        }

        setError(null);
        setIsPlaying(false);

        const loadAudio = async () => {
            try {
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
                
                try {
                     wavesurfer.stop();
                } catch(e) { /* ignore */ }
                
                await wavesurfer.load(blobUrl);
                
            } catch (err) {
                console.error("Error loading audio file:", err);
                setError(`Failed to load audio: ${err}`);
            }
        };

        loadAudio();
        
    }, [track, wavesurfer]);
    
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

    const toggleMute = () => {
        if (wavesurfer) {
            const newMuted = !isMuted;
            setIsMuted(newMuted);
            wavesurfer.setVolume(newMuted ? 0 : 1);
        }
    };

    if (!track) return <div style={styles.container}><div style={{ color: 'var(--text-secondary)' }}>Select a track to play</div></div>;

    return (
        <div style={styles.container}>
            {/* Left: Track Info */}
            <div style={styles.info}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{track.title || 'Unknown Title'}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{track.artist || 'Unknown Artist'}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', opacity: 0.5, marginTop: '4px' }}>
                    {track.format} • {track.file_path.split('/').pop()}
                </div>
            </div>

            {/* Center: Controls + Waveform */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '16px', margin: '0 20px', maxWidth: '800px' }}>
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
                        flexShrink: 0
                    }}
                >
                    {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" style={{ marginLeft: '2px' }} />}
                </button>

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
            <div style={{ width: '200px', display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                <button 
                    onClick={toggleMute}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '8px' }}
                >
                    {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </button>
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
        position: 'fixed' as const,
        bottom: 0,
        left: 0,
        right: '0', 
        height: '80px',
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
    }
};
