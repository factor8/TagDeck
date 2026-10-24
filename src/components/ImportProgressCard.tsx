import { Loader2, Check, AlertTriangle } from 'lucide-react';
import { ImportBatch } from '../hooks/useImportProgress';
import { ProgressBar } from './ProgressBar';

interface Props {
    batches: Map<string, ImportBatch>;
    playlistNames: Map<number, string>;
}

/**
 * Floating card (top-right, under the toolbar) that shows every running file
 * import: "Importing 3 of 29 to «Playlist»", a progress bar, and the file
 * currently being added. Lingers briefly with the final tally once done.
 */
export function ImportProgressCard({ batches, playlistNames }: Props) {
    if (batches.size === 0) return null;
    return (
        <div style={{
            position: 'fixed', top: 52, right: 20, zIndex: 9000,
            display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none',
        }}>
            {Array.from(batches.values()).map(b => {
                const current = b.items.find(i => i.status === 'importing');
                const target = b.playlistId != null ? playlistNames.get(b.playlistId) : null;
                const pct = b.total > 0 ? Math.round((b.done / b.total) * 100) : 0;
                return (
                    <div
                        key={b.batchId}
                        role="status"
                        aria-live="polite"
                        style={{
                            width: 320,
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 8,
                            padding: '10px 14px 12px',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                            color: 'var(--text-primary)',
                            fontSize: 13,
                            pointerEvents: 'auto',
                            animation: 'slideIn 0.3s ease-out',
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {b.finished
                                ? (b.failed > 0
                                    ? <AlertTriangle size={14} style={{ color: 'var(--error-color)', flexShrink: 0 }} />
                                    : <Check size={14} style={{ color: 'var(--success-color)', flexShrink: 0 }} />)
                                : <Loader2 size={14} className="spin" style={{ color: 'var(--accent-color)', flexShrink: 0 }} />}
                            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {b.finished
                                    ? `Imported ${b.imported}${b.skipped ? ` · ${b.skipped} already in library` : ''}${b.failed ? ` · ${b.failed} failed` : ''}`
                                    : `Importing ${Math.min(b.done + 1, b.total)} of ${b.total}${target ? ` to “${target}”` : ''}`}
                            </span>
                        </div>
                        <ProgressBar
                            value={b.finished ? 100 : pct}
                            label={b.finished ? '' : (current?.name ?? 'Preparing…')}
                        />
                    </div>
                );
            })}
        </div>
    );
}
