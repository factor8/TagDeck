import { useState } from 'react';
import { Loader2, ClipboardList, Music, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useToast } from '../Toast';
import { ToggleSwitch } from './ToggleSwitch';

interface LibraryConfig {
    root_path: string;
    import_mode: 'Copy' | 'Move' | 'InPlace';
    organize_files: boolean;
    sync_mode: 'Off' | 'ImportOnly' | 'TwoWay';
    itunes_deletion_behavior: 'Ask' | 'Keep' | 'Remove';
}

interface SyncInfo {
    date: string;
    count: number;
    type: string;
    duration?: number;
}

interface ITunesTabProps {
    libraryConfig: LibraryConfig | null;
    updateLibraryConfig: (updates: Partial<LibraryConfig>) => void;
    appleMusicAvailable: boolean;
    syncReviewLoading: boolean;
    onRefresh: () => void;
}

export function ITunesTab({ libraryConfig, updateLibraryConfig, appleMusicAvailable, syncReviewLoading, onRefresh }: ITunesTabProps) {
    const [importing, setImporting] = useState(false);
    const [status, setStatus] = useState('');
    const [realTimeSyncEnabled, setRealTimeSyncEnabled] = useState(() => {
        return localStorage.getItem('app_real_time_sync_enabled') !== 'false';
    });
    const [exportingToMusic, setExportingToMusic] = useState(false);
    const [showExportToMusicConfirm, setShowExportToMusicConfirm] = useState(false);
    const { showSuccess, showError } = useToast();

    const handleRealTimeSyncToggle = () => {
        const newValue = !realTimeSyncEnabled;
        setRealTimeSyncEnabled(newValue);
        localStorage.setItem('app_real_time_sync_enabled', String(newValue));
        window.dispatchEvent(new Event('real-time-sync-toggled'));
    };

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

    return (
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
                        <ToggleSwitch checked={realTimeSyncEnabled} onChange={handleRealTimeSyncToggle} />
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
    );
}
