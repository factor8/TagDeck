import { useState, useEffect } from 'react';
import { Bug, FolderOpen } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useDebug } from '../DebugContext';
import { ToggleSwitch } from './ToggleSwitch';

interface LogStats {
    log_dir: string;
    total_size_bytes: number;
    file_count: number;
    current_file_size_bytes: number;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function DeveloperTab() {
    const { debugMode, setDebugMode } = useDebug();
    const [logStats, setLogStats] = useState<LogStats | null>(null);

    useEffect(() => {
        invoke<LogStats | null>('get_log_stats').then(setLogStats).catch(console.error);
    }, []);

    return (
        <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
            <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Bug size={14} /> Developer
            </h4>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div>
                    <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>Debug Mode</span>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>Show extra info &amp; verbose logs</div>
                </div>
                <ToggleSwitch checked={debugMode} onChange={() => setDebugMode(!debugMode)} />
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
    );
}
