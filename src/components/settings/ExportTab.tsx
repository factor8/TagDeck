import { useState } from 'react';
import { Loader2, Disc3 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '../Toast';

export function ExportTab() {
    const [exportingRekordbox, setExportingRekordbox] = useState(false);
    const { showSuccess, showError } = useToast();

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

    return (
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
    );
}
