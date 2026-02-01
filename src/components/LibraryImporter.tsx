import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

interface Props {
    onImportComplete: () => void;
}

export function LibraryImporter({ onImportComplete }: Props) {
    const [importing, setImporting] = useState(false);
    const [status, setStatus] = useState('');

    const handleImport = async () => {
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
                setStatus('Parsing library...');
                
                // Invoke Rust command
                const count = await invoke('import_library', { xmlPath: selected });
                
                setStatus(`Imported ${count} tracks successfully!`);
                onImportComplete();
            }
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
            <button onClick={handleImport} disabled={importing} className="btn btn-primary" style={{ fontSize: '13px', padding: '6px 12px' }}>
                {importing ? 'Importing...' : 'Import XML'}
            </button>
        </div>
    );
}
