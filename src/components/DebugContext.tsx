import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface DebugContextType {
    /** Whether debug mode is active */
    debugMode: boolean;
    /** Toggle debug mode on/off — persists to backend + localStorage */
    setDebugMode: (enabled: boolean) => void;
    /** Log a message from the frontend through the backend logging system */
    log: (level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string) => void;
}

const DebugContext = createContext<DebugContextType>({
    debugMode: false,
    setDebugMode: () => {},
    log: () => {},
});

export function DebugProvider({ children }: { children: ReactNode }) {
    const [debugMode, setDebugModeState] = useState<boolean>(() => {
        return localStorage.getItem('app_debug_mode') === 'true';
    });

    // Sync initial state to backend on mount
    useEffect(() => {
        invoke('set_debug_mode', { enabled: debugMode }).catch(console.error);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const setDebugMode = useCallback((enabled: boolean) => {
        setDebugModeState(enabled);
        localStorage.setItem('app_debug_mode', String(enabled));
        invoke('set_debug_mode', { enabled }).catch(console.error);
        window.dispatchEvent(new Event('debug-mode-changed'));
    }, []);

    const log = useCallback((level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string) => {
        invoke('log_from_frontend', { level, message }).catch(console.error);
    }, []);

    return (
        <DebugContext.Provider value={{ debugMode, setDebugMode, log }}>
            {children}
        </DebugContext.Provider>
    );
}

export function useDebug() {
    return useContext(DebugContext);
}
