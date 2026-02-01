import { convertFileSrc } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { Track } from '../types';
import { useEffect, useState } from 'react';

interface Props {
    track: Track | null;
}

export function Player({ track }: Props) {
    const [audioSrc, setAudioSrc] = useState<string>('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (error) {
            const timer = setTimeout(() => setError(null), 5000);
            return () => clearTimeout(timer);
        }
    }, [error]);

    useEffect(() => {
        setError(null); // Clear error on track change
        if (!track) return;

        const loadAudio = async () => {
            // Priority 1: Use Asset Protocol (Streaming, Efficient)
            // Now that capabilities are fixed, this should work for local files
            const assetUrl = convertFileSrc(track.file_path);
            console.log('Setting Audio Src (Asset):', assetUrl);
            setAudioSrc(assetUrl);
        };

        loadAudio();
        
        // Cleanup blob URLs
        return () => {
            if (audioSrc.startsWith('blob:')) {
                URL.revokeObjectURL(audioSrc);
            }
        };
    }, [track]);

    if (!track) return <div style={styles.container}><div style={{ color: 'var(--text-secondary)' }}>Select a track to play</div></div>;

    return (
        <div style={styles.container}>
            <div style={styles.info}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{track.title || 'Unknown Title'}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{track.artist || 'Unknown Artist'}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', opacity: 0.5, marginTop: '4px' }}>
                    {track.format} • {track.file_path.split('/').pop()}
                </div>
            </div>
            <audio 
                key={track.id} // Force reload on track change
                controls 
                src={audioSrc} 
                onError={(e) => {
                    const audio = e.currentTarget;
                    console.error('Audio Error:', audio.error);
                    console.error('Source:', audio.src);
                    
                    // Fallback to Blob if Asset URL fails (Error 4)
                    if (audio.src && !audio.src.startsWith('blob:')) {
                        console.log('Attempting Blob fallback...');
                        readFile(track.file_path)
                            .then(contents => {
                                const mimeType = track.format === 'mp3' ? 'audio/mpeg' : 
                                               track.format === 'm4a' ? 'audio/mp4' : 
                                               track.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
                                const blob = new Blob([contents], { type: mimeType });
                                const blobUrl = URL.createObjectURL(blob);
                                setAudioSrc(blobUrl);
                            })
                            .catch(err => {
                                console.error('Fallback failed:', err);
                                setError(`Playback Error: ${audio.error?.message || 'Unknown error'} (Code ${audio.error?.code})`);
                            });
                        return;
                    }
                    
                    setError(`Playback Error: ${audio.error?.message || 'Unknown error'} (Code ${audio.error?.code})`);
                }}
                style={{ flex: 1, margin: '0 20px', maxWidth: '600px', height: '40px', filter: 'invert(1) hue-rotate(180deg)' }} 
            />
            {/* Spacer for right side balance or future controls like volume/playlist */}
            <div style={{ width: '200px' }}></div> 

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
