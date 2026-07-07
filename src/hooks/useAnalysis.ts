import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Backend `ModelStatus` — serde tags the enum as `{ state: ... }`. */
export type ModelState = 'not_downloaded' | 'ready';

export interface ModelInfo {
    status: { state: ModelState };
    download_bytes: number;
    version: string;
}

export interface AnalysisStatus {
    running: boolean;
    phase: string;
    current: number;
    total: number;
    embedded: number;
    failed: number;
}

/** `analysis-progress` payload — shape varies by phase. */
interface ProgressEvent {
    phase: string;
    // model download
    bytes_done?: number;
    bytes_total?: number;
    // track/tag embedding
    current?: number;
    total?: number;
    embedded?: number;
    failed?: number;
    track_id?: number | null;
}

interface CompleteEvent {
    embedded: number;
    skipped: number;
    failed: number;
    cancelled: boolean;
}

/**
 * Central hook for the analysis subsystem: model download lifecycle, batch
 * analysis progress, cancel, and threshold. Listens to the shared
 * `analysis-progress` / `analysis-complete` events so any consumer stays live.
 */
export function useAnalysis() {
    const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState<{ done: number; total: number } | null>(null);
    const [status, setStatus] = useState<AnalysisStatus | null>(null);
    const [lastComplete, setLastComplete] = useState<CompleteEvent | null>(null);

    const refreshModelStatus = useCallback(async () => {
        try {
            const info = await invoke<ModelInfo>('get_model_status');
            setModelInfo(info);
        } catch (e) {
            console.error('get_model_status failed', e);
        }
    }, []);

    const refreshStatus = useCallback(async () => {
        try {
            setStatus(await invoke<AnalysisStatus>('get_analysis_status'));
        } catch (e) {
            console.error('get_analysis_status failed', e);
        }
    }, []);

    useEffect(() => {
        refreshModelStatus();
        refreshStatus();
    }, [refreshModelStatus, refreshStatus]);

    // Live event wiring. Registered once; stable across re-renders.
    useEffect(() => {
        const unsubs: Array<() => void> = [];
        let active = true;
        (async () => {
            const unProg = await listen<ProgressEvent>('analysis-progress', (e) => {
                const p = e.payload;
                if (p.phase === 'downloading_model') {
                    setDownloadProgress({ done: p.bytes_done ?? 0, total: p.bytes_total ?? 0 });
                } else {
                    setStatus({
                        running: true,
                        phase: p.phase,
                        current: p.current ?? 0,
                        total: p.total ?? 0,
                        embedded: p.embedded ?? 0,
                        failed: p.failed ?? 0,
                    });
                }
            });
            const unDone = await listen<CompleteEvent>('analysis-complete', (e) => {
                setLastComplete(e.payload);
                setStatus((s) => (s ? { ...s, running: false } : s));
            });
            if (active) {
                unsubs.push(unProg, unDone);
            } else {
                unProg();
                unDone();
            }
        })();
        return () => {
            active = false;
            unsubs.forEach((u) => u());
        };
    }, []);

    const downloadModel = useCallback(async () => {
        setDownloading(true);
        setDownloadProgress({ done: 0, total: modelInfo?.download_bytes ?? 0 });
        try {
            await invoke('download_analysis_model');
            await refreshModelStatus();
        } finally {
            setDownloading(false);
            setDownloadProgress(null);
        }
    }, [modelInfo, refreshModelStatus]);

    const removeModel = useCallback(async () => {
        await invoke('remove_analysis_model');
        await refreshModelStatus();
    }, [refreshModelStatus]);

    const analyze = useCallback(async (trackIds?: number[], force = false) => {
        await invoke('analyze_tracks', { trackIds: trackIds ?? null, force });
    }, []);

    const cancel = useCallback(async () => {
        await invoke('cancel_analysis');
    }, []);

    const ready = modelInfo?.status.state === 'ready';
    const running = status?.running ?? false;

    return {
        modelInfo,
        ready,
        refreshModelStatus,
        downloadModel,
        downloading,
        downloadProgress,
        removeModel,
        analyze,
        cancel,
        status,
        running,
        lastComplete,
    };
}
