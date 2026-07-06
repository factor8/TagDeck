import { useRef, useEffect, useState } from 'react';
import { X, Sliders, RefreshCw, HardDrive, Disc3, Palette, Bug, AudioLines } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { GeneralTab } from './settings/GeneralTab';
import { ITunesTab } from './settings/ITunesTab';
import { LibraryTab } from './settings/LibraryTab';
import { ExportTab } from './settings/ExportTab';
import { AppearanceTab } from './settings/AppearanceTab';
import { DeveloperTab } from './settings/DeveloperTab';
import { SpotifyTab } from './settings/SpotifyTab';

interface SettingsPanelProps {
    isOpen: boolean;
    onClose: () => void;
    currentTheme: string;
    onThemeChange: (theme: string) => void;
    currentAccent: string;
    onAccentChange: (color: string) => void;
    onRefresh: () => void;
    appleMusicAvailable: boolean;
    /** True while a Sync Review preview is being fetched (disables the review button). */
    syncReviewLoading?: boolean;
}

interface SyncInfo {
    date: string;
    count: number;
    type: string;
    duration?: number;
}

interface LibraryConfig {
    root_path: string;
    import_mode: 'Copy' | 'Move' | 'InPlace';
    organize_files: boolean;
    sync_mode: 'Off' | 'ImportOnly' | 'TwoWay';
    itunes_deletion_behavior: 'Ask' | 'Keep' | 'Remove';
}

type TabId = 'general' | 'itunes' | 'spotify' | 'library' | 'export' | 'appearance' | 'developer';

const TABS: { id: TabId; label: string; icon: typeof Sliders }[] = [
    { id: 'general', label: 'General', icon: Sliders },
    { id: 'itunes', label: 'iTunes', icon: RefreshCw },
    { id: 'spotify', label: 'Spotify', icon: AudioLines },
    { id: 'library', label: 'Library', icon: HardDrive },
    { id: 'export', label: 'Export', icon: Disc3 },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'developer', label: 'Developer', icon: Bug },
];

export function SettingsPanel({
    isOpen,
    onClose,
    currentTheme,
    onThemeChange,
    currentAccent,
    onAccentChange,
    onRefresh,
    appleMusicAvailable,
    syncReviewLoading = false,
}: SettingsPanelProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [syncInfo, setSyncInfo] = useState<SyncInfo | null>(null);
    const [libraryConfig, setLibraryConfig] = useState<LibraryConfig | null>(null);
    const [activeTab, setActiveTab] = useState<TabId>(() => {
        return (localStorage.getItem('app_settings_tab') as TabId) || 'general';
    });

    const updateLibraryConfig = (updates: Partial<LibraryConfig>) => {
        if (!libraryConfig) return;
        const updated = { ...libraryConfig, ...updates };
        invoke('set_library_config', { config: updated }).then(() => {
            setLibraryConfig(updated);
            if (updates.sync_mode && updates.sync_mode !== libraryConfig.sync_mode) {
                window.dispatchEvent(new CustomEvent('sync-mode-changed', { detail: updated.sync_mode }));
            }
        }).catch(console.error);
    };

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
             invoke<LibraryConfig>('get_library_config').then(setLibraryConfig).catch(console.error);
        }
    }, [isOpen]);

    useEffect(() => {
        window.addEventListener('sync-info-updated', loadSyncInfo);
        return () => window.removeEventListener('sync-info-updated', loadSyncInfo);
    }, []);

    // Close on Escape key
    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [isOpen, onClose]);

    const selectTab = (tab: TabId) => {
        setActiveTab(tab);
        localStorage.setItem('app_settings_tab', tab);
    };

    if (!isOpen) return null;

    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000,
                animation: 'overlayFadeIn 0.15s ease-out',
            }}
        >
        <div
            onClick={(e) => e.stopPropagation()}
            style={{
                width: '760px',
                height: 'min(560px, 85vh)',
                display: 'flex',
                flexDirection: 'column',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                animation: 'scaleIn 0.15s ease-out',
                overflow: 'hidden',
            }}
            ref={panelRef}
        >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px 16px', flexShrink: 0 }}>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Settings</h3>
                <button
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                    style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}
                >
                    <X size={18} />
                </button>
            </div>

            {/* Nav + Content */}
            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

                {/* Nav rail */}
                <div style={{ width: '170px', flexShrink: 0, borderRight: '1px solid var(--border-color)', padding: '4px 12px 16px', display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto' }}>
                    {TABS.map(tab => {
                        const Icon = tab.icon;
                        const active = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => selectTab(tab.id)}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: '8px',
                                    padding: '8px 10px', borderRadius: '6px',
                                    border: 'none', background: active ? 'var(--bg-tertiary)' : 'transparent',
                                    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                                    fontSize: '13px', cursor: 'pointer', textAlign: 'left', width: '100%',
                                    transition: 'background 0.1s, color 0.1s',
                                }}
                                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                                onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                            >
                                <Icon size={16} />
                                {tab.label}
                            </button>
                        );
                    })}
                </div>

                {/* Content pane */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                    {activeTab === 'general' && (
                        <GeneralTab syncInfo={syncInfo} appleMusicAvailable={appleMusicAvailable} />
                    )}
                    {activeTab === 'itunes' && (
                        <ITunesTab
                            libraryConfig={libraryConfig}
                            updateLibraryConfig={updateLibraryConfig}
                            appleMusicAvailable={appleMusicAvailable}
                            syncReviewLoading={syncReviewLoading}
                            onRefresh={onRefresh}
                        />
                    )}
                    {activeTab === 'spotify' && <SpotifyTab />}
                    {activeTab === 'library' && (
                        <LibraryTab
                            libraryConfig={libraryConfig}
                            updateLibraryConfig={updateLibraryConfig}
                            appleMusicAvailable={appleMusicAvailable}
                            onRefresh={onRefresh}
                        />
                    )}
                    {activeTab === 'export' && <ExportTab />}
                    {activeTab === 'appearance' && (
                        <AppearanceTab
                            currentTheme={currentTheme}
                            onThemeChange={onThemeChange}
                            currentAccent={currentAccent}
                            onAccentChange={onAccentChange}
                        />
                    )}
                    {activeTab === 'developer' && <DeveloperTab />}
                </div>

            </div>
        </div>
        </div>
    );
}
