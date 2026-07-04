import { useState } from 'react';
import { AudioWaveform } from 'lucide-react';
import { ToggleSwitch } from './ToggleSwitch';

interface SyncInfo {
    date: string;
    count: number;
    type: string;
    duration?: number;
}

interface GeneralTabProps {
    syncInfo: SyncInfo | null;
    appleMusicAvailable: boolean;
}

export function GeneralTab({ syncInfo, appleMusicAvailable }: GeneralTabProps) {
    const [playerMode, setPlayerMode] = useState<'standard' | 'waveform'>(() => {
        return (localStorage.getItem('app_player_mode') as 'standard' | 'waveform') || 'standard';
    });

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Library Status */}
            <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600 }}>Library Status</h4>
                {syncInfo ? (
                    <div style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
                        <div style={{ marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>Last Synced:</span>
                            <span>{new Date(syncInfo.date).toLocaleString()}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>Tracks:</span>
                            <span>{syncInfo.count.toLocaleString()}</span>
                        </div>
                        {syncInfo.duration !== undefined && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>Sync Time:</span>
                                <span>{syncInfo.duration.toFixed(2)}s</span>
                            </div>
                        )}
                    </div>
                ) : (
                    <span style={{ fontSize: '14px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>No sync history found.</span>
                )}

                {!appleMusicAvailable && (
                    <div style={{ marginTop: '12px', fontSize: '13px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                        Apple Music not found — running in standalone mode. Drag audio files onto the window to import them.
                    </div>
                )}
            </div>

            {/* Playback */}
            <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <AudioWaveform size={14} /> Playback
                </h4>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                        <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>Waveform Player</span>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                            {playerMode === 'waveform' ? 'Full waveform — slower to load' : 'Instant playback — simple progress bar'}
                        </div>
                    </div>
                    <ToggleSwitch
                        checked={playerMode === 'waveform'}
                        onChange={() => {
                            const next = playerMode === 'waveform' ? 'standard' : 'waveform';
                            setPlayerMode(next);
                            localStorage.setItem('app_player_mode', next);
                            window.dispatchEvent(new Event('player-mode-changed'));
                        }}
                    />
                </div>
            </div>
        </div>
    );
}
