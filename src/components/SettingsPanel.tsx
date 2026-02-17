import { useRef, useEffect, useState } from 'react';
import { X, Check, Loader2, FolderOpen, Bug, AudioWaveform, HardDriveDownload, HardDriveUpload, CheckSquare, Square, ChevronRight, ChevronDown, Folder, ListMusic } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useDebug } from './DebugContext';

interface SettingsPanelProps {
    isOpen: boolean;
    onClose: () => void;
    currentTheme: string;
    onThemeChange: (theme: string) => void;
    currentAccent: string;
    onAccentChange: (color: string) => void;
    onRefresh: () => void;
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

interface BackupTrackRef {
    persistent_id: string;
    file_path: string;
    title?: string;
    artist?: string;
}

interface BackupEntry {
    persistent_id: string;
    parent_persistent_id?: string;
    name: string;
    is_folder: boolean;
    tracks: BackupTrackRef[];
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
    onRefresh 
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

    // Backup / Restore state
    const [backupStatus, setBackupStatus] = useState('');
    const [backupBusy, setBackupBusy] = useState(false);
    const [restoreEntries, setRestoreEntries] = useState<BackupEntry[] | null>(null);
    const [selectedRestoreIds, setSelectedRestoreIds] = useState<Set<string>>(new Set());
    const [expandedRestoreFolders, setExpandedRestoreFolders] = useState<Set<string>>(new Set());
    const [restoring, setRestoring] = useState(false);

    const handleRealTimeSyncToggle = () => {
        const newValue = !realTimeSyncEnabled;
        setRealTimeSyncEnabled(newValue);
        localStorage.setItem('app_real_time_sync_enabled', String(newValue));
        window.dispatchEvent(new Event('real-time-sync-toggled'));
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

    // ─── Backup Handlers ─────────────────────────────────────────────

    const handleExportBackup = async () => {
        try {
            const path = await save({
                defaultPath: `TagDeck-Playlist-Backup-${new Date().toISOString().slice(0, 10)}.json`,
                filters: [{ name: 'JSON Backup', extensions: ['json'] }],
            });
            if (!path) return;
            setBackupBusy(true);
            setBackupStatus('');
            const count = await invoke<number>('export_playlist_backup', { path });
            setBackupStatus(`Backed up ${count} playlist${count !== 1 ? 's' : ''} successfully.`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setBackupStatus(`Error: ${msg}`);
        } finally {
            setBackupBusy(false);
        }
    };

    const handleOpenRestoreFile = async () => {
        try {
            const selected = await open({
                multiple: false,
                filters: [{ name: 'JSON Backup', extensions: ['json'] }],
            });
            if (!selected || typeof selected !== 'string') return;
            setBackupBusy(true);
            setBackupStatus('');
            const entries = await invoke<BackupEntry[]>('read_playlist_backup', { path: selected });
            setRestoreEntries(entries);
            // Pre-select all
            setSelectedRestoreIds(new Set(entries.map(e => e.persistent_id)));
            setExpandedRestoreFolders(new Set());
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setBackupStatus(`Error: ${msg}`);
        } finally {
            setBackupBusy(false);
        }
    };

    const handleRestoreApply = async () => {
        if (!restoreEntries) return;
        const chosen = restoreEntries.filter(e => selectedRestoreIds.has(e.persistent_id));
        // Also include parent folders of chosen playlists
        const neededPids = new Set(chosen.map(e => e.persistent_id));
        for (const e of chosen) {
            if (e.parent_persistent_id) {
                // Walk up and include any ancestor folders
                let parentPid: string | undefined = e.parent_persistent_id;
                while (parentPid) {
                    neededPids.add(parentPid);
                    const parent = restoreEntries.find(p => p.persistent_id === parentPid);
                    parentPid = parent?.parent_persistent_id ?? undefined;
                }
            }
        }
        const toRestore = restoreEntries.filter(e => neededPids.has(e.persistent_id));

        try {
            setRestoring(true);
            const count = await invoke<number>('restore_playlist_backup', { entries: toRestore });
            setBackupStatus(`Restored ${count} playlist${count !== 1 ? 's' : ''} successfully.`);
            setRestoreEntries(null);
            onRefresh();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setBackupStatus(`Restore error: ${msg}`);
        } finally {
            setRestoring(false);
        }
    };

    const toggleRestoreSelection = (pid: string) => {
        setSelectedRestoreIds(prev => {
            const next = new Set(prev);
            if (next.has(pid)) {
                next.delete(pid);
            } else {
                next.add(pid);
            }
            return next;
        });
    };

    const toggleRestoreFolder = (pid: string) => {
        setExpandedRestoreFolders(prev => {
            const next = new Set(prev);
            if (next.has(pid)) next.delete(pid); else next.add(pid);
            return next;
        });
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
                        
                        <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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

                    {/* Backup & Restore */}
                    <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                        <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <HardDriveDownload size={14} /> Playlist Backup
                        </h4>
                        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: '1.5' }}>
                            Export your playlists and track memberships to a file. Restore them later if anything goes wrong.
                        </p>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            <button
                                onClick={handleExportBackup}
                                disabled={backupBusy}
                                style={{
                                    fontSize: '12px', padding: '6px 12px',
                                    background: 'var(--accent-hover)', border: '1px solid var(--accent-color)',
                                    color: 'white', borderRadius: '6px', cursor: backupBusy ? 'not-allowed' : 'pointer',
                                    display: 'flex', alignItems: 'center', gap: '6px'
                                }}
                            >
                                {backupBusy ? <Loader2 size={13} className="spin" /> : <HardDriveDownload size={13} />}
                                Export Backup
                            </button>
                            <button
                                onClick={handleOpenRestoreFile}
                                disabled={backupBusy}
                                style={{
                                    fontSize: '12px', padding: '6px 12px',
                                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                    color: 'var(--text-primary)', borderRadius: '6px', cursor: backupBusy ? 'not-allowed' : 'pointer',
                                    display: 'flex', alignItems: 'center', gap: '6px'
                                }}
                            >
                                <HardDriveUpload size={13} /> Restore from File
                            </button>
                        </div>
                        {backupStatus && (
                            <div style={{
                                fontSize: '12px', marginTop: '8px',
                                color: backupStatus.startsWith('Error') ? 'var(--error-color)' : 'var(--success-color)',
                            }}>{backupStatus}</div>
                        )}
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

        {/* ===== Restore Picker Modal ===== */}
        {restoreEntries && (
            <div
                onClick={(e) => e.stopPropagation()}
                style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 1100,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'rgba(0, 0, 0, 0.6)',
                    animation: 'overlayFadeIn 0.15s ease-out',
                }}
            >
                <div style={{
                    width: '520px',
                    maxHeight: '70vh',
                    display: 'flex',
                    flexDirection: 'column',
                    backgroundColor: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '12px',
                    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                    animation: 'scaleIn 0.15s ease-out',
                    overflow: 'hidden',
                }}>
                    {/* Header */}
                    <div style={{ padding: '20px 20px 12px', borderBottom: '1px solid var(--border-color)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <HardDriveUpload size={16} /> Restore Playlists
                            </h3>
                            <button
                                onClick={() => setRestoreEntries(null)}
                                style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4, display: 'flex' }}
                            >
                                <X size={16} />
                            </button>
                        </div>
                        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '8px 0 0', lineHeight: '1.4' }}>
                            Choose which playlists to restore. Parent folders will be included automatically.
                        </p>
                        {/* Select all / none */}
                        <div style={{ marginTop: '10px', display: 'flex', gap: '12px', fontSize: '12px' }}>
                            <button
                                onClick={() => setSelectedRestoreIds(new Set(restoreEntries.map(e => e.persistent_id)))}
                                style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', padding: 0, fontSize: 'inherit', textDecoration: 'underline' }}
                            >
                                Select All
                            </button>
                            <button
                                onClick={() => setSelectedRestoreIds(new Set())}
                                style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', padding: 0, fontSize: 'inherit', textDecoration: 'underline' }}
                            >
                                Select None
                            </button>
                            <span style={{ color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                                {selectedRestoreIds.size} of {restoreEntries.length} selected
                            </span>
                        </div>
                    </div>

                    {/* Playlist tree */}
                    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
                        {(() => {
                            // Build tree from flat entries
                            type TreeNode = BackupEntry & { children: TreeNode[] };
                            const nodeMap = new Map<string, TreeNode>();
                            const roots: TreeNode[] = [];
                            for (const e of restoreEntries) {
                                nodeMap.set(e.persistent_id, { ...e, children: [] });
                            }
                            for (const e of restoreEntries) {
                                const node = nodeMap.get(e.persistent_id)!;
                                if (e.parent_persistent_id && nodeMap.has(e.parent_persistent_id)) {
                                    nodeMap.get(e.parent_persistent_id)!.children.push(node);
                                } else {
                                    roots.push(node);
                                }
                            }
                            // Sort: folders first, then alpha
                            const sortTree = (nodes: TreeNode[]) => {
                                nodes.sort((a, b) => {
                                    if (a.is_folder !== b.is_folder) return a.is_folder ? -1 : 1;
                                    return a.name.localeCompare(b.name);
                                });
                                nodes.forEach(n => sortTree(n.children));
                            };
                            sortTree(roots);

                            const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
                                const isSelected = selectedRestoreIds.has(node.persistent_id);
                                const isExpanded = expandedRestoreFolders.has(node.persistent_id);
                                const trackCount = node.is_folder
                                    ? node.children.reduce((sum, c) => sum + (c.is_folder ? 0 : c.tracks.length), 0)
                                    : node.tracks.length;

                                return (
                                    <div key={node.persistent_id}>
                                        <div
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '6px',
                                                padding: `5px 16px 5px ${16 + depth * 20}px`,
                                                fontSize: '13px',
                                                cursor: 'pointer',
                                                color: 'var(--text-primary)',
                                                transition: 'background 0.1s',
                                                userSelect: 'none',
                                            }}
                                            onClick={() => toggleRestoreSelection(node.persistent_id)}
                                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                        >
                                            {/* Expand/collapse for folders */}
                                            {node.is_folder ? (
                                                <div
                                                    onClick={(e) => { e.stopPropagation(); toggleRestoreFolder(node.persistent_id); }}
                                                    style={{ display: 'flex', alignItems: 'center', minWidth: 14, flexShrink: 0 }}
                                                >
                                                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                </div>
                                            ) : (
                                                <div style={{ width: 14, flexShrink: 0 }} />
                                            )}

                                            {/* Checkbox */}
                                            {isSelected
                                                ? <CheckSquare size={15} style={{ color: 'var(--accent-color)', flexShrink: 0 }} />
                                                : <Square size={15} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                                            }

                                            {/* Icon */}
                                            {node.is_folder
                                                ? <Folder size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                                                : <ListMusic size={14} style={{ flexShrink: 0 }} />
                                            }

                                            {/* Name */}
                                            <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                {node.name}
                                            </span>

                                            {/* Track count badge */}
                                            {trackCount > 0 && (
                                                <span style={{
                                                    fontSize: '11px',
                                                    color: 'var(--text-secondary)',
                                                    background: 'var(--bg-primary)',
                                                    padding: '1px 6px',
                                                    borderRadius: '8px',
                                                    flexShrink: 0,
                                                }}>
                                                    {trackCount}
                                                </span>
                                            )}
                                        </div>
                                        {node.is_folder && isExpanded && node.children.map(c => renderNode(c, depth + 1))}
                                    </div>
                                );
                            };

                            return roots.map(r => renderNode(r, 0));
                        })()}
                    </div>

                    {/* Footer */}
                    <div style={{
                        padding: '12px 20px',
                        borderTop: '1px solid var(--border-color)',
                        display: 'flex',
                        justifyContent: 'flex-end',
                        gap: '8px',
                    }}>
                        <button
                            className="btn"
                            onClick={() => setRestoreEntries(null)}
                            style={{ fontSize: '13px', padding: '6px 14px' }}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleRestoreApply}
                            disabled={selectedRestoreIds.size === 0 || restoring}
                            style={{
                                fontSize: '13px', padding: '6px 14px',
                                background: selectedRestoreIds.size === 0 ? 'var(--bg-tertiary)' : 'var(--accent-hover)',
                                border: '1px solid var(--accent-color)',
                                color: 'white', borderRadius: '6px',
                                cursor: selectedRestoreIds.size === 0 || restoring ? 'not-allowed' : 'pointer',
                                display: 'flex', alignItems: 'center', gap: '6px',
                                opacity: selectedRestoreIds.size === 0 ? 0.5 : 1,
                            }}
                        >
                            {restoring ? <Loader2 size={14} className="spin" /> : <HardDriveUpload size={14} />}
                            {restoring ? 'Restoring…' : `Restore ${selectedRestoreIds.size} Playlist${selectedRestoreIds.size !== 1 ? 's' : ''}`}
                        </button>
                    </div>
                </div>
            </div>
        )}

        </div>
    );
}
