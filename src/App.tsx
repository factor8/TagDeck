import { useState, useRef, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DndContext, DragEndEvent, DragStartEvent, DragOverlay, useSensor, useSensors, PointerSensor, closestCenter } from '@dnd-kit/core';
import './App.css';
import './Panel.css';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, PanelImperativeHandle } from "react-resizable-panels";
import { Search, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Settings, X, Info } from 'lucide-react';
import { SettingsPanel } from './components/SettingsPanel';
import { SearchHelpPanel } from './components/SearchHelpPanel';
import { AppLogo } from './components/AppLogo';
import Sidebar from './components/Sidebar';
import { TrackList, TrackListHandle } from './components/TrackList';
import { Player } from './components/Player';
import { TagEditor } from './components/TagEditor';
import { TagDeck } from './components/TagDeck';
import { BpmCounter } from './components/BpmCounter';
import { CopyPlaylistsModal } from './components/CopyPlaylistsModal';
import { Track, Playlist } from './types';
import { useToast } from './components/Toast';
import { useDebug } from './components/DebugContext';

function App() {
  const { showSuccess, showError } = useToast();
  const { debugMode, log } = useDebug();
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
  const [playingTrack, setPlayingTrack] = useState<Track | null>(() => {
    const saved = localStorage.getItem('app_playing_track');
    return saved ? JSON.parse(saved) : null;
  });
  const [playingPlaylistId, setPlayingPlaylistId] = useState<number | null>(() => {
    const saved = localStorage.getItem('app_playing_playlist_id');
    return saved ? Number(saved) : null;
  });
  const [playlistNames, setPlaylistNames] = useState<Map<number, string>>(new Map());
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<number>>(new Set());
  const [lastSelectedTrackId, setLastSelectedTrackId] = useState<number | null>(null);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(() => {
    const saved = localStorage.getItem('app_selected_playlist_id');
    return saved ? Number(saved) : null;
  });
  const [shouldAutoPlay, setShouldAutoPlay] = useState(false);
  const [playerMode, setPlayerMode] = useState<'standard' | 'waveform'>(() => {
    return (localStorage.getItem('app_player_mode') as 'standard' | 'waveform') || 'standard';
  });
  const [currentTags, setCurrentTags] = useState<string[]>([]);
  const [activeDragItem, setActiveDragItem] = useState<any>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [highlightedPlaylistId, setHighlightedPlaylistId] = useState<number | null>(null);
  const [isSidebarArtworkVisible, setIsSidebarArtworkVisible] = useState(() => {
    // Default to true or load from storage
    const saved = localStorage.getItem('app_show_sidebar_artwork');
    return saved ? saved === 'true' : false;
  });
  const [syncEnabledTrigger, setSyncEnabledTrigger] = useState(0);
  const [copyPlaylistsTarget, setCopyPlaylistsTarget] = useState<Track | null>(null);
  const [scrollToTrackId, setScrollToTrackId] = useState<number | null>(null);

  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  const trackListRef = useRef<TrackListHandle>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(false);
  const [isRightCollapsed, setIsRightCollapsed] = useState(false);

  useEffect(() => {
    const handlePlayerModeChange = () => {
        const mode = (localStorage.getItem('app_player_mode') as 'standard' | 'waveform') || 'standard';
        console.log('[App] Player mode changed to:', mode);
        setPlayerMode(mode);
    };
    window.addEventListener('player-mode-changed', handlePlayerModeChange);
    return () => window.removeEventListener('player-mode-changed', handlePlayerModeChange);
  }, []);

  useEffect(() => {
    const handleToggle = () => {
        console.log("[App] Sync toggle detected, reloading listener...");
        setSyncEnabledTrigger(p => p + 1);
    };
    window.addEventListener('real-time-sync-toggled', handleToggle);
    return () => window.removeEventListener('real-time-sync-toggled', handleToggle);
  }, []);

  useEffect(() => {
    if (playingTrack) {
      localStorage.setItem('app_playing_track', JSON.stringify(playingTrack));
    } else {
      localStorage.removeItem('app_playing_track');
    }
  }, [playingTrack]);

  useEffect(() => {
    if (playingPlaylistId !== null) {
      localStorage.setItem('app_playing_playlist_id', String(playingPlaylistId));
    } else {
      localStorage.removeItem('app_playing_playlist_id');
    }
  }, [playingPlaylistId]);

  useEffect(() => {
    invoke<Playlist[]>('get_playlists')
      .then(playlists => {
        const map = new Map<number, string>();
        playlists.forEach(p => map.set(p.id, p.name));
        setPlaylistNames(map);
      })
      .catch(console.error);
  }, [refreshTrigger]);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;

    const setupListener = async () => {
      // Check setting first
      const savedSetting = localStorage.getItem('app_real_time_sync_enabled');
      const isEnabled = savedSetting !== 'false'; // Default to true

      if (!isEnabled) {
          console.log("[App] Real-Time Sync is disabled by user setting.");
          return;
      }

      console.log("[App] Setting up music-library-changed listener");
      const unlisten = await listen('music-library-changed', async () => {
        if (!isMounted) return;
        
        console.log("[App] music-library-changed event received!");
        showSuccess('Library change detected. Syncing...');
        log('INFO', 'Library change detected, starting auto-sync');
        
        try {
          const lastSync = localStorage.getItem('app_last_sync_time');
          // Default to 24 hours ago if no record to be safe
          const defaultTime = Math.floor(Date.now() / 1000) - 86400;
          let timestamp = (lastSync && !isNaN(parseInt(lastSync))) ? parseInt(lastSync) : defaultTime;
          
          // Safety Buffer: Go back 3600 seconds (1 hour) to ensure we catch everything, including
          // tracks that might have been missed if previous syncs were buggy or incomplete.
          // Since our DB operation is an upsert, reprocessing unchanged tracks is cheap and safe.
          const bufferSeconds = 3600; 
          const bufferTimestamp = Math.max(0, timestamp - bufferSeconds);

          console.log(`[App] Requesting sync since timestamp: ${bufferTimestamp} (Original: ${timestamp})`);

          interface SyncResult {
              tracks_updated: number;
              tracks_added: number;
              tracks_deleted: number;
              playlists_updated: number;
          }

          const result = await invoke<SyncResult | number>('sync_recent_changes', { 
            sinceTimestamp: bufferTimestamp 
          });

          console.log('[App] Raw sync result:', result);

          // Handle potential legacy return (number) if backend didn't update/recompile yet
          let tracksVal = 0;
          let addedVal = 0;
          let deletedVal = 0;
          let playlistsVal = 0;

          if (typeof result === 'number') {
              tracksVal = result;
          } else if (result && typeof result === 'object') {
              tracksVal = result.tracks_updated || 0;
              addedVal = result.tracks_added || 0;
              deletedVal = result.tracks_deleted || 0;
              playlistsVal = result.playlists_updated || 0;
          }

          const totalUpdated = tracksVal + playlistsVal;
          
          console.log(`[App] Sync parsed: Tracks=${tracksVal}, Added=${addedVal}, Deleted=${deletedVal}, Playlists=${playlistsVal}, Total=${totalUpdated}`);

          if (totalUpdated > 0) {
            const parts: string[] = [];
            // Show added/deleted separately for clarity, group the rest as "updated"
            const pureUpdated = tracksVal - addedVal - deletedVal;
            if (addedVal > 0) parts.push(`${addedVal} track${addedVal > 1 ? 's' : ''} imported`);
            if (deletedVal > 0) parts.push(`${deletedVal} track${deletedVal > 1 ? 's' : ''} removed`);
            if (pureUpdated > 0) parts.push(`${pureUpdated} track${pureUpdated > 1 ? 's' : ''} updated`);
            if (playlistsVal > 0) parts.push(`${playlistsVal} playlist${playlistsVal > 1 ? 's' : ''}`);
            
            showSuccess(`Synced: ${parts.join(', ')}`);
            setRefreshTrigger(p => p + 1);
            localStorage.setItem('app_last_sync_time', Math.floor(Date.now() / 1000).toString());
          } else {
             // If nothing found, show feedback so user knows it finished
             showSuccess("Sync complete. No changes detected.");
             localStorage.setItem('app_last_sync_time', Math.floor(Date.now() / 1000).toString());
          }
        } catch (e) {
          console.error("Auto-sync failed:", e);
          showError(`Auto-sync failed: ${e}`);
          log('ERROR', `Auto-sync failed: ${e}`);
        }
      });

      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    };

    setupListener();

    return () => {
      isMounted = false;
      if (unlistenFn) unlistenFn();
    };
  }, [syncEnabledTrigger]);

  const sensors = useSensors(
      useSensor(PointerSensor, {
          activationConstraint: {
              distance: 8,
          },
      })
  );

  const handleDragStart = (event: DragStartEvent) => {
      setActiveDragItem(event.active.data.current);
  };

  const handleDragEnd = (event: DragEndEvent) => {
      setActiveDragItem(null);
      const { active, over } = event;
      if (!over) return;
      
      const activeId = String(active.id);
      const overId = String(over.id);

      // Track -> Playlist
      if (activeId.startsWith('track-') && overId.startsWith('playlist-')) {
          const trackId = Number(activeId.replace('track-', ''));
          const playlistId = Number(overId.replace('playlist-', ''));
          
          let idsToAdd: number[] = [trackId];
          if (selectedTrackIds.has(trackId)) {
              idsToAdd = Array.from(selectedTrackIds);
          }
          
          invoke('add_to_playlist', { trackIds: idsToAdd, playlistId })
              .then(() => {
                  showSuccess(`Added ${idsToAdd.length} track${idsToAdd.length > 1 ? 's' : ''} to playlist`);
                  setHighlightedPlaylistId(playlistId);
                  // Clear highlight after animation
                  setTimeout(() => setHighlightedPlaylistId(null), 2000);

                  // If we added to the currently viewed playlist, refresh the view
                  if (selectedPlaylistId === playlistId) {
                      setRefreshTrigger(p => p + 1);
                  }
              })
              .catch(err => {
                  console.error("Failed to add to playlist", err);
                  showError("Failed to add tracks to playlist");
              });
          return;
      }
      
      // Column Reorder
      if (trackListRef.current) {
          if (!activeId.startsWith('track-') && !activeId.startsWith('playlist-')) {
              trackListRef.current.handleColumnReorder(activeId, overId);
          }
      }
  };

  // Settings State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSearchHelpOpen, setIsSearchHelpOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('app_theme') || 'dark');
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('app_accent') || '#3b82f6');

  useEffect(() => {
    localStorage.setItem('app_theme', theme);
    // Apply theme
    document.body.className = '';
    document.body.classList.add(`theme-${theme}`);
    
    // Apply accent
    document.documentElement.style.setProperty('--accent-color', accentColor);
    document.documentElement.style.setProperty('--accent-hover', accentColor);
  }, [theme, accentColor]);

  useEffect(() => {
    localStorage.setItem('app_show_sidebar_artwork', isSidebarArtworkVisible.toString());
  }, [isSidebarArtworkVisible]);

  useEffect(() => {
      localStorage.setItem('app_accent', accentColor);
  }, [accentColor]);

  useEffect(() => {
    if (selectedPlaylistId !== null) {
      localStorage.setItem('app_selected_playlist_id', selectedPlaylistId.toString());
    } else {
      localStorage.removeItem('app_selected_playlist_id');
    }
  }, [selectedPlaylistId]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
        // Cmd+F or Ctrl+F -> Focus Search
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            if (searchInputRef.current) {
                searchInputRef.current.focus();
                searchInputRef.current.select();
            }
        }

        // Cmd+0 -> Select All Tracks (playlistId = null)
        if ((e.metaKey || e.ctrlKey) && e.key === '0') {
             e.preventDefault();
             setSelectedPlaylistId(null);
        }

        // Cmd+, -> Open Settings (Standard Mac behavior)
        if ((e.metaKey || e.ctrlKey) && e.key === ',') {
            e.preventDefault();
            setIsSettingsOpen(prev => !prev);
        }

        const target = e.target as HTMLElement;
        const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

        // Escape Handling
        if (e.key === 'Escape') {
            if (document.activeElement === searchInputRef.current) {
                searchInputRef.current?.blur();
            } else if (!isInput) {
                // If not in an input, deselect
                setSelectedTrackIds(prev => prev.size > 0 ? new Set() : prev);
                setSelectedTrack(null);
                setLastSelectedTrackId(null);
                setCurrentTags(prev => prev.length > 0 ? [] : prev);
            }
        }

        // Undo / Redo
        // If focusing input, let browser handle native text undo
        if (!isInput && (e.metaKey || e.ctrlKey)) {
             if (e.key.toLowerCase() === 'z') {
                 if (e.shiftKey) {
                     // Redo
                     e.preventDefault();
                     invoke('redo')
                        .then(() => {
                            setRefreshTrigger(p => p + 1);
                            showSuccess("Redone");
                        })
                        .catch(err => console.error(err));
                 } else {
                     // Undo
                     e.preventDefault();
                     invoke('undo')
                        .then(() => {
                            setRefreshTrigger(p => p + 1);
                            showSuccess("Undone");
                        })
                        .catch(err => console.error(err));
                 }
             } else if (e.key.toLowerCase() === 'y' && !navigator.platform.toUpperCase().includes('MAC')) {
                 // Windows/Linux Redo (Ctrl+Y)
                 e.preventDefault();
                 invoke('redo')
                    .then(() => {
                        setRefreshTrigger(p => p + 1);
                        showSuccess("Redone");
                    })
                    .catch(err => console.error(err));
             }
        }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [showSuccess, showError]);

  useEffect(() => {
    const handleLogsSnapshot = (e: KeyboardEvent) => {
        // Cmd+Opt+L to toggle logs
        if (e.metaKey && e.altKey && (e.key === 'l' || e.key === 'L')) {
            e.preventDefault();
            invoke("toggle_logs").catch(console.error);
        }
    };
    window.addEventListener('keydown', handleLogsSnapshot);
    return () => window.removeEventListener('keydown', handleLogsSnapshot);
  }, []);

  // Toggle handlers
  const toggleLeftPanel = () => {
      const panel = leftPanelRef.current;
      if (panel) {
          const isCollapsed = panel.isCollapsed();
          if (isCollapsed) {
            panel.expand();
          } else {
            panel.collapse();
          }
      }
  };

  const toggleRightPanel = () => {
      const panel = rightPanelRef.current;
      if (panel) {
          const isCollapsed = panel.isCollapsed();
          if (isCollapsed) {
            panel.expand();
          } else {
            panel.collapse();
          }
      }
  };

  const handleRefresh = () => {
    setRefreshTrigger(prev => prev + 1);
  };
  
  const handleSelectionChange = useCallback((ids: Set<number>, lastId: number | null, primaryTrack: Track | null, commonTags: string[]) => {
    setSelectedTrackIds(ids);
    setLastSelectedTrackId(lastId);
    setSelectedTrack(primaryTrack);
    setCurrentTags(commonTags);
  }, []);
  
  const handleTrackDoubleClick = useCallback((track: Track) => {
      // Ensure it is selected (it should be from the click, but to be sure)
      if (selectedTrack?.id !== track.id) {
          const newSet = new Set([track.id]);
          handleSelectionChange(newSet, track.id, track, track.comment_raw ? track.comment_raw.split(" && ")[1]?.split(';') || [] : []);
      }
      setPlayingTrack(track);
      setPlayingPlaylistId(selectedPlaylistId);
      setShouldAutoPlay(true);
  }, [selectedTrack, selectedPlaylistId, handleSelectionChange]);

  const handleDeckTagClick = (tag: string) => {
      if (selectedTrackIds.size === 0) {
          setSearchTerm(prev => {
              if (!prev) return `tag:${tag}`;
              
              // Check if there's already a tag: filter
              const tagMatch = prev.match(/tag:([^\s]+)/);
              if (tagMatch) {
                  // Append to existing tag: filter with comma
                  const existingTags = tagMatch[1];
                  const newTagFilter = `tag:${existingTags},${tag}`;
                  return prev.replace(/tag:[^\s]+/, newTagFilter);
              } else {
                  // Add new tag: filter
                  return `${prev} tag:${tag}`;
              }
          });
          return;
      }
      
      // This will be passed down to TagEditor to actually modify the track
      // Or we can modify it here if we hoist the "Save" logic?
      // For now, let's signal the TagEditor... but TagEditor has its own state.
      // Better: We need a way to tell TagEditor "Add this tag".
      // Let's pass a prop to TagEditor `externalTagToAdd`.
      // OR, simpler: We hoist the tags state to App? 
      // For this phase, let's just log it or try to implement the plumbing.
      const event = new CustomEvent('add-tag-deck', { detail: tag });
      window.dispatchEvent(event);
  };

  return (
    <>
      <DndContext 
          collisionDetection={closestCenter} 
          onDragEnd={handleDragEnd}  
          onDragStart={handleDragStart}
          sensors={sensors}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      
      {/* Header */}
      <header 
         className="no-select"
         data-tauri-drag-region 
         style={{ 
            height: '60px', 
            padding: '0 20px', 
            background: 'var(--bg-secondary)', 
            borderBottom: '1px solid var(--border-color)',
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center',
            flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <AppLogo size={36} />
          <h1 style={{ margin: 0, fontSize: '18px', color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>TagDeck</h1>
          {debugMode && (
            <span style={{
              fontSize: '9px',
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: '4px',
              background: 'rgba(251, 191, 36, 0.2)',
              color: '#fbbf24',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              border: '1px solid rgba(251, 191, 36, 0.3)',
            }}>
              DEBUG
            </span>
          )}
        </div>
        
        {/* Search Bar */}
        <div style={{ flex: 1, maxWidth: '700px', margin: '0 20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
                onClick={() => setIsSearchHelpOpen(!isSearchHelpOpen)}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    padding: '4px',
                    display: 'flex',
                    alignItems: 'center'
                }}
                title="Search Syntax Help"
            >
                <Info size={18} />
            </button>

            <div style={{ position: 'relative', flex: 1 }}>
                <div style={{ 
                    position: 'absolute', 
                    left: '10px', 
                    top: '50%', 
                    transform: 'translateY(-50%)',
                    color: 'var(--text-secondary)',
                    pointerEvents: 'none'
                }}>
                    <Search size={16} />
                </div>
                <input 
                    ref={searchInputRef}
                    type="text" 
                    placeholder="Search library..." 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    style={{
                        width: '100%',
                        padding: '8px 30px 8px 36px',
                        borderRadius: '6px',
                        border: '1px solid var(--border-color)',
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text-primary)',
                        fontSize: '13px',
                        outline: 'none'
                    }}
                    onFocus={(e) => e.target.style.borderColor = 'var(--accent-color)'}
                    onBlur={(e) => e.target.style.borderColor = 'var(--border-color)'}
                />
                {searchTerm && (
                    <button
                        onClick={() => setSearchTerm('')}
                        style={{
                            position: 'absolute',
                            right: '8px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            padding: '2px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                        title="Clear search"
                    >
                        <X size={14} />
                    </button>
                )}
            </div>
            
            <BpmCounter />
        </div>
        
        <SearchHelpPanel 
            isOpen={isSearchHelpOpen} 
            onClose={() => setIsSearchHelpOpen(false)} 
        />


        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
             {/* Toggle Buttons */}
             <button 
                onClick={toggleLeftPanel}
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    padding: '4px',
                    display: 'flex',
                    alignItems: 'center'
                }}
                title={isLeftCollapsed ? "Show Sidebar" : "Hide Sidebar"}
            >
                {isLeftCollapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
            </button>
            <button 
                onClick={toggleRightPanel}
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    padding: '4px',
                    display: 'flex',
                    alignItems: 'center'
                }}
                title={isRightCollapsed ? "Show Tag Deck" : "Hide Tag Deck"}
            >
                {isRightCollapsed ? <PanelRightOpen size={20} /> : <PanelRightClose size={20} />}
            </button>
            
            <button 
                onClick={() => setIsSettingsOpen(!isSettingsOpen)}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    padding: '4px',
                    display: 'flex',
                    alignItems: 'center'
                }}
                title="Settings"
            >
                <Settings size={20} />
            </button>
            <SettingsPanel 
                isOpen={isSettingsOpen} 
                onClose={() => setIsSettingsOpen(false)}
                currentTheme={theme}
                onThemeChange={setTheme}
                currentAccent={accentColor}
                onAccentChange={setAccentColor}
                onRefresh={handleRefresh}
            />
        </div>
      </header>

      {/* Main Content Area */}
      <div style={{ 
        flex: 1, 
        overflow: 'hidden', 
        position: 'relative',
        display: 'flex'
      }}>
      <PanelGroup orientation="horizontal" style={{ height: '100%', width: '100%' }}>
        {/* Left Sidebar */}
        <Panel 
            panelRef={leftPanelRef}
            defaultSize="20" 
            minSize="15" 
            maxSize="50"
            collapsible={true}
            onResize={() => {
              const isCollapsed = leftPanelRef.current?.isCollapsed() ?? false;
              setIsLeftCollapsed(isCollapsed);
            }}
        >
            <Sidebar 
            selectedPlaylistId={selectedPlaylistId} 
            onSelectPlaylist={setSelectedPlaylistId} 
            refreshTrigger={refreshTrigger}
            selectedTrack={playingTrack}
            showArtwork={isSidebarArtworkVisible}
            highlightedPlaylistId={highlightedPlaylistId}
            />
        </Panel>
        
        <PanelResizeHandle className="resize-handle" />

        {/* Track List Container */}
        <Panel minSize="30">
            <div style={{ 
            height: '100%', 
            overflow: 'hidden', 
            display: 'flex',
            flexDirection: 'column'
            }}>
            <TrackList 
              ref={trackListRef}
              playlistId={selectedPlaylistId}
              refreshTrigger={refreshTrigger}
              onSelectionChange={handleSelectionChange}
              onTrackDoubleClick={handleTrackDoubleClick}
              selectedTrackIds={selectedTrackIds}
              lastSelectedTrackId={lastSelectedTrackId}
              playingTrackId={playingTrack?.id}
              isPlaying={isPlaying}
              searchTerm={searchTerm}
              onRefresh={handleRefresh}
              onCopyPlaylistMemberships={setCopyPlaylistsTarget}
              onNavigateToPlaylist={(playlistId, track) => {
                  setSelectedPlaylistId(playlistId);
                  // Select the track and prepare to scroll to it
                  const newSet = new Set([track.id]);
                  const raw = track.comment_raw || '';
                  const tags = raw.indexOf(' && ') !== -1
                      ? raw.substring(raw.indexOf(' && ') + 4).split(';').map(t => t.trim()).filter(Boolean)
                      : [];
                  handleSelectionChange(newSet, track.id, track, tags);
                  setScrollToTrackId(track.id);
              }}
              scrollToTrackId={scrollToTrackId}
              onScrollToTrackComplete={() => setScrollToTrackId(null)}
            />
            </div>
        </Panel>

        <PanelResizeHandle className="resize-handle" />

        {/* Right Sidebar: Tag Editor + Tag Deck */}
        <Panel 
            panelRef={rightPanelRef}
            defaultSize="25" 
            minSize="20" 
            maxSize="60"
            collapsible={true}
            onResize={() => {
              const isCollapsed = rightPanelRef.current?.isCollapsed() ?? false;
              setIsRightCollapsed(isCollapsed);
            }}
        >
            <div style={{ 
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--bg-secondary)'
            }}>
            {/* Editor Panel (Fixed at top of sidebar) */}
            {selectedTrack ? (
                <>
                    <TagEditor 
                        track={selectedTrack} 
                        onUpdate={handleRefresh} 
                        selectedTrackIds={selectedTrackIds}
                        commonTags={currentTags}
                    />
                </>
            ) : (
                <div style={{ padding: '20px', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '13px' }}>
                    Select a track to edit tags
                </div>
            )}

            {/* Tag Deck (Takes remaining space) */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
                <TagDeck 
                        onTagClick={handleDeckTagClick} 
                        currentTrackTags={currentTags}
                        refreshTrigger={refreshTrigger}
                    />
            </div>
            </div>
        </Panel>
      
      </PanelGroup>
      </div>

      {/* Player Footer */}
      <Player 
        track={playingTrack}
        playlistId={playingPlaylistId}
        playlistName={playingPlaylistId ? playlistNames.get(playingPlaylistId) : undefined}
        onPlaylistClick={() => setSelectedPlaylistId(playingPlaylistId)}
        onNext={() => {
             if (playingTrack) {
                 const next = trackListRef.current?.getNextTrack(playingTrack.id);
                 if (next) {
                     setPlayingTrack(next);
                     setShouldAutoPlay(true);
                 }
             }
        }}
        onPrev={() => {
            if (playingTrack) {
                const prev = trackListRef.current?.getPrevTrack(playingTrack.id);
                if (prev) {
                    setPlayingTrack(prev);
                    setShouldAutoPlay(true);
                }
            }
        }}
        autoPlay={shouldAutoPlay}
        onAutoPlayProcessed={() => setShouldAutoPlay(false)}
        playerMode={playerMode}
        onTrackError={handleRefresh}
        accentColor={accentColor}
        onArtworkClick={() => setIsSidebarArtworkVisible(prev => !prev)}
        onTrackClick={() => {
            if (playingTrack) {
                const newSet = new Set([playingTrack.id]);
                const raw = playingTrack.comment_raw || "";
                const tags = raw.indexOf(" && ") !== -1 
                    ? raw.substring(raw.indexOf(" && ") + 4).split(';').map(t => t.trim()).filter(Boolean) 
                    : [];
                handleSelectionChange(newSet, playingTrack.id, playingTrack, tags);
            }
        }}
        onPlayStateChange={setIsPlaying}
      />
    </div>
        <DragOverlay>
           {activeDragItem ? (
                activeDragItem.type === 'Track' ? (
                   <div style={{
                       padding: '8px 12px',
                       background: 'var(--bg-tertiary)',
                       border: '1px solid var(--border-color)',
                       borderRadius: '4px',
                       boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                       color: 'var(--text-primary)',
                       opacity: 0.9,
                       width: '300px',
                       pointerEvents: 'none'
                   }}>
                       <div style={{ fontWeight: 600, fontSize: '13px' }}>{activeDragItem.track.title}</div>
                       <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{activeDragItem.track.artist}</div>
                   </div>
                ) : null
           ) : null}
        </DragOverlay>
      </DndContext>

      {/* Copy Playlist Memberships Modal */}
      {copyPlaylistsTarget && (
        <CopyPlaylistsModal
          targetTrack={copyPlaylistsTarget}
          onClose={() => setCopyPlaylistsTarget(null)}
          onComplete={(msg) => {
            showSuccess(msg);
            setCopyPlaylistsTarget(null);
          }}
          onError={showError}
          onRefresh={handleRefresh}
        />
      )}
    </>
  );
}

export default App;
