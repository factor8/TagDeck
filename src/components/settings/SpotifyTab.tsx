import { useEffect, useState } from 'react';
import { Loader2, AudioLines, LogIn, LogOut } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '../Toast';

interface SpotifySettings {
    client_id: string | null;
    connected: boolean;
    account_name: string | null;
}

let connectInFlight = false;

export function SpotifyTab() {
    const [settings, setSettings] = useState<SpotifySettings | null>(null);
    const [clientId, setClientId] = useState('');
    const [busy, setBusy] = useState(connectInFlight);
    const { showSuccess, showError } = useToast();

    const load = () => {
        invoke<SpotifySettings>('spotify_get_settings')
            .then(s => { setSettings(s); setClientId(s.client_id ?? ''); })
            .catch(e => showError(`Failed to load Spotify settings: ${e}`));
    };
    useEffect(load, []);

    const saveClientId = async () => {
        try {
            await invoke('spotify_set_client_id', { clientId });
            showSuccess('Client ID saved');
            load();
        } catch (e) { showError(String(e)); }
    };

    const connect = async () => {
        if (connectInFlight) {
            showError('A Spotify connection attempt is already in progress — check your browser.');
            return;
        }
        connectInFlight = true;
        setBusy(true);
        try {
            if (clientId !== (settings?.client_id ?? '')) {
                await invoke('spotify_set_client_id', { clientId });
            }
            const name = await invoke<string>('spotify_connect');
            showSuccess(`Connected to Spotify as ${name}`);
            load();
        } catch (e) { showError(String(e)); }
        finally { connectInFlight = false; setBusy(false); }
    };

    const disconnect = async () => {
        setBusy(true);
        try {
            await invoke('spotify_disconnect');
            showSuccess('Disconnected from Spotify');
            load();
        } catch (e) { showError(String(e)); }
        finally { setBusy(false); }
    };

    return (
        <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
            <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <AudioLines size={14} /> Spotify Account
            </h4>

            <p style={{ margin: '0 0 14px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                Import Spotify playlists, tag their tracks before you own the files,
                and control playback through the Spotify app. Requires Spotify Premium.
            </p>

            <div style={{ marginBottom: '14px' }}>
                <label htmlFor="spotify-client-id" style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
                    Client ID
                </label>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <input
                        id="spotify-client-id"
                        type="text"
                        value={clientId}
                        onChange={e => setClientId(e.target.value)}
                        placeholder="Spotify app Client ID"
                        spellCheck={false}
                        style={{
                            flex: 1, fontSize: '12px', padding: '6px 8px',
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                            borderRadius: '6px', color: 'var(--text-primary)', fontFamily: 'monospace',
                        }}
                    />
                    <button
                        onClick={saveClientId}
                        disabled={busy}
                        className="btn"
                        style={{
                            fontSize: '13px', padding: '6px 12px',
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                            color: 'var(--text-primary)', borderRadius: '6px',
                            cursor: busy ? 'not-allowed' : 'pointer',
                            whiteSpace: 'nowrap',
                        }}
                        title="Save the Spotify app Client ID"
                    >
                        Save
                    </button>
                </div>
                <details style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    <summary style={{ cursor: 'pointer' }}>How to get a Client ID</summary>
                    <ol style={{ paddingLeft: '18px', lineHeight: 1.6, marginBottom: 0 }}>
                        <li>Go to developer.spotify.com/dashboard and create an app (requires Spotify Premium).</li>
                        <li>Set the Redirect URI to exactly: <code>http://127.0.0.1:43110/callback</code></li>
                        <li>Select "Web API" as the API used, then copy the Client ID here.</li>
                        <li>Development Mode allows the app owner plus up to 4 allowlisted users.</li>
                    </ol>
                </details>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {settings?.connected ? (
                    <>
                        <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                            Connected{settings.account_name ? ` as ${settings.account_name}` : ''}
                        </span>
                        <button
                            onClick={disconnect}
                            disabled={busy}
                            className="btn"
                            style={{
                                fontSize: '13px', padding: '6px 12px',
                                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                color: 'var(--text-primary)', borderRadius: '6px',
                                cursor: busy ? 'not-allowed' : 'pointer',
                                display: 'flex', alignItems: 'center', gap: '6px',
                            }}
                            title="Sign out of Spotify"
                        >
                            {busy ? <Loader2 size={14} className="spin" /> : <LogOut size={14} />}
                            {busy ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                    </>
                ) : (
                    <button
                        onClick={connect}
                        disabled={busy || !clientId.trim()}
                        className="btn"
                        style={{
                            fontSize: '13px', padding: '6px 12px',
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                            color: 'var(--text-primary)', borderRadius: '6px',
                            cursor: (busy || !clientId.trim()) ? 'not-allowed' : 'pointer',
                            opacity: !clientId.trim() ? 0.5 : 1,
                            display: 'flex', alignItems: 'center', gap: '6px',
                        }}
                        title={!clientId.trim() ? 'Enter a Client ID first' : 'Open Spotify authorization in your browser'}
                    >
                        {busy ? <Loader2 size={14} className="spin" /> : <LogIn size={14} />}
                        {busy ? 'Connecting…' : 'Connect to Spotify'}
                    </button>
                )}
            </div>
            {settings?.connected && (
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '6px', fontStyle: 'italic' }}>
                    Disconnecting only removes your Spotify sign-in — imported playlists and tracks stay in your library.
                </div>
            )}
        </div>
    );
}
