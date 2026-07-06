import { useEffect, useState } from 'react';
import { AudioLines, Check, FileAudio, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';
import { useToast } from './Toast';

interface PendingMatch { id: number; ghost: Track; local: Track; score: number; }

interface Props { isOpen: boolean; onClose: () => void; onChanged: () => void; }

export function SpotifyMatchReview({ isOpen, onClose, onChanged }: Props) {
    const [matches, setMatches] = useState<PendingMatch[]>([]);
    const { showSuccess, showError } = useToast();

    const load = () => {
        invoke<PendingMatch[]>('spotify_get_pending_matches').then(setMatches).catch(e => showError(String(e)));
    };
    useEffect(() => { if (isOpen) load(); }, [isOpen]);

    // Close on Escape, matching other modals in the app (e.g. SettingsPanel).
    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const act = async (cmd: 'spotify_confirm_match' | 'spotify_reject_match', m: PendingMatch) => {
        try {
            await invoke(cmd, { matchId: m.id });
            if (cmd === 'spotify_confirm_match') {
                showSuccess(`Merged tags into "${m.local.title ?? 'track'}"`);
            }
        } catch (e) {
            showError(String(e));
        } finally {
            // Always refresh — on success this drops the acted-on row; on failure the row is
            // usually stale (already confirmed/rejected elsewhere), so re-fetching drops it
            // too instead of leaving the user stuck retrying a dead row. Also keeps the
            // sidebar badge count accurate for both confirm and reject, not just confirm.
            load();
            onChanged();
        }
    };

    // Round the total first — rounding minutes/seconds separately can carry
    // seconds to 60 (e.g. 239.7 -> "3:60") instead of rolling into the minute.
    const fmtDur = (s: number) => {
        const total = Math.round(s);
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    };

    const cell = (t: Track, icon: React.ReactNode) => (
        <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                {icon}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.artist || '?'} — {t.title || '?'}
                </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t.album || ''} · {fmtDur(t.duration_secs)}</div>
        </div>
    );

    return (
        <>
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 10000 }} onClick={onClose} />
            <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                          width: 620, maxHeight: '70vh', overflowY: 'auto',
                          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                          borderRadius: 10, zIndex: 10001, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                    <h3 style={{ margin: 0 }}>Review Matches</h3>
                    <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}><X size={16} /></button>
                </div>
                {matches.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No matches waiting for review.</p>}
                {matches.map(m => (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
                                             borderBottom: '1px solid var(--border-color)' }}>
                        {cell(m.ghost, <AudioLines size={13} style={{ color: '#1DB954', flexShrink: 0 }} />)}
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}>
                            {(m.score * 100).toFixed(0)}%
                        </span>
                        {cell(m.local, <FileAudio size={13} style={{ flexShrink: 0 }} />)}
                        <button title="Merge tags into this file" onClick={() => act('spotify_confirm_match', m)}><Check size={14} /></button>
                        <button title="Not the same track" onClick={() => act('spotify_reject_match', m)}><X size={14} /></button>
                    </div>
                ))}
            </div>
        </>
    );
}
