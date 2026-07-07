import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sparkles, Loader2, Download, Trash2, Play, Square } from 'lucide-react';
import { useToast } from '../Toast';
import { useAnalysis } from '../../hooks/useAnalysis';

const fmtMB = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

const cardStyle: React.CSSProperties = {
    padding: '16px',
    background: 'var(--bg-tertiary)',
    borderRadius: '8px',
    marginBottom: '14px',
};

const btnStyle: React.CSSProperties = {
    fontSize: '13px',
    padding: '6px 12px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    borderRadius: '6px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    whiteSpace: 'nowrap',
};

export function AnalysisTab() {
    const { showSuccess, showError } = useToast();
    const {
        modelInfo,
        ready,
        downloadModel,
        downloading,
        downloadProgress,
        removeModel,
        analyze,
        cancel,
        status,
        running,
        lastComplete,
        refreshModelStatus,
    } = useAnalysis();

    const [threshold, setThreshold] = useState<number>(0.5);
    const [busy, setBusy] = useState(false);
    const [force, setForce] = useState(false);

    useEffect(() => {
        invoke<number>('get_suggestion_threshold').then(setThreshold).catch(console.error);
    }, []);

    // Surface completion toasts.
    useEffect(() => {
        if (!lastComplete) return;
        if (lastComplete.cancelled) {
            showSuccess(`Analysis stopped — ${lastComplete.embedded} embedded`);
        } else {
            const failMsg = lastComplete.failed > 0 ? `, ${lastComplete.failed} failed` : '';
            showSuccess(`Analysis complete — ${lastComplete.embedded} embedded${failMsg}`);
        }
        refreshModelStatus();
    }, [lastComplete]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleDownload = async () => {
        try {
            await downloadModel();
            showSuccess('AI model installed');
        } catch (e) {
            showError(`Download failed: ${e}`);
        }
    };

    const handleRemove = async () => {
        try {
            await removeModel();
            showSuccess('Model removed — your analyzed tags are kept');
        } catch (e) {
            showError(`${e}`);
        }
    };

    const handleAnalyze = async () => {
        setBusy(true);
        try {
            await analyze(undefined, force);
            showSuccess('Analyzing your library…');
        } catch (e) {
            showError(`${e}`);
        } finally {
            setBusy(false);
        }
    };

    const commitThreshold = async (v: number) => {
        setThreshold(v);
        try {
            await invoke('set_suggestion_threshold', { threshold: v });
        } catch (e) {
            console.error('set_suggestion_threshold failed', e);
        }
    };

    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

    return (
        <div>
            <div style={cardStyle}>
                <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Sparkles size={14} /> AI Tag Suggestions
                </h4>

                <p style={{ margin: '0 0 14px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    Analyze the audio of your tracks locally and suggest tags from your own vocabulary.
                    Suggestions appear as dashed chips in the tag editor — click to accept.
                    Everything runs on your Mac; nothing is uploaded.
                </p>

                {!ready ? (
                    <>
                        <button
                            onClick={handleDownload}
                            disabled={downloading}
                            className="btn"
                            style={{ ...btnStyle, cursor: downloading ? 'not-allowed' : 'pointer' }}
                            title="Download the analysis model (one-time)"
                        >
                            {downloading ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                            {downloading
                                ? 'Downloading…'
                                : `Enable AI suggestions (${modelInfo ? fmtMB(modelInfo.download_bytes) : '~160 MB'} download)`}
                        </button>
                        {downloading && downloadProgress && (
                            <ProgressBar
                                value={pct(downloadProgress.done, downloadProgress.total)}
                                label={`${fmtMB(downloadProgress.done)} / ${fmtMB(downloadProgress.total)}`}
                            />
                        )}
                        <p style={{ margin: '12px 0 0', fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                            One-time download. The app works exactly as before without it.
                        </p>
                    </>
                ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                            Model installed{modelInfo ? ` (${fmtMB(modelInfo.download_bytes)})` : ''}
                        </span>
                        <button
                            onClick={handleRemove}
                            disabled={running}
                            className="btn"
                            style={{ ...btnStyle, cursor: running ? 'not-allowed' : 'pointer' }}
                            title="Delete the model to free disk. Your analyzed tags stay."
                        >
                            <Trash2 size={14} /> Remove model
                        </button>
                    </div>
                )}
            </div>

            {ready && (
                <>
                    <div style={cardStyle}>
                        <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600 }}>
                            Analyze Library
                        </h4>
                        <p style={{ margin: '0 0 14px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                            Embeds every local track once so suggestions are instant. You can keep
                            working while it runs; it resumes where it left off if interrupted.
                        </p>

                        {running ? (
                            <>
                                <ProgressBar
                                    value={pct(status?.current ?? 0, status?.total ?? 0)}
                                    label={
                                        status?.phase === 'embedding_tags'
                                            ? `Preparing tags… ${status?.current}/${status?.total}`
                                            : `${status?.current ?? 0} / ${status?.total ?? 0} tracks · ${status?.failed ?? 0} failed`
                                    }
                                />
                                <button
                                    onClick={() => cancel().catch(console.error)}
                                    className="btn"
                                    style={{ ...btnStyle, marginTop: '10px' }}
                                    title="Stop analysis (progress is saved)"
                                >
                                    <Square size={13} /> Stop
                                </button>
                            </>
                        ) : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                                <button
                                    onClick={handleAnalyze}
                                    disabled={busy}
                                    className="btn"
                                    style={{ ...btnStyle, cursor: busy ? 'not-allowed' : 'pointer' }}
                                >
                                    {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                                    Analyze library
                                </button>
                                <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                                    <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                                    Re-analyze already-embedded tracks
                                </label>
                            </div>
                        )}
                    </div>

                    <div style={cardStyle}>
                        <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600 }}>
                            Suggestion Sensitivity
                        </h4>
                        <p style={{ margin: '0 0 14px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                            Higher shows only confident suggestions; lower shows more, including looser matches.
                        </p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.05}
                                value={threshold}
                                onChange={(e) => setThreshold(parseFloat(e.target.value))}
                                onMouseUp={(e) => commitThreshold(parseFloat((e.target as HTMLInputElement).value))}
                                style={{ flex: 1, accentColor: 'var(--accent-color)' }}
                            />
                            <span style={{ fontSize: '12px', color: 'var(--text-primary)', fontFamily: 'monospace', minWidth: '32px', textAlign: 'right' }}>
                                {threshold.toFixed(2)}
                            </span>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

function ProgressBar({ value, label }: { value: number; label: string }) {
    return (
        <div style={{ marginTop: '12px' }}>
            <div style={{ height: '6px', background: 'var(--bg-secondary)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ width: `${value}%`, height: '100%', background: 'var(--accent-color)', transition: 'width 0.2s' }} />
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '5px' }}>{label}</div>
        </div>
    );
}
