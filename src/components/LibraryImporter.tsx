import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Loader2 } from 'lucide-react';

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
                setStatus('');
                const count = await invoke('import_library', { xmlPath: selected });
                setStatus(`Imported ${count} tracks!`);
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
        setStatus('');
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
            <button 
                onClick={handleMusicAppImport} 
                disabled={importing} 
                className="btn btn-primary" 
                style={{ 
                    fontSize: '13px', 
                    padding: '6px 12px', 
                    background: 'var(--accent-hover)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                }}
            >
                {importing ? <Loader2 size={14} className="spin" /> : null}
                {importing ? 'Syncing...' : 'Sync iTunes'}
            </button>
            <button onClick={handleXMLImport} disabled={importing} className="btn" style={{ fontSize: '13px', padding: '6px 12px', background: 'var(--bg-tertiary)' }}>
                Import XML
            </button>
            {status && <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{status}</span>}
        </div>
    );
}
