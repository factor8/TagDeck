import { convertFileSrc } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { Track } from '../types';
import { useEffect, useState } from 'react';

interface Props {
    track: Track | null;
}

export function Player({ track }: Props) {
    const [audioSrc, setAudioSrc] = useState<string>('');

    useEffect(() => {
        if (!track) return;

        const loadAudio = async () => {
            try {
                // Try reading file directly first to debug permissions
                // This converts the file to a Blob URL, bypassing potential asset:// protocol issues
                const contents = await readFile(track.file_path);
                const blob = new Blob([contents], { type: 'audio/mpeg' }); // Adjust mime type if needed
                const blobUrl = URL.createObjectURL(blob);
                console.log('FS Read Success, using Blob URL');
                setAudioSrc(blobUrl);
            } catch (err) {
                console.error('FS Read Failed:', err);
                // Fallback to asset URL if FS fails (likely permission issue for both)
                const assetUrl = convertFileSrc(track.file_path);
                console.log('Falling back to Asset URL:', assetUrl);
                setAudioSrc(assetUrl);
            }
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
                    alert(`Playback Error: ${audio.error?.message || 'Unknown error'} (Code ${audio.error?.code})\nSrc: ${audio.src}`);
                }}
                style={{ flex: 1, margin: '0 20px', maxWidth: '600px', height: '40px', filter: 'invert(1) hue-rotate(180deg)' }} 
            />
            {/* Spacer for right side balance or future controls like volume/playlist */}
            <div style={{ width: '200px' }}></div> 
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
