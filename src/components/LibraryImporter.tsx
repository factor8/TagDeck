import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

interface Props {
    onImportComplete: () => void;
}

export function LibraryImporter({ onImportComplete }: Props) {
    const [importing, setImporting] = useState(false);
    const [status, setStatus] = useState('');

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
                setStatus('Parsing XML...');
                const count = await invoke('import_library', { xmlPath: selected });
                setStatus(`Imported ${count} tracks from XML!`);
                onImportComplete();
            }
        } catch (err: any) {
            console.error(err);
            setStatus(`Error: ${err.toString()}`);
        } finally {
            setImporting(false);
        }
    };

    const handleMusicAppImport = async () => {
        setImporting(true);
        setStatus('Syncing with Music.app...');
        try {
            const count = await invoke('import_from_music_app');
            setStatus(`Synced ${count} tracks!`);
            onImportComplete();
        } catch (err: any) {
             console.error(err);
             setStatus(`Error: ${err.toString()}`);
        } finally {
            setImporting(false);
        }
    };

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {status && <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{status}</span>}
            <button onClick={handleMusicAppImport} disabled={importing} className="btn btn-primary" style={{ fontSize: '13px', padding: '6px 12px', background: 'var(--accent-hover)' }}>
                {importing ? 'Syncing...' : 'Sync Music.app'}
            </button>
            <button onClick={handleXMLImport} disabled={importing} className="btn" style={{ fontSize: '13px', padding: '6px 12px', background: 'var(--bg-tertiary)' }}>
                Import XML
            </button>
        </div>
    );
}
