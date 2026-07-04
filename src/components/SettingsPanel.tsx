import { useRef, useEffect, useState } from 'react';
import { X, Check, Loader2, FolderOpen, FolderSync, Bug, AudioWaveform, HardDrive, RefreshCw, ClipboardList, Music, Disc3 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useDebug } from './DebugContext';
import { useToast } from './Toast';

interface SettingsPanelProps {
    isOpen: boolean;
    onClose: () => void;
    currentTheme: string;
    onThemeChange: (theme: string) => void;
    currentAccent: string;
    onAccentChange: (color: string) => void;
    onRefresh: () => void;
    appleMusicAvailable: boolean;
    /** True while a Sync Review preview is being fetched (disables the review button). */
    syncReviewLoading?: boolean;
}

interface SyncInfo {
    date: string;
    count: number;
    type: string;
    duration?: number;
}

interface LogStats {
    log_dir: string;
    total_size_bytes: number;
    file_count: number;
    current_file_size_bytes: number;
}

interface LibraryConfig {
    root_path: string;
    import_mode: 'Copy' | 'Move' | 'InPlace';
    organize_files: boolean;
    sync_mode: 'Off' | 'ImportOnly' | 'TwoWay';
    itunes_deletion_behavior: 'Ask' | 'Keep' | 'Remove';
}

const THEMES = [
    { id: 'dark', name: 'Dark', color: '#0f172a' },
    { id: 'light', name: 'Light', color: '#ffffff' },
    { id: 'rustic', name: 'Rustic', color: '#292524' },
    { id: 'ocean', name: 'Ocean', color: '#0b1120' },
];

const ACCENTS = [
    { id: 'blue', color: '#3b82f6', name: 'Blue' },
    { id: 'emerald', color: '#10b981', name: 'Emerald' },
    { id: 'violet', color: '#8b5cf6', name: 'Violet' },
    { id: 'amber', color: '#f59e0b', name: 'Amber' },
    { id: 'rose', color: '#f43f5e', name: 'Rose' },
];

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function SettingsPanel({
    isOpen,
    onClose,
    currentTheme,
    onThemeChange,
    currentAccent,
    onAccentChange,
    onRefresh,
    appleMusicAvailable,
    syncReviewLoading = false,
}: SettingsPanelProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [syncInfo, setSyncInfo] = useState<SyncInfo | null>(null);
    const [importing, setImporting] = useState(false);
    const [status, setStatus] = useState('');
    const [logStats, setLogStats] = useState<LogStats | null>(null);
    const { debugMode, setDebugMode } = useDebug();
    const [realTimeSyncEnabled, setRealTimeSyncEnabled] = useState(() => {
        return localStorage.getItem('app_real_time_sync_enabled') !== 'false';
    });
    const [playerMode, setPlayerMode] = useState<'standard' | 'waveform'>(() => {
        return (localStorage.getItem('app_player_mode') as 'standard' | 'waveform') || 'standard';
    });
    const [libraryConfig, setLibraryConfig] = useState<LibraryConfig | null>(null);
    const [consolidating, setConsolidating] = useState(false);
    const [showConsolidateConfirm, setShowConsolidateConfirm] = useState(false);
    const [exportingToMusic, setExportingToMusic] = useState(false);
    const [showExportToMusicConfirm, setShowExportToMusicConfirm] = useState(false);
    const [exportingRekordbox, setExportingRekordbox] = useState(false);
    const { showSuccess, showError } = useToast();

    const handleRealTimeSyncToggle = () => {
        const newValue = !realTimeSyncEnabled;
        setRealTimeSyncEnabled(newValue);
        localStorage.setItem('app_real_time_sync_enabled', String(newValue));
        window.dispatchEvent(new Event('real-time-sync-toggled'));
    };

    const updateLibraryConfig = (updates: Partial<LibraryConfig>) => {
        if (!libraryConfig) return;
        const updated = { ...libraryConfig, ...updates };
        invoke('set_library_config', { config: updated }).then(() => {
            setLibraryConfig(updated);
            if (updates.sync_mode && updates.sync_mode !== libraryConfig.sync_mode) {
                window.dispatchEvent(new CustomEvent('sync-mode-changed', { detail: updated.sync_mode }));
            }
        }).catch(console.error);
    };

    const loadSyncInfo = () => {
        const saved = localStorage.getItem('app_last_sync_info');
        if (saved) {
            try {
                setSyncInfo(JSON.parse(saved));
            } catch (e) {
                console.error("Failed to parse sync info", e);
            }
        }
    };

    useEffect(() => {
        if (isOpen) {
             loadSyncInfo();
             invoke<LogStats | null>('get_log_stats').then(setLogStats).catch(console.error);
             invoke<LibraryConfig>('get_library_config').then(setLibraryConfig).catch(console.error);
        }
    }, [isOpen]);

    useEffect(() => {
        window.addEventListener('sync-info-updated', loadSyncInfo);
        return () => window.removeEventListener('sync-info-updated', loadSyncInfo);
    }, []);

    // Close on Escape key
    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [isOpen, onClose]);

    const handleXMLImport = async () => {
        try {
            const selected = await open({
                multiple: false,
                filters: [{
                    name: 'iTunes Library',
                    extensions: ['xml']
                }]
            });

            if (selected && typeof selected === 'string') {
                setImporting(true);
                setStatus('');
                const startTime = performance.now();
                const count = await invoke<number>('import_library', { xmlPath: selected });
                const duration = (performance.now() - startTime) / 1000;
                setStatus(`Imported ${count} tracks!`);
                
                // Store sync info
                const info: SyncInfo = {
                    date: new Date().toISOString(),
                    count: count,
                    type: 'xml',
                    duration
                };
                localStorage.setItem('app_last_sync_info', JSON.stringify(info));
                window.dispatchEvent(new Event('sync-info-updated'));
                setSyncInfo(info);
                
                onRefresh();
            }
        } catch (err: any) {
            console.error(err);
            const msg = `Error: ${err.toString()}`;
            setStatus(msg);
            invoke('log_error', { message: msg }).catch(console.error);
        } finally {
            setImporting(false);
        }
    };

    const handleMusicAppImport = async () => {
        setImporting(true);
        setStatus('');
        try {
            const startTime = performance.now();
            const count = await invoke<number>('import_from_music_app');
            const duration = (performance.now() - startTime) / 1000;
            setStatus(`Synced ${count} tracks!`);
            
            // Store sync info
            const info: SyncInfo = {
                date: new Date().toISOString(),
                count: count,
                type: 'music_app',
                duration
            };
            localStorage.setItem('app_last_sync_info', JSON.stringify(info));
            window.dispatchEvent(new Event('sync-info-updated'));
            setSyncInfo(info);
            
            onRefresh();
        } catch (err: any) {
             console.error(err);
             const msg = `Error: ${err.toString()}`;
             setStatus(msg);
             invoke('log_error', { message: msg }).catch(console.error);
        } finally {
            setImporting(false);
        }
    };

    const handleConsolidate = async () => {
        setShowConsolidateConfirm(false);
        setConsolidating(true);
        try {
            interface ConsolidateResult {
                total_candidates: number;
                consolidated: number;
                failed: number;
                errors: string[];
            }
            const result = await invoke<ConsolidateResult>('consolidate_library');

            if (result.total_candidates === 0) {
                showSuccess('Nothing to consolidate — all files are already in your library folder.');
                return;
            }

            const parts: string[] = [`Consolidated ${result.consolidated} of ${result.total_candidates} tracks`];
            if (result.failed > 0) {
                parts.push(`${result.failed} failed`);
                if (result.errors.length > 0) parts.push(result.errors[0]);
            }

            if (result.failed > 0) {
                showError(parts.join(' — '));
            } else {
                showSuccess(parts.join(' — '));
            }

            if (result.consolidated > 0) {
                onRefresh();
            }
        } catch (err: any) {
            console.error(err);
            showError(`Consolidate failed: ${err}`);
        } finally {
            setConsolidating(false);
        }
    };

    const handleExportToMusic = async () => {
        setShowExportToMusicConfirm(false);
        setExportingToMusic(true);
        try {
            interface MusicExportResult {
                total_candidates: number;
                exported: number;
                relinked: number;
                failed: number;
                errors: string[];
            }
            const result = await invoke<MusicExportResult>('export_tracks_to_music');

            if (result.total_candidates === 0) {
                showSuccess('All tracks are already in Music.app.');
                return;
            }

            let msg = `Added ${result.exported} track${result.exported !== 1 ? 's' : ''} to Music.app`;
            if (result.relinked > 0) {
                msg += `, ${result.relinked} already there were linked`;
            }
            if (result.failed > 0) {
                msg += ` — ${result.failed} failed`;
                if (result.errors.length > 0) msg += `: ${result.errors[0]}`;
            }

            if (result.failed > 0) {
                showError(msg);
            } else {
                showSuccess(msg);
            }

            if (result.exported + result.relinked > 0) {
                onRefresh();
            }
        } catch (err: any) {
            console.error(err);
            showError(`Export to Music.app failed: ${err}`);
        } finally {
            setExportingToMusic(false);
        }
    };

    const handleExportRekordbox = async () => {
        setExportingRekordbox(true);
        try {
            const lastPath = await invoke<string | null>('get_rekordbox_export_path');
            const { save } = await import('@tauri-apps/plugin-dialog');
            const dest = await save({
                defaultPath: lastPath ?? 'rekordbox.xml',
                filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }],
            });
            if (!dest) return;

            interface RekordboxExportReport {
                tracks: number;
                playlists: number;
                folders: number;
                skipped_missing: number;
            }
            const report = await invoke<RekordboxExportReport>('export_rekordbox_xml', { destPath: dest });

            let msg = `Exported ${report.tracks} tracks and ${report.playlists} playlists for Rekordbox`;
            if (report.skipped_missing > 0) {
                msg += `, ${report.skipped_missing} missing skipped`;
            }
            showSuccess(msg);
        } catch (err: any) {
            console.error(err);
            showError(`Rekordbox export failed: ${err}`);
        } finally {
            setExportingRekordbox(false);
        }
    };

    if (!isOpen) return null;

    const isCustomAccent = !ACCENTS.some(a => a.color === currentAccent);

    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000,
                animation: 'overlayFadeIn 0.15s ease-out',
            }}
        >
        <div
            onClick={(e) => e.stopPropagation()}
            style={{
                width: '720px',
                maxHeight: '85vh',
                overflowY: 'auto',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                padding: '28px',
                animation: 'scaleIn 0.15s ease-out',
            }}
            ref={panelRef}
        >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Settings</h3>
                <button 
                    onClick={(e) => { e.stopPropagation(); onClose(); }} 
                    style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}
                >
                    <X size={18} />
                </button>
            </div>

            {/* Two-column grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>

                {/* ===== Left Column ===== */}
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

                    {/* iTunes Sync */}
                    <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                        <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <RefreshCw size={14} /> iTunes Sync
                        </h4>

                        {/* Sync mode — headline control */}
                        <div style={{ marginBottom: '14px' }}>
                            {(['Off', 'ImportOnly', 'TwoWay'] as const).map((mode) => {
                                const labels: Record<string, string> = {
                                    Off: 'Off',
                                    ImportOnly: 'Import only',
                                    TwoWay: 'Two-way',
                                };
                                const descriptions: Record<string, string> = {
                                    Off: 'No connection to iTunes',
                                    ImportOnly: 'Pull changes from iTunes; never write back',
                                    TwoWay: 'Keep TagDeck and iTunes fully in sync',
                                };
                                const disabled = mode !== 'Off' && !appleMusicAvailable;
                                return (
                                    <label key={mode} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
                                        <input
                                            type="radio"
                                            name="sync-mode"
                                            checked={libraryConfig?.sync_mode === mode}
                                            disabled={disabled}
                                            onChange={() => updateLibraryConfig({ sync_mode: mode })}
                                            style={{ accentColor: 'var(--accent-color)', marginTop: '2px' }}
                                        />
                                        <div>
                                            <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{labels[mode]}</div>
                                            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{descriptions[mode]}</div>
                                        </div>
                                    </label>
                                );
                            })}
                            {!appleMusicAvailable && (
                                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                                    Music.app not detected
                                </div>
                            )}
                        </div>

                        {/* Review iTunes Changes — available in every mode, including Off, as an audit tool */}
                        <div style={{ marginBottom: libraryConfig && libraryConfig.sync_mode !== 'Off' ? '14px' : 0 }}>
                            <button
                                onClick={() => window.dispatchEvent(new CustomEvent('open-sync-review'))}
                                disabled={!appleMusicAvailable || syncReviewLoading}
                                className="btn"
                                style={{
                                    fontSize: '13px', padding: '6px 12px',
                                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                    color: 'var(--text-primary)', borderRadius: '6px',
                                    cursor: (!appleMusicAvailable || syncReviewLoading) ? 'not-allowed' : 'pointer',
                                    opacity: !appleMusicAvailable ? 0.5 : 1,
                                    display: 'flex', alignItems: 'center', gap: '6px'
                                }}
                                title={!appleMusicAvailable ? 'Music.app not detected' : 'Preview and approve pending iTunes changes'}
                            >
                                {syncReviewLoading ? <Loader2 size={14} className="spin" /> : <ClipboardList size={14} />}
                                {syncReviewLoading ? 'Loading Preview…' : 'Review iTunes Changes…'}
                            </button>
                        </div>

                        {appleMusicAvailable && (
                            <div style={{ marginBottom: libraryConfig && libraryConfig.sync_mode !== 'Off' ? '14px' : 0 }}>
                                {!showExportToMusicConfirm ? (
                                    <button
                                        onClick={() => setShowExportToMusicConfirm(true)}
                                        disabled={exportingToMusic}
                                        className="btn"
                                        style={{
                                            fontSize: '13px', padding: '6px 12px',
                                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                            color: 'var(--text-primary)', borderRadius: '6px',
                                            cursor: exportingToMusic ? 'not-allowed' : 'pointer',
                                            display: 'flex', alignItems: 'center', gap: '6px'
                                        }}
                                        title="Add every TagDeck-only track's file into your Music.app library"
                                    >
                                        {exportingToMusic ? <Loader2 size={14} className="spin" /> : <Music size={14} />}
                                        {exportingToMusic ? 'Adding…' : 'Add TagDeck-only tracks to Music.app…'}
                                    </button>
                                ) : (
                                    <div style={{
                                        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                        borderRadius: '8px', padding: '12px',
                                    }}>
                                        <p style={{ margin: '0 0 10px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                                            Add every track that isn't linked to Music.app into your Music library? Files stay where they are — Music.app applies its own copy/organize settings. Already-present files are linked instead of duplicated.
                                        </p>
                                        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                                            <button
                                                className="btn"
                                                onClick={() => setShowExportToMusicConfirm(false)}
                                                style={{
                                                    fontSize: '12px', padding: '5px 10px',
                                                    background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
                                                    color: 'var(--text-primary)', borderRadius: '6px', cursor: 'pointer'
                                                }}
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                className="btn btn-primary"
                                                onClick={handleExportToMusic}
                                                style={{
                                                    fontSize: '12px', padding: '5px 10px',
                                                    background: 'var(--accent-hover)', border: '1px solid var(--accent-color)',
                                                    color: 'white', borderRadius: '6px', cursor: 'pointer'
                                                }}
                                            >
                                                Add
                                            </button>
                                        </div>
                                    </div>
                                )}
                                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '6px', fontStyle: 'italic' }}>
                                    Exports your TagDeck-only tracks so your Music library stays complete.
                                </div>
                            </div>
                        )}

                        {libraryConfig && libraryConfig.sync_mode !== 'Off' && (
                            <>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '4px' }}>
                                    <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>Real-Time Sync</span>
                                    <button
                                        onClick={handleRealTimeSyncToggle}
                                        style={{
                                            width: '40px', height: '22px',
                                            background: realTimeSyncEnabled ? 'var(--accent-color)' : 'var(--bg-secondary)',
                                            borderRadius: '11px', position: 'relative',
                                            border: '1px solid var(--border-color)', cursor: 'pointer',
                                            transition: 'background 0.2s', padding: 0
                                        }}
                                    >
                                        <div style={{
                                            width: '18px', height: '18px', background: 'white', borderRadius: '50%',
                                            position: 'absolute', top: '1px',
                                            left: realTimeSyncEnabled ? '19px' : '1px',
                                            transition: 'left 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
                                        }} />
                                    </button>
                                </div>
                                <div style={{ marginTop: '16px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <button
                                        onClick={handleMusicAppImport}
                                        disabled={importing}
                                        className="btn btn-primary"
                                        style={{
                                            fontSize: '13px', padding: '6px 12px',
                                            background: 'var(--accent-hover)', border: '1px solid var(--accent-color)',
                                            color: 'white', borderRadius: '6px',
                                            cursor: importing ? 'not-allowed' : 'pointer',
                                            display: 'flex', alignItems: 'center', gap: '6px'
                                        }}
                                    >
                                        {importing ? <Loader2 size={14} className="spin" /> : null}
                                        {importing ? 'Syncing...' : 'Sync iTunes'}
                                    </button>
                                    <button
                                        onClick={handleXMLImport}
                                        disabled={importing}
                                        className="btn"
                                        style={{
                                            fontSize: '13px', padding: '6px 12px',
                                            background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
                                            color: 'var(--text-primary)', borderRadius: '6px',
                                            cursor: importing ? 'not-allowed' : 'pointer'
                                        }}
                                    >
                                        Import XML
                                    </button>
                                </div>
                                {status && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px' }}>{status}</div>}

                                {/* Deletion behavior */}
                                <div style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--border-color)' }}>
                                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>When a track is removed from iTunes</span>
                                    {(['Ask', 'Keep', 'Remove'] as const).map((behavior) => {
                                        const labels: Record<string, string> = {
                                            Ask: 'Ask me first',
                                            Keep: 'Keep in TagDeck (marked unlinked)',
                                            Remove: 'Also remove from TagDeck',
                                        };
                                        const descriptions: Record<string, string> = {
                                            Ask: 'Show removed tracks in Sync Review so you decide each time',
                                            Keep: 'Track disappears from iTunes but stays in TagDeck',
                                            Remove: 'Track is deleted from TagDeck automatically',
                                        };
                                        return (
                                            <label key={behavior} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px', cursor: 'pointer' }}>
                                                <input
                                                    type="radio"
                                                    name="itunes-deletion-behavior"
                                                    checked={libraryConfig?.itunes_deletion_behavior === behavior}
                                                    onChange={() => updateLibraryConfig({ itunes_deletion_behavior: behavior })}
                                                    style={{ accentColor: 'var(--accent-color)', marginTop: '2px' }}
                                                />
                                                <div>
                                                    <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{labels[behavior]}</div>
                                                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{descriptions[behavior]}</div>
                                                </div>
                                            </label>
                                        );
                                    })}
                                </div>
                            </>
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
                            <button
                                onClick={() => {
                                    const next = playerMode === 'waveform' ? 'standard' : 'waveform';
                                    setPlayerMode(next);
                                    localStorage.setItem('app_player_mode', next);
                                    window.dispatchEvent(new Event('player-mode-changed'));
                                }}
                                style={{
                                    width: '40px', height: '22px',
                                    background: playerMode === 'waveform' ? 'var(--accent-color)' : 'var(--bg-secondary)',
                                    borderRadius: '11px', position: 'relative',
                                    border: '1px solid var(--border-color)', cursor: 'pointer',
                                    transition: 'background 0.2s', padding: 0
                                }}
                            >
                                <div style={{
                                    width: '18px', height: '18px', background: 'white', borderRadius: '50%',
                                    position: 'absolute', top: '1px',
                                    left: playerMode === 'waveform' ? '19px' : '1px',
                                    transition: 'left 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
                                }} />
                            </button>
                        </div>
                    </div>

                    {/* Rekordbox */}
                    <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                        <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <Disc3 size={14} /> Rekordbox
                        </h4>
                        <button
                            onClick={handleExportRekordbox}
                            disabled={exportingRekordbox}
                            className="btn"
                            style={{
                                fontSize: '13px', padding: '6px 12px',
                                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                color: 'var(--text-primary)', borderRadius: '6px',
                                cursor: exportingRekordbox ? 'not-allowed' : 'pointer',
                                display: 'flex', alignItems: 'center', gap: '6px'
                            }}
                            title="Write your collection and playlists to a rekordbox.xml file"
                        >
                            {exportingRekordbox ? <Loader2 size={14} className="spin" /> : <Disc3 size={14} />}
                            {exportingRekordbox ? 'Exporting…' : 'Export to Rekordbox…'}
                        </button>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '6px', fontStyle: 'italic' }}>
                            Writes your collection and playlists to a rekordbox.xml file. In Rekordbox, choose Preferences → Advanced → Database → "rekordbox xml" and select this file — your playlists appear under "rekordbox xml" in the browser. Re-export to the same file to refresh. One-way: changes made in Rekordbox don't come back.
                        </div>
                    </div>

                    {/* Library Management — always visible; some controls are informational-only when Music.app owns imports (Two-way sync) */}
                    <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                        <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <HardDrive size={14} /> Library Management
                        </h4>

                        {appleMusicAvailable && libraryConfig?.sync_mode === 'TwoWay' && (
                            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic', marginBottom: '14px' }}>
                                Imports are currently handled by Music.app under Two-way sync. These settings apply to Consolidate Library and whenever sync is Off or Import-only.
                            </div>
                        )}

                        {/* Library root folder */}
                        <div style={{ marginBottom: '14px' }}>
                            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>Library Location</span>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                <input
                                    type="text"
                                    readOnly
                                    value={libraryConfig?.root_path ?? '~/Music/TagDeck'}
                                    style={{
                                        flex: 1, fontSize: '12px', padding: '6px 8px',
                                        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                        borderRadius: '6px', color: 'var(--text-primary)',
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    }}
                                />
                                <button
                                    onClick={async () => {
                                        const selected = await open({ directory: true, multiple: false, title: 'Choose Library Folder' });
                                        if (selected && typeof selected === 'string' && libraryConfig) {
                                            const updated = { ...libraryConfig, root_path: selected };
                                            invoke('set_library_config', { config: updated }).then(() => setLibraryConfig(updated)).catch(console.error);
                                        }
                                    }}
                                    style={{
                                        fontSize: '12px', padding: '6px 10px',
                                        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                        color: 'var(--text-primary)', borderRadius: '6px', cursor: 'pointer',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    Choose…
                                </button>
                            </div>
                        </div>

                        {/* Import mode */}
                        <div style={{ marginBottom: '14px' }}>
                            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>When importing files</span>
                            {(['Copy', 'Move', 'InPlace'] as const).map((mode) => {
                                const labels: Record<string, string> = {
                                    Copy: 'Copy to library (recommended)',
                                    Move: 'Move to library',
                                    InPlace: 'Keep files in place (advanced)',
                                };
                                return (
                                    <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-primary)', marginBottom: '4px', cursor: 'pointer' }}>
                                        <input
                                            type="radio"
                                            name="import-mode"
                                            checked={libraryConfig?.import_mode === mode}
                                            onChange={() => {
                                                if (!libraryConfig) return;
                                                const updated = { ...libraryConfig, import_mode: mode };
                                                invoke('set_library_config', { config: updated }).then(() => setLibraryConfig(updated)).catch(console.error);
                                            }}
                                            style={{ accentColor: 'var(--accent-color)' }}
                                        />
                                        {labels[mode]}
                                    </label>
                                );
                            })}
                        </div>

                        {/* Organize toggle */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div>
                                <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>Organize by Artist / Album</span>
                                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                                    iTunes-style folder structure
                                </div>
                            </div>
                            <button
                                onClick={() => {
                                    if (!libraryConfig) return;
                                    const updated = { ...libraryConfig, organize_files: !libraryConfig.organize_files };
                                    invoke('set_library_config', { config: updated }).then(() => setLibraryConfig(updated)).catch(console.error);
                                }}
                                style={{
                                    width: '40px', height: '22px',
                                    background: libraryConfig?.organize_files ? 'var(--accent-color)' : 'var(--bg-secondary)',
                                    borderRadius: '11px', position: 'relative',
                                    border: '1px solid var(--border-color)', cursor: 'pointer',
                                    transition: 'background 0.2s', padding: 0
                                }}
                            >
                                <div style={{
                                    width: '18px', height: '18px', background: 'white', borderRadius: '50%',
                                    position: 'absolute', top: '1px',
                                    left: libraryConfig?.organize_files ? '19px' : '1px',
                                    transition: 'left 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
                                }} />
                            </button>
                        </div>

                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '10px', fontStyle: 'italic' }}>
                            Drag audio files onto the window to import them into your library.
                        </div>

                        {/* Consolidate Library */}
                        <div style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--border-color)' }}>
                            {!showConsolidateConfirm ? (
                                <button
                                    onClick={() => setShowConsolidateConfirm(true)}
                                    disabled={consolidating}
                                    className="btn"
                                    style={{
                                        fontSize: '13px', padding: '6px 12px',
                                        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                        color: 'var(--text-primary)', borderRadius: '6px',
                                        cursor: consolidating ? 'not-allowed' : 'pointer',
                                        display: 'flex', alignItems: 'center', gap: '6px'
                                    }}
                                    title="Copy tracks stored outside your library folder into it"
                                >
                                    {consolidating ? <Loader2 size={14} className="spin" /> : <FolderSync size={14} />}
                                    {consolidating ? 'Consolidating…' : 'Consolidate Library…'}
                                </button>
                            ) : (
                                <div style={{
                                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                    borderRadius: '8px', padding: '12px',
                                }}>
                                    <p style={{ margin: '0 0 10px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                                        Copy all tracks stored outside your library folder into it, organized by artist and album? Originals stay where they are. Tracks managed by Music.app are skipped.
                                    </p>
                                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                                        <button
                                            className="btn"
                                            onClick={() => setShowConsolidateConfirm(false)}
                                            style={{
                                                fontSize: '12px', padding: '5px 10px',
                                                background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
                                                color: 'var(--text-primary)', borderRadius: '6px', cursor: 'pointer'
                                            }}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            className="btn btn-primary"
                                            onClick={handleConsolidate}
                                            style={{
                                                fontSize: '12px', padding: '5px 10px',
                                                background: 'var(--accent-hover)', border: '1px solid var(--accent-color)',
                                                color: 'white', borderRadius: '6px', cursor: 'pointer'
                                            }}
                                        >
                                            Consolidate
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                </div>{/* End Left Column */}

                {/* ===== Right Column ===== */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

                    {/* Theme */}
                    <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                        <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600 }}>Theme</h4>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
                            {THEMES.map(theme => (
                                <button
                                    key={theme.id}
                                    onClick={() => onThemeChange(theme.id)}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '10px', padding: '10px',
                                        borderRadius: '8px',
                                        border: `2px solid ${currentTheme === theme.id ? 'var(--accent-color)' : 'transparent'}`,
                                        background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                                        cursor: 'pointer', fontSize: '14px', transition: 'all 0.2s ease'
                                    }}
                                >
                                    <div style={{ width: 18, height: 18, borderRadius: '50%', background: theme.color, border: '1px solid rgba(128,128,128,0.2)' }} />
                                    {theme.name}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Accent Color */}
                    <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                        <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600 }}>Accent Color</h4>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            {ACCENTS.map(accent => (
                                <button
                                    key={accent.id}
                                    onClick={() => onAccentChange(accent.color)}
                                    title={accent.name}
                                    style={{
                                        width: '36px', height: '36px', borderRadius: '50%',
                                        background: accent.color, border: '2px solid var(--bg-secondary)',
                                        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        outline: currentAccent === accent.color ? '2px solid var(--text-primary)' : 'none',
                                        outlineOffset: '2px', transition: 'transform 0.1s'
                                    }}
                                    onMouseDown={e => e.currentTarget.style.transform = 'scale(0.95)'}
                                    onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
                                    onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                                >
                                    {currentAccent === accent.color && <Check size={18} color="white" />}
                                </button>
                            ))}
                            <div style={{ position: 'relative' }} title="Custom Color">
                                <input
                                    type="color"
                                    value={currentAccent}
                                    onChange={(e) => onAccentChange(e.target.value)}
                                    style={{
                                        width: '36px', height: '36px', padding: 0, border: 'none',
                                        borderRadius: '50%', cursor: 'pointer', opacity: 0,
                                        position: 'absolute', top: 0, left: 0, zIndex: 1
                                    }}
                                />
                                <div style={{
                                    width: '36px', height: '36px', borderRadius: '50%',
                                    background: 'conic-gradient(from 180deg, red, yellow, lime, aqua, blue, magenta, red)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    border: '2px solid var(--bg-secondary)',
                                    outline: isCustomAccent ? '2px solid var(--text-primary)' : 'none',
                                    outlineOffset: '2px'
                                }}>
                                    {isCustomAccent && <Check size={18} color="white" style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.5))' }} />}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Developer / Debug */}
                    <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                        <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <Bug size={14} /> Developer
                        </h4>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                            <div>
                                <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>Debug Mode</span>
                                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>Show extra info &amp; verbose logs</div>
                            </div>
                            <button
                                onClick={() => setDebugMode(!debugMode)}
                                style={{
                                    width: '40px', height: '22px',
                                    background: debugMode ? 'var(--accent-color)' : 'var(--bg-secondary)',
                                    borderRadius: '11px', position: 'relative',
                                    border: '1px solid var(--border-color)', cursor: 'pointer',
                                    transition: 'background 0.2s', padding: 0
                                }}
                            >
                                <div style={{
                                    width: '18px', height: '18px', background: 'white', borderRadius: '50%',
                                    position: 'absolute', top: '1px',
                                    left: debugMode ? '19px' : '1px',
                                    transition: 'left 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
                                }} />
                            </button>
                        </div>
                        {logStats && (
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                                    <span>Log files:</span>
                                    <span>{logStats.file_count} ({formatBytes(logStats.total_size_bytes)})</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span>Current log:</span>
                                    <span>{formatBytes(logStats.current_file_size_bytes)}</span>
                                </div>
                            </div>
                        )}
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            <button
                                onClick={() => invoke('open_log_folder').catch(console.error)}
                                style={{
                                    fontSize: '12px', padding: '5px 10px',
                                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                    color: 'var(--text-primary)', borderRadius: '6px', cursor: 'pointer',
                                    display: 'flex', alignItems: 'center', gap: '4px'
                                }}
                            >
                                <FolderOpen size={12} /> Open Log Folder
                            </button>
                            <button
                                onClick={() => invoke('toggle_logs').catch(console.error)}
                                style={{
                                    fontSize: '12px', padding: '5px 10px',
                                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                    color: 'var(--text-primary)', borderRadius: '6px', cursor: 'pointer'
                                }}
                            >
                                Logs Window
                            </button>
                        </div>
                    </div>

                </div>{/* End Right Column */}

            </div>{/* End Two-column grid */}
        </div>
        </div>
    );
}
