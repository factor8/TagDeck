import { useEffect, useRef, useState } from 'react';
import { Disc3, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useToast } from '../Toast';
import { formatRekordboxStatus, type RekordboxSyncStatus } from './rekordboxStatus';
import { ToggleSwitch } from './ToggleSwitch';

interface RekordboxLiveConfig {
    enabled: boolean;
    path: string | null;
    debounce_secs: number;
}

const DEFAULT_STATUS: RekordboxSyncStatus = {
    state: 'disabled',
    last_written_at: null,
    last_error: null,
    tracks: 0,
    playlists: 0,
};

async function pickRekordboxXmlPath(): Promise<string | null> {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { audioDir, join } = await import('@tauri-apps/api/path');
    let defaultPath = 'rekordbox.xml';
    try {
        defaultPath = await join(await audioDir(), 'TagDeck', 'rekordbox.xml');
    } catch {
        // Fall back to a bare filename if the Music folder can't be resolved.
    }
    const dest = await save({
        defaultPath,
        filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }],
    });
    return dest ?? null;
}

export function RekordboxLiveSync() {
    const [config, setConfig] = useState<RekordboxLiveConfig | null>(null);
    const [status, setStatus] = useState<RekordboxSyncStatus>(DEFAULT_STATUS);
    const [busy, setBusy] = useState(false);
    // Ticks once a second so the "updated Ns ago" label stays fresh.
    const [, setTick] = useState(0);
    const { showError } = useToast();
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        invoke<RekordboxLiveConfig>('get_rekordbox_live_config')
            .then(c => { if (mountedRef.current) setConfig(c); })
            .catch(e => showError(`Failed to load Rekordbox sync settings: ${e}`));
        invoke<RekordboxSyncStatus>('get_rekordbox_sync_status')
            .then(s => { if (mountedRef.current) setStatus(s); })
            .catch(e => showError(`Failed to load Rekordbox sync status: ${e}`));

        let unlisten: (() => void) | undefined;
        listen<RekordboxSyncStatus>('rekordbox-sync-status', event => {
            if (mountedRef.current) setStatus(event.payload);
        }).then(fn => {
            if (mountedRef.current) unlisten = fn; else fn();
        });

        const interval = setInterval(() => setTick(t => t + 1), 1000);

        return () => {
            mountedRef.current = false;
            clearInterval(interval);
            unlisten?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleToggle = async () => {
        if (!config || busy) return;
        setBusy(true);
        try {
            if (config.enabled) {
                await invoke('set_rekordbox_live_enabled', { enabled: false });
                setConfig({ ...config, enabled: false });
            } else {
                let path = config.path;
                if (!path) {
                    path = await pickRekordboxXmlPath();
                    if (!path) return;
                    await invoke('set_rekordbox_live_path', { path });
                }
                await invoke('set_rekordbox_live_enabled', { enabled: true });
                setConfig({ ...config, enabled: true, path });
            }
        } catch (e) {
            showError(`Failed to update Rekordbox sync: ${e}`);
        } finally {
            setBusy(false);
        }
    };

    const handleChangePath = async () => {
        if (!config || busy) return;
        try {
            const path = await pickRekordboxXmlPath();
            if (!path) return;
            setBusy(true);
            await invoke('set_rekordbox_live_path', { path });
            setConfig({ ...config, path });
        } catch (e) {
            showError(`Failed to update Rekordbox XML path: ${e}`);
        } finally {
            setBusy(false);
        }
    };

    const handleDebounceChange = async (value: number) => {
        if (!config) return;
        const clamped = Math.min(15, Math.max(1, Math.round(value) || 1));
        setConfig({ ...config, debounce_secs: clamped });
        try {
            await invoke('set_rekordbox_debounce_secs', { secs: clamped });
        } catch (e) {
            showError(`Failed to update debounce: ${e}`);
        }
    };

    if (!config) {
        return (
            <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '13px' }}>
                <Loader2 size={14} className="spin" /> Loading Rekordbox sync settings…
            </div>
        );
    }

    return (
        <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px', marginBottom: '12px' }}>
            <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Disc3 size={14} /> Rekordbox Live Sync
            </h4>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div>
                    <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>Keep Rekordbox in sync</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Automatically rewrites the rekordbox.xml file whenever your library changes.
                    </div>
                </div>
                <ToggleSwitch checked={config.enabled} onChange={handleToggle} />
            </div>

            {config.enabled && (
                <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '14px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', minWidth: '36px' }}>File</span>
                        <span style={{
                            flex: 1, fontSize: '12px', color: 'var(--text-primary)', fontFamily: 'monospace',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                            borderRadius: '6px', padding: '5px 8px',
                        }}>
                            {config.path ?? '(no path set)'}
                        </span>
                        <button
                            onClick={handleChangePath}
                            disabled={busy}
                            className="btn"
                            style={{
                                fontSize: '12px', padding: '5px 10px',
                                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                color: 'var(--text-primary)', borderRadius: '6px',
                                cursor: busy ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                            }}
                        >
                            Change…
                        </button>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Update after</span>
                        <input
                            type="number"
                            min={1}
                            max={15}
                            aria-label="Update Rekordbox after N seconds of inactivity"
                            value={config.debounce_secs}
                            onChange={e => handleDebounceChange(Number(e.target.value))}
                            style={{
                                width: '50px', fontSize: '12px', padding: '4px 6px',
                                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                borderRadius: '6px', color: 'var(--text-primary)',
                            }}
                        />
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>seconds of inactivity</span>
                    </div>
                </>
            )}

            <div style={{ fontSize: '12px', color: 'var(--text-primary)', marginTop: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                {status.state === 'writing' && <Loader2 size={12} className="spin" />}
                {formatRekordboxStatus(status, Date.now() / 1000)}
            </div>

            <details style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                <summary style={{ cursor: 'pointer' }}>Rekordbox setup instructions</summary>
                <ol style={{ paddingLeft: '18px', lineHeight: 1.6 }}>
                    <li>In Rekordbox, open Preferences → Advanced → Database.</li>
                    <li>Under "rekordbox xml", check "Use rekordbox xml file for playlists" (or similar) and click Browse to select the file above.</li>
                    <li>In the Rekordbox browser, enable the "rekordbox xml" tree so imported playlists appear.</li>
                    <li>If Rekordbox asks to reload after the file changes, choosing to reload picks up the latest sync.</li>
                </ol>
                <p style={{ lineHeight: 1.6 }}>
                    If Rekordbox says the file "already exists," choosing <strong>Yes</strong> is safe — it only updates
                    the Comment field on each track and never touches your cues or beat grid, and it won't create duplicates.
                </p>
                <p style={{ lineHeight: 1.6, marginBottom: 0 }}>
                    To fully drop iTunes as your library source in Rekordbox, set the iTunes sync setting to Off.
                </p>
            </details>
        </div>
    );
}
