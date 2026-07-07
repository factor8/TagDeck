import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Track } from '../types';

/**
 * The manual "play next" queue — an overlay on the tracklist flow.
 * Queued tracks play before the tracklist resumes where it left off.
 * Restored from the DB on launch; every change is persisted fire-and-forget.
 */
export function usePlayQueue() {
    const [queue, setQueue] = useState<Track[]>([]);
    // Guards against persisting the (empty) initial state before the DB load lands.
    const loadedRef = useRef(false);
    // Mirror of `queue` for synchronous reads: popNext/jumpTo must return the
    // popped track immediately, which a setState functional update can't do.
    const queueRef = useRef<Track[]>([]);
    queueRef.current = queue;

    useEffect(() => {
        invoke<Track[]>('get_play_queue')
            .then(q => {
                // If the user queued something before the load resolved, keep
                // their state instead of clobbering it with the persisted
                // snapshot. Copy it so the persist effect (armed below via
                // loadedRef) re-fires and writes the kept mutation to the DB.
                setQueue(prev => (prev.length > 0 ? [...prev] : q));
            })
            .catch(err => console.error('Failed to load play queue:', err))
            .finally(() => {
                loadedRef.current = true;
            });
    }, []);

    useEffect(() => {
        if (!loadedRef.current) return;
        invoke('set_play_queue', { trackIds: queue.map(t => t.id) })
            .catch(err => console.error('Failed to persist play queue:', err));
    }, [queue]);

    /** Insert at the front — plays immediately after the current song. */
    const playNext = useCallback((tracks: Track[]) => {
        setQueue(prev => [...tracks, ...prev]);
    }, []);

    /** Append to the end of the queue. */
    const playLater = useCallback((tracks: Track[]) => {
        setQueue(prev => [...prev, ...tracks]);
    }, []);

    const removeAt = useCallback((index: number) => {
        setQueue(prev => prev.filter((_, i) => i !== index));
    }, []);

    const moveItem = useCallback((from: number, to: number) => {
        setQueue(prev => {
            if (from === to || from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
            const next = [...prev];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
        });
    }, []);

    const clear = useCallback(() => setQueue([]), []);

    /** Removes and returns the front of the queue (undefined when empty). */
    const popNext = useCallback((): Track | undefined => {
        const head = queueRef.current[0];
        if (head) setQueue(prev => prev.slice(1));
        return head;
    }, []);

    /** Play queue[index] now: returns it and drops it plus everything before it. */
    const jumpTo = useCallback((index: number): Track | undefined => {
        const target = queueRef.current[index];
        if (target) setQueue(prev => prev.slice(index + 1));
        return target;
    }, []);

    return { queue, playNext, playLater, removeAt, moveItem, clear, popNext, jumpTo };
}
