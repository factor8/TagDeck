import { Check } from 'lucide-react';

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

interface AppearanceTabProps {
    currentTheme: string;
    onThemeChange: (theme: string) => void;
    currentAccent: string;
    onAccentChange: (color: string) => void;
}

export function AppearanceTab({ currentTheme, onThemeChange, currentAccent, onAccentChange }: AppearanceTabProps) {
    const isCustomAccent = !ACCENTS.some(a => a.color === currentAccent);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Theme */}
            <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600 }}>Theme</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
                    {THEMES.map(theme => (
                        <button
                            key={theme.id}
                            onClick={() => onThemeChange(theme.id)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '10px', padding: '10px',
                                borderRadius: '8px',
                                border: `2px solid ${currentTheme === theme.id ? 'var(--accent-color)' : 'transparent'}`,
                                background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                                cursor: 'pointer', fontSize: '14px', transition: 'all 0.2s ease'
                            }}
                        >
                            <div style={{ width: 18, height: 18, borderRadius: '50%', background: theme.color, border: '1px solid rgba(128,128,128,0.2)' }} />
                            {theme.name}
                        </button>
                    ))}
                </div>
            </div>

            {/* Accent Color */}
            <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginTop: 0, color: 'var(--text-secondary)', fontWeight: 600 }}>Accent Color</h4>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {ACCENTS.map(accent => (
                        <button
                            key={accent.id}
                            onClick={() => onAccentChange(accent.color)}
                            title={accent.name}
                            style={{
                                width: '36px', height: '36px', borderRadius: '50%',
                                background: accent.color, border: '2px solid var(--bg-secondary)',
                                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                outline: currentAccent === accent.color ? '2px solid var(--text-primary)' : 'none',
                                outlineOffset: '2px', transition: 'transform 0.1s'
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
                                width: '36px', height: '36px', padding: 0, border: 'none',
                                borderRadius: '50%', cursor: 'pointer', opacity: 0,
                                position: 'absolute', top: 0, left: 0, zIndex: 1
                            }}
                        />
                        <div style={{
                            width: '36px', height: '36px', borderRadius: '50%',
                            background: 'conic-gradient(from 180deg, red, yellow, lime, aqua, blue, magenta, red)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
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
