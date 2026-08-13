import { useState } from 'react';
import { Loader2, FolderSync, HardDrive, FileSearch } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import { useToast } from '../Toast';
import { ToggleSwitch } from './ToggleSwitch';
import { PlaylistBackupSection } from './PlaylistBackupSection';
import { summarizeRecheck, recheckFoundSomething, type RecheckReport } from '../../utils/recheckMissing';

interface LibraryConfig {
    root_path: string;
    import_mode: 'Copy' | 'Move' | 'InPlace';
    organize_files: boolean;
    sync_mode: 'Off' | 'ImportOnly' | 'TwoWay';
    itunes_deletion_behavior: 'Ask' | 'Keep' | 'Remove';
}

interface LibraryTabProps {
    libraryConfig: LibraryConfig | null;
    updateLibraryConfig: (updates: Partial<LibraryConfig>) => void;
    appleMusicAvailable: boolean;
    onRefresh: () => void;
}

export function LibraryTab({ libraryConfig, updateLibraryConfig, appleMusicAvailable, onRefresh }: LibraryTabProps) {
    const [consolidating, setConsolidating] = useState(false);
    const [showConsolidateConfirm, setShowConsolidateConfirm] = useState(false);
    const [rechecking, setRechecking] = useState(false);
    const { showSuccess, showError, showToast } = useToast();

    // Library-wide recheck: no ids, so the command looks at every missing track.
    const handleRecheckMissing = async () => {
        setRechecking(true);
        try {
            const report = await invoke<RecheckReport>('recheck_missing_files');
            const msg = summarizeRecheck(report);
            if (recheckFoundSomething(report)) {
                showSuccess(msg);
                onRefresh();
            } else {
                showToast(msg, 'info');
            }
        } catch (err: any) {
            console.error(err);
            showError(`Recheck failed: ${err}`);
        } finally {
            setRechecking(false);
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

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
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
                                updateLibraryConfig({ root_path: selected });
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
                        Move: 'Move to library (deletes originals)',
                        InPlace: 'Keep files in place (advanced)',
                    };
                    const subLabels: Record<string, string> = {
                        Move: 'Originals are moved to the Trash after a verified copy.',
                    };
                    return (
                        <label key={mode} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '13px', color: 'var(--text-primary)', marginBottom: '4px', cursor: 'pointer' }}>
                            <input
                                type="radio"
                                name="import-mode"
                                checked={libraryConfig?.import_mode === mode}
                                onChange={async () => {
                                    if (!libraryConfig) return;
                                    // Confirm before switching TO Move — it's the one mode that removes originals.
                                    if (mode === 'Move' && libraryConfig.import_mode !== 'Move') {
                                        const ok = await confirm(
                                            'New imports will be copied into your library and the original files moved to the Trash (after a verified, byte-for-byte copy). Existing files aren’t touched.',
                                            { title: 'Move originals into the library?', kind: 'warning', okLabel: 'Use Move mode', cancelLabel: 'Cancel' }
                                        );
                                        if (!ok) return;
                                    }
                                    updateLibraryConfig({ import_mode: mode });
                                }}
                                style={{ accentColor: 'var(--accent-color)', marginTop: '2px' }}
                            />
                            <span>
                                {labels[mode]}
                                {subLabels[mode] && (
                                    <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginTop: '1px' }}>
                                        {subLabels[mode]}
                                    </span>
                                )}
                            </span>
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
                <ToggleSwitch
                    checked={!!libraryConfig?.organize_files}
                    onChange={() => {
                        if (!libraryConfig) return;
                        updateLibraryConfig({ organize_files: !libraryConfig.organize_files });
                    }}
                />
            </div>

            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '10px', fontStyle: 'italic' }}>
                Drag audio files onto the window to import them into your library.
            </div>

            {/* Recheck missing files */}
            <div style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--border-color)' }}>
                <button
                    onClick={handleRecheckMissing}
                    disabled={rechecking}
                    className="btn"
                    style={{
                        fontSize: '13px', padding: '6px 12px',
                        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                        color: 'var(--text-primary)', borderRadius: '6px',
                        cursor: rechecking ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', gap: '6px'
                    }}
                    title="Look for every missing file again — at its old location, then wherever Music.app says it lives now"
                >
                    {rechecking ? <Loader2 size={14} className="spin" /> : <FileSearch size={14} />}
                    {rechecking ? 'Rechecking…' : 'Recheck Missing Files'}
                </button>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '8px', fontStyle: 'italic' }}>
                    Clears the missing flag on tracks whose files are back, and follows any that Music.app has moved. Never marks anything missing.
                </div>
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

        <PlaylistBackupSection onRefresh={onRefresh} />
        </div>
    );
}
