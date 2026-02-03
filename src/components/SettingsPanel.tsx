import { useRef, useEffect, useState } from 'react';
import { X, Check } from 'lucide-react';

interface SettingsPanelProps {
    isOpen: boolean;
    onClose: () => void;
    currentTheme: string;
    onThemeChange: (theme: string) => void;
    currentAccent: string;
    onAccentChange: (color: string) => void;
}

const THEMES = [
    { id: 'dark', name: 'Dark', color: '#0f172a' },
    { id: 'light', name: 'Light', color: '#ffffff' },
    { id: 'rustic', name: 'Rustic', color: '#292524' },
    { id: 'ocean', name: 'Ocean', color: '#0b1120' },
];

const ACCENTS = [
    { id: 'blue', color: '#3b82f6', name: 'Blue' },
    { id: 'emerald', color: '#10b981', name: 'Emerald' },
    { id: 'violet', color: '#8b5cf6', name: 'Violet' },
    { id: 'amber', color: '#f59e0b', name: 'Amber' },
    { id: 'rose', color: '#f43f5e', name: 'Rose' },
];

export function SettingsPanel({ 
    isOpen, 
    onClose, 
    currentTheme, 
    onThemeChange, 
    currentAccent, 
    onAccentChange 
}: SettingsPanelProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [syncInfo, setSyncInfo] = useState<{ date: string; count: number; type: string } | null>(null);

    const loadSyncInfo = () => {
        const saved = localStorage.getItem('app_last_sync_info');
        if (saved) {
            try {
                setSyncInfo(JSON.parse(saved));
            } catch (e) {
                console.error("Failed to parse sync info", e);
            }
        }
    };

    useEffect(() => {
        if (isOpen) {
             loadSyncInfo();
        }
    }, [isOpen]);

    useEffect(() => {
        window.addEventListener('sync-info-updated', loadSyncInfo);
        return () => window.removeEventListener('sync-info-updated', loadSyncInfo);
    }, []);

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
                // Check if the click was on the toggle button (this is tricky without context, simplified for now to just checking panel)
                // A common pattern is to just have the panel be a modal overlay or handle sticky logic.
                // Or user passes a ref to the button to exclude it. 
                // For simplicity here, we assume the parent handles the button click toggling, 
                // but if we click OUTSIDE the panel and it logic says "close", we close.
                onClose();
            }
        }
        if (isOpen) {
            // setTimeout to avoid immediate closing if the click that opened it bubbles here?
            // Usually mousedown on document runs after click.
            document.addEventListener("mousedown", handleClickOutside);
        }
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const isCustomAccent = !ACCENTS.some(a => a.color === currentAccent);

    return (
        <div style={{
            position: 'absolute',
            top: '55px',
            right: '20px',
            width: '320px',
            backgroundColor: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
            padding: '24px',
            zIndex: 1000
        }} ref={panelRef}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Settings</h3>
                <button 
                    onClick={(e) => { e.stopPropagation(); onClose(); }} 
                    style={{ 
                        background: 'none', 
                        border: 'none', 
                        color: 'var(--text-secondary)', 
                        cursor: 'pointer', 
                        padding: 4,
                        display: 'flex',
                        alignItems: 'center'
                    }}
                >
                    <X size={18} />
                </button>
            </div>

            {/* Sync Info Section */}
            <div style={{ marginBottom: '28px', padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600 }}>Library Status</h4>
                {syncInfo ? (
                    <div style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
                        <div style={{ marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>Last Synced:</span>
                            <span>{new Date(syncInfo.date).toLocaleString()}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>Tracks:</span>
                            <span>{syncInfo.count.toLocaleString()}</span>
                        </div>
                    </div>
                ) : (
                    <span style={{ fontSize: '14px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>No sync history found.</span>
                )}
            </div>

            <div style={{ marginBottom: '28px' }}>
                <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>Theme</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
                    {THEMES.map(theme => (
                        <button
                            key={theme.id}
                            onClick={() => onThemeChange(theme.id)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px',
                                padding: '10px',
                                borderRadius: '8px',
                                border: `2px solid ${currentTheme === theme.id ? 'var(--accent-color)' : 'transparent'}`,
                                background: 'var(--bg-tertiary)',
                                color: 'var(--text-primary)',
                                cursor: 'pointer',
                                fontSize: '14px',
                                transition: 'all 0.2s ease'
                            }}
                        >
                            <div style={{ width: 18, height: 18, borderRadius: '50%', background: theme.color, border: '1px solid rgba(128,128,128,0.2)' }} />
                            {theme.name}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>Accent Color</h4>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {ACCENTS.map(accent => (
                        <button
                            key={accent.id}
                            onClick={() => onAccentChange(accent.color)}
                            title={accent.name}
                            style={{
                                width: '36px',
                                height: '36px',
                                borderRadius: '50%',
                                background: accent.color,
                                border: '2px solid var(--bg-secondary)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                outline: currentAccent === accent.color ? '2px solid var(--text-primary)' : 'none',
                                outlineOffset: '2px',
                                transition: 'transform 0.1s'
                            }}
                            onMouseDown={e => e.currentTarget.style.transform = 'scale(0.95)'}
                            onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
                            onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                        >
                            {currentAccent === accent.color && <Check size={18} color="white" />}
                        </button>
                    ))}
                    
                    <div style={{ position: 'relative' }} title="Custom Color">
                        <input
                            type="color"
                            value={currentAccent}
                            onChange={(e) => onAccentChange(e.target.value)}
                            style={{
                                width: '36px',
                                height: '36px',
                                padding: 0,
                                border: 'none',
                                borderRadius: '50%',
                                cursor: 'pointer',
                                opacity: 0,
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                zIndex: 1
                            }}
                        />
                        <div style={{
                            width: '36px',
                            height: '36px',
                            borderRadius: '50%',
                            background: 'conic-gradient(from 180deg, red, yellow, lime, aqua, blue, magenta, red)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            border: '2px solid var(--bg-secondary)',
                            outline: isCustomAccent ? '2px solid var(--text-primary)' : 'none',
                            outlineOffset: '2px'
                        }}>
                             {isCustomAccent && <Check size={18} color="white" style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.5))' }} />}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
