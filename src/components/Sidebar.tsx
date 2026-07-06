import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useDroppable } from '@dnd-kit/core';
import { Playlist, Track } from '../types';
import { ChevronRight, ChevronDown, Folder, ListMusic, Plus, Music, Copy, Trash2, Pencil, FolderPlus, ListPlus, ArrowRight, Unlink, FileDown, Search, X, AudioLines, CloudOff, RefreshCw } from 'lucide-react';
import { useToast } from './Toast';
import { isNativeDragOutActive } from '../utils/dragOut';
import { SpotifyImportModal } from './SpotifyImportModal';

interface SidebarProps {
  onSelectPlaylist: (id: number | null) => void;
  selectedPlaylistId: number | null;
  refreshTrigger?: number;
  selectedTrack?: Track | null;
  showArtwork?: boolean;
  highlightedPlaylistId?: number | null;
  onPlaylistsChanged?: () => void;
  appleMusicAvailable?: boolean;
}

interface ContextMenuState {
    x: number;
    y: number;
    node: PlaylistNode | null;
}

interface PlaylistNode extends Playlist {
    children: PlaylistNode[];
}

interface PlaylistRowProps {
    node: PlaylistNode;
    level: number;
    expandedFolders: Set<string>;
    selectedPlaylistId: number | null;
    onSelectPlaylist: (id: number | null) => void;
    toggleFolder: (id: string) => void;
    scrollRef: (node: HTMLDivElement | null) => void;
    highlightScrollRef: (node: HTMLDivElement | null) => void;
    highlightedPlaylistId?: number | null;
    renamingId: number | null;
    renameValue: string;
    onRenameChange: (val: string) => void;
    onRenameCommit: () => void;
    onRenameCancel: () => void;
    onStartRename: (node: PlaylistNode) => void;
    onContextMenu: (e: React.MouseEvent, node: PlaylistNode) => void;
    folders: PlaylistNode[];
    /** Omitted for Spotify rows — ghost playlists aren't a local file-drop target. */
    onFileDrop?: (playlistId: number, playlistName: string, paths: string[]) => Promise<void>;
}

const PlaylistRow = ({
    node,
    level,
    expandedFolders,
    selectedPlaylistId,
    onSelectPlaylist,
    toggleFolder,
    scrollRef,
    highlightScrollRef,
    highlightedPlaylistId,
    renamingId,
    renameValue,
    onRenameChange,
    onRenameCommit,
    onRenameCancel,
    onStartRename,
    onContextMenu,
    onFileDrop,
}: PlaylistRowProps) => {
    const renameInputRef = useRef<HTMLInputElement>(null);
    const fileDragCounter = useRef(0);
    const [isFileDragOver, setIsFileDragOver] = useState(false);
    const { isOver, setNodeRef } = useDroppable({
        id: `playlist-${node.id}`,
        data: {
            type: 'Playlist',
            playlist: node
        },
        disabled: node.is_folder
    });

    const isExpanded = expandedFolders.has(node.persistent_id);
    const isSelected = selectedPlaylistId === node.id;
    const isHighlighted = highlightedPlaylistId === node.id;
    const isRenaming = renamingId === node.id;
    const paddingLeft = 16 + (level * 16);

    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            renameInputRef.current.focus();
            renameInputRef.current.select();
        }
    }, [isRenaming]);

    return (
        <div key={node.persistent_id}>
              <div 
                  ref={(el) => {
                      setNodeRef(el);
                      if (isSelected) scrollRef(el);
                      if (isHighlighted) highlightScrollRef(el);
                  }}
                  onClick={() => {
                      if (isRenaming) return;
                      if (node.is_folder) {
                          toggleFolder(node.persistent_id);
                      } else {
                          onSelectPlaylist(node.id);
                      }
                  }}
                  onDoubleClick={(e) => {
                      e.preventDefault();
                      onStartRename(node);
                  }}
                  onContextMenu={(e) => onContextMenu(e, node)}
                  className={isHighlighted ? 'flash-highlight' : ''}
                  onDragEnter={(e) => {
                      if (node.is_folder || !onFileDrop || !e.dataTransfer.types.includes('Files')) return;
                      e.preventDefault();
                      e.stopPropagation();
                      fileDragCounter.current += 1;
                      if (fileDragCounter.current === 1) setIsFileDragOver(true);
                  }}
                  onDragOver={(e) => {
                      if (node.is_folder || !onFileDrop || !e.dataTransfer.types.includes('Files')) return;
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'copy';
                  }}
                  onDragLeave={(e) => {
                      if (node.is_folder) return;
                      e.preventDefault();
                      e.stopPropagation();
                      fileDragCounter.current -= 1;
                      if (fileDragCounter.current <= 0) {
                          fileDragCounter.current = 0;
                          setIsFileDragOver(false);
                      }
                  }}
                  onDrop={(e) => {
                      if (node.is_folder || !onFileDrop || isNativeDragOutActive()) return;
                      e.preventDefault();
                      e.stopPropagation();
                      // Stop the document-level drop listener in ImportDropZone from
                      // also firing and causing a duplicate import.
                      e.nativeEvent.stopImmediatePropagation();
                      fileDragCounter.current = 0;
                      setIsFileDragOver(false);
                      const files = Array.from(e.dataTransfer.files);
                      const paths = files
                          .map((f) => (f as unknown as { path?: string }).path)
                          .filter((p): p is string => Boolean(p));
                      if (paths.length > 0) onFileDrop?.(node.id, node.name, paths);
                  }}
                  style={{
                      padding: `6px 16px 6px ${paddingLeft}px`,
                      fontSize: '13px',
                      cursor: 'default',
                      backgroundColor: isSelected
                        ? 'var(--accent-color)'
                        : (isOver || isFileDragOver ? 'rgba(59, 130, 246, 0.3)' : 'transparent'),
                      color: isSelected ? '#fff' : 'var(--text-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      userSelect: 'none',
                      transition: 'background-color 0.2s ease',
                      outline: isFileDragOver ? '2px dashed var(--accent-color)' : 'none',
                      outlineOffset: '-2px',
                  }}
                  onMouseEnter={(e) => {
                      if (!isSelected && !isOver && !isFileDragOver && !isHighlighted) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)';
                  }}
                  onMouseLeave={(e) => {
                       if (!isSelected && !isOver && !isFileDragOver && !isHighlighted) e.currentTarget.style.backgroundColor = 'transparent';
                  }}
              >
                  {node.is_folder ? (
                      <div 
                        style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', minWidth: 14, flexShrink: 0 }}
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleFolder(node.persistent_id);
                        }}
                      >
                         {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </div>
                  ) : <div style={{ width: 14, minWidth: 14, flexShrink: 0 }}></div>}
                  
                  {node.is_folder ? (
                     <Folder size={16} 
                        style={{ minWidth: 16, flexShrink: 0 }}
                        fill={isSelected ? "currentColor" : "var(--text-secondary)"} 
                        color={isSelected ? "currentColor" : "var(--text-secondary)"} 
                     />
                  ) : (
                     <ListMusic size={16} style={{ minWidth: 16, flexShrink: 0 }} />
                  )}
                  
                  {isRenaming ? (
                      <input
                          ref={renameInputRef}
                          className="sidebar-rename-input"
                          value={renameValue}
                          onChange={(e) => onRenameChange(e.target.value)}
                          onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                  e.preventDefault();
                                  onRenameCommit();
                              } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  onRenameCancel();
                              }
                          }}
                          onBlur={onRenameCommit}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: '13px',
                              fontWeight: 400,
                              lineHeight: '20px',
                              background: 'var(--bg-primary)',
                              color: 'var(--text-primary)',
                              border: '1px solid var(--accent-color)',
                              borderRadius: '3px',
                              padding: '0 4px',
                              outline: 'none',
                              fontFamily: 'inherit',
                          }}
                      />
                  ) : (
                      <span style={{ 
                          flex: 1,
                          minWidth: 0,
                          fontSize: '13px',
                          fontWeight: 400,
                          lineHeight: '20px',
                          whiteSpace: 'nowrap', 
                          overflow: 'hidden', 
                          textOverflow: 'ellipsis'
                      }}>
                          {node.name}
                      </span>
                  )}

                  {node.itunes_sync_enabled && !isRenaming && (
                      <span title="Synced with iTunes" style={{ display: 'flex', minWidth: 12, flexShrink: 0 }}>
                          <Music size={12} style={{
                              opacity: 0.4,
                              color: isSelected ? '#fff' : 'var(--text-secondary)'
                          }} />
                      </span>
                  )}
                  {node.origin === 'spotify' && !isRenaming && (
                      <span title="Imported from Spotify" style={{ display: 'flex', minWidth: 12, flexShrink: 0 }}>
                          <AudioLines size={12} style={{ opacity: 0.5, color: isSelected ? '#fff' : '#1DB954' }} />
                      </span>
                  )}
              </div>
              
              {node.is_folder && isExpanded && (
                  <div>
                      {node.children.map(child => (
                        <PlaylistRow
                            key={child.persistent_id}
                            node={child}
                            level={level + 1}
                            expandedFolders={expandedFolders}
                            selectedPlaylistId={selectedPlaylistId}
                            onSelectPlaylist={onSelectPlaylist}
                            toggleFolder={toggleFolder}
                            scrollRef={scrollRef}
                            highlightScrollRef={highlightScrollRef}
                            highlightedPlaylistId={highlightedPlaylistId}
                            renamingId={renamingId}
                            renameValue={renameValue}
                            onRenameChange={onRenameChange}
                            onRenameCommit={onRenameCommit}
                            onRenameCancel={onRenameCancel}
                            onStartRename={onStartRename}
                            onContextMenu={onContextMenu}
                            folders={[]}
                            onFileDrop={onFileDrop}
                        />
                      ))}
                  </div>
              )}
        </div>
    );
};

export default function Sidebar({ onSelectPlaylist, selectedPlaylistId, refreshTrigger, selectedTrack, showArtwork, highlightedPlaylistId, onPlaylistsChanged, appleMusicAvailable }: SidebarProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
        const saved = localStorage.getItem('sidebar_expanded_folders');
        return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch (e) {
        console.warn("Failed to load expanded folders state", e);
        return new Set();
    }
  });
  const [hasScrolledToSelection, setHasScrolledToSelection] = useState(false);
  const [hasScrolledToHighlight, setHasScrolledToHighlight] = useState(false);

  // Ephemeral sidebar filter text — not persisted
  const [filterText, setFilterText] = useState('');

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false);

  // Inline rename state
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<PlaylistNode | null>(null);

  // Tracks the playlist id currently mid-flight for a sync toggle, to prevent double-triggering
  const [syncTogglingId, setSyncTogglingId] = useState<number | null>(null);

  // iTunes section collapse state
  const [itunesCollapsed, setItunesCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem('sidebar-itunes-collapsed');
      return saved ? JSON.parse(saved) : false;
    } catch {
      return false;
    }
  });

  // Persist iTunes collapse state
  useEffect(() => {
    try {
      localStorage.setItem('sidebar-itunes-collapsed', JSON.stringify(itunesCollapsed));
    } catch (e) {
      console.error('Failed to save iTunes collapse state', e);
    }
  }, [itunesCollapsed]);

  // Spotify section state
  const [spotifyCollapsed, setSpotifyCollapsed] = useState(false);
  const [spotifyImportOpen, setSpotifyImportOpen] = useState(false);
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [spotifySyncError, setSpotifySyncError] = useState<string | null>(null);

  // Whether Spotify is connected — the section (with its import button) shows
  // even before anything has been imported. Only sets the error indicator on
  // failure here; success does NOT clear it — that's the sync outcome's job
  // (via the spotify-sync-error event below), not this unrelated settings
  // check, which fires far more often (any refreshTrigger bump) than actual
  // sync attempts and would otherwise flicker a real error away early.
  useEffect(() => {
    invoke<{ connected: boolean }>('spotify_get_settings')
      .then(s => setSpotifyConnected(s.connected))
      .catch(e => setSpotifySyncError(String(e)));
  }, [refreshTrigger]);

  // Quiet offline/error indicator for the Spotify header, driven by App.tsx's
  // launch/15-minute auto-sync timer (never a toast — see spec).
  useEffect(() => {
    const handleSyncError = (e: Event) => {
      setSpotifySyncError((e as CustomEvent<string | null>).detail);
    };
    window.addEventListener('spotify-sync-error', handleSyncError);
    return () => window.removeEventListener('spotify-sync-error', handleSyncError);
  }, []);

  useEffect(() => {
    loadPlaylists();
  }, [refreshTrigger]);

  useEffect(() => {
    setHasScrolledToSelection(false);
  }, [selectedPlaylistId]);

  useEffect(() => {
    localStorage.setItem('sidebar_expanded_folders', JSON.stringify(Array.from(expandedFolders)));
  }, [expandedFolders]);

  // Expand parents of selected playlist on load or selection change
  useEffect(() => {
      if (playlists.length > 0 && selectedPlaylistId && !hasScrolledToSelection) {
          const selected = playlists.find(p => p.id === selectedPlaylistId);
          if (selected) {
              const pMap = new Map(playlists.map(p => [p.persistent_id, p]));
              let newExpanded: Set<string> | null = null;
              
              let curr = selected;
              while(curr.parent_persistent_id) {
                   const parent = pMap.get(curr.parent_persistent_id);
                   if (parent && !expandedFolders.has(parent.persistent_id)) {
                       if (!newExpanded) newExpanded = new Set(expandedFolders);
                       newExpanded.add(parent.persistent_id);
                       curr = parent;
                   } else if (parent) {
                       curr = parent;
                   } else {
                       break;
                   }
              }
              
              if (newExpanded) {
                  setExpandedFolders(newExpanded);
              }
          }
      }
  }, [playlists, selectedPlaylistId, hasScrolledToSelection]);

  const scrollRef = (node: HTMLDivElement | null) => {
      if (node && !hasScrolledToSelection) {
          node.scrollIntoView({ block: 'nearest' });
          setHasScrolledToSelection(true);
      }
  };

  useEffect(() => {
      setHasScrolledToHighlight(false);
  }, [highlightedPlaylistId]);

  // Reveal the highlighted playlist: expand its ancestor chain (and itself if a
  // folder), and un-collapse the iTunes section if it lives there.
  useEffect(() => {
      if (highlightedPlaylistId == null || playlists.length === 0) return;
      const pMap = new Map(playlists.map(p => [p.persistent_id, p]));
      const target = playlists.find(p => p.id === highlightedPlaylistId);
      if (!target) return;

      // Walk to the root ancestor to determine which section (TagDeck/iTunes) owns it.
      let root = target;
      while (root.parent_persistent_id) {
          const parent = pMap.get(root.parent_persistent_id);
          if (!parent) break;
          root = parent;
      }

      setExpandedFolders(prev => {
          const next = new Set(prev);
          let changed = false;

          if (target.is_folder && !next.has(target.persistent_id)) {
              next.add(target.persistent_id);
              changed = true;
          }

          let curr: Playlist | undefined = target;
          while (curr?.parent_persistent_id) {
              const parent: Playlist | undefined = pMap.get(curr.parent_persistent_id);
              if (!parent) break;
              if (!next.has(parent.persistent_id)) {
                  next.add(parent.persistent_id);
                  changed = true;
              }
              curr = parent;
          }

          return changed ? next : prev;
      });

      if (root.itunes_sync_enabled && itunesCollapsed) {
          setItunesCollapsed(false);
      }
  }, [highlightedPlaylistId, playlists, itunesCollapsed]);

  const highlightScrollRef = (node: HTMLDivElement | null) => {
      if (node && !hasScrolledToHighlight) {
          node.scrollIntoView({ block: 'nearest' });
          setHasScrolledToHighlight(true);
      }
  };

  async function loadPlaylists() {
    try {
      const data = await invoke<Playlist[]>('get_playlists');
      setPlaylists(data);
    } catch (e) {
      console.error("Failed to load playlists", e);
    } 
  }

  const toggleFolder = (persistentId: string) => {
      const newSet = new Set(expandedFolders);
      if (newSet.has(persistentId)) {
          newSet.delete(persistentId);
      } else {
          newSet.add(persistentId);
      }
      setExpandedFolders(newSet);
  };

  // Close context menu when clicking outside or pressing Escape
  useEffect(() => {
      if (!contextMenu) return;

      const handleClose = (e: MouseEvent) => {
          const target = e.target as HTMLElement;
          if (target.closest('.sidebar-context-menu')) return;
          setContextMenu(null);
          setMoveSubmenuOpen(false);
      };

      const handleEscape = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
              setContextMenu(null);
              setMoveSubmenuOpen(false);
          }
      };

      // Defer attachment so we don't catch the right-click that opened the menu
      const frame = requestAnimationFrame(() => {
          window.addEventListener('mousedown', handleClose, true);
          window.addEventListener('contextmenu', handleClose, true);
          window.addEventListener('keydown', handleEscape);
      });

      return () => {
          cancelAnimationFrame(frame);
          window.removeEventListener('mousedown', handleClose, true);
          window.removeEventListener('contextmenu', handleClose, true);
          window.removeEventListener('keydown', handleEscape);
      };
  }, [contextMenu]);

  // --- CRUD Helpers ---

  const refreshPlaylists = useCallback(async () => {
      await loadPlaylists();
      onPlaylistsChanged?.();
  }, [onPlaylistsChanged]);

  const handleCreatePlaylist = useCallback(async (isFolder: boolean, parentId?: number) => {
      try {
          const name = isFolder ? 'New Folder' : 'New Playlist';
          const created = await invoke<Playlist>('create_playlist', {
              name,
              parentId: parentId ?? null,
              isFolder,
          });
          // Auto-expand parent folder so the new item is visible
          if (created.parent_persistent_id) {
              setExpandedFolders(prev => {
                  const next = new Set(prev);
                  next.add(created.parent_persistent_id!);
                  return next;
              });
          }
          await refreshPlaylists();
          // Select the new playlist and start renaming
          if (!isFolder) {
              onSelectPlaylist(created.id);
          }
          setRenamingId(created.id);
          setRenameValue(name);
      } catch (e) {
          console.error('Failed to create playlist', e);
      }
  }, [refreshPlaylists, onSelectPlaylist]);

  const onStartRename = useCallback((node: PlaylistNode) => {
      setRenamingId(node.id);
      setRenameValue(node.name);
  }, []);

  const onRenameChange = useCallback((val: string) => {
      setRenameValue(val);
  }, []);

  const onRenameCommit = useCallback(async () => {
      if (renamingId === null) return;
      const trimmed = renameValue.trim();
      if (trimmed.length === 0) {
          setRenamingId(null);
          setRenameValue('');
          return;
      }
      try {
          await invoke('rename_playlist', { id: renamingId, name: trimmed });
          await refreshPlaylists();
      } catch (e) {
          console.error('Failed to rename playlist', e);
      } finally {
          setRenamingId(null);
          setRenameValue('');
      }
  }, [renamingId, renameValue, refreshPlaylists]);

  const onRenameCancel = useCallback(() => {
      setRenamingId(null);
      setRenameValue('');
  }, []);

  const handleDelete = useCallback(async () => {
      if (!deleteTarget) return;
      try {
          await invoke('delete_playlist', { id: deleteTarget.id });
          if (selectedPlaylistId === deleteTarget.id) {
              onSelectPlaylist(null);
          }
          await refreshPlaylists();
      } catch (e) {
          console.error('Failed to delete playlist', e);
      } finally {
          setDeleteTarget(null);
      }
  }, [deleteTarget, selectedPlaylistId, onSelectPlaylist, refreshPlaylists]);

  const handleDuplicate = useCallback(async (node: PlaylistNode) => {
      try {
          const newName = `${node.name} Copy`;
          const created = await invoke<Playlist>('duplicate_playlist', { id: node.id, newName });
          await refreshPlaylists();
          onSelectPlaylist(created.id);
      } catch (e) {
          console.error('Failed to duplicate playlist', e);
      }
  }, [refreshPlaylists, onSelectPlaylist]);

  const handleMove = useCallback(async (node: PlaylistNode, newParentId: number | null) => {
      try {
          await invoke('move_playlist', { id: node.id, newParentId });
          await refreshPlaylists();
      } catch (e) {
          console.error('Failed to move playlist', e);
      }
  }, [refreshPlaylists]);

  const onContextMenu = useCallback((e: React.MouseEvent, node: PlaylistNode) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, node });
      setMoveSubmenuOpen(false);
  }, []);

  const handleBackgroundContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, node: null });
      setMoveSubmenuOpen(false);
  }, []);

  const { showSuccess, showError } = useToast();

  const handleFileDrop = useCallback(async (playlistId: number, playlistName: string, paths: string[]) => {
      try {
          const summary = await invoke<{ imported: number; skipped: number; failed: number }>(
              'import_files',
              { filePaths: paths, targetPlaylistId: playlistId }
          );
          await refreshPlaylists();
          if (summary.imported > 0) {
              showSuccess(`Added ${summary.imported} track${summary.imported !== 1 ? 's' : ''} to "${playlistName}"`);
          } else if (summary.skipped > 0) {
              showSuccess(`${summary.skipped} track${summary.skipped !== 1 ? 's' : ''} already in library`);
          }
          if (summary.failed > 0) {
              showError(`${summary.failed} file${summary.failed !== 1 ? 's' : ''} failed to import`);
          }
      } catch (err) {
          showError(`Import failed: ${err}`);
      }
  }, [refreshPlaylists, showSuccess, showError]);

  const handleToggleSync = useCallback(async (node: PlaylistNode, enabled: boolean) => {
      if (syncTogglingId !== null) return;
      setSyncTogglingId(node.id);
      try {
          await invoke<string>('set_playlist_sync', { playlistId: node.id, enabled });
          await refreshPlaylists();
      } catch (err) {
          showError(typeof err === 'string' ? err : `Failed to update iTunes sync: ${err}`);
      } finally {
          setSyncTogglingId(null);
      }
  }, [syncTogglingId, refreshPlaylists, showError]);

  const handleSpotifySyncNow = useCallback(async () => {
      try {
          await invoke('spotify_sync_now');
          setSpotifySyncError(null);
          await refreshPlaylists();
      } catch (err) {
          const msg = typeof err === 'string' ? err : String(err);
          setSpotifySyncError(msg);
          showError(`Spotify sync failed: ${msg}`);
      }
  }, [refreshPlaylists, showError]);

  const handleExportM3u8 = useCallback(async (node: PlaylistNode) => {
      try {
          const { save } = await import('@tauri-apps/plugin-dialog');
          const dest = await save({
              defaultPath: `${node.name}.m3u8`,
              filters: [{ name: 'M3U8 Playlist', extensions: ['m3u8'] }],
          });
          if (!dest) return;
          const report = await invoke<{ written: number; skipped_missing: number }>(
              'export_playlist_m3u8',
              { playlistId: node.id, destPath: dest }
          );
          if (report.written === 0) {
              showSuccess('Playlist is empty — wrote an empty M3U8');
          } else {
              const filename = dest.split(/[\\/]/).pop() ?? dest;
              let msg = `Exported ${report.written} track${report.written !== 1 ? 's' : ''} to ${filename}`;
              if (report.skipped_missing > 0) {
                  msg += `, ${report.skipped_missing} missing skipped`;
              }
              showSuccess(msg);
          }
      } catch (err) {
          showError(typeof err === 'string' ? err : `Export failed: ${err}`);
      }
  }, [showSuccess, showError]);

  const { tagdeckTree, itunesTree, spotifyTree } = useMemo(() => {
      const map = new Map<string, PlaylistNode>();
      const tagdeckRoots: PlaylistNode[] = [];
      const itunesRoots: PlaylistNode[] = [];
      const spotifyRoots: PlaylistNode[] = [];

      // Initialize nodes
      playlists.forEach(p => {
          map.set(p.persistent_id, { ...p, children: [] });
      });

      // Build hierarchy
      playlists.forEach(p => {
          const node = map.get(p.persistent_id)!;
          if (p.parent_persistent_id && map.has(p.parent_persistent_id)) {
              const parent = map.get(p.parent_persistent_id)!;
              parent.children.push(node);
          } else if (p.origin === 'spotify') {
              // Spotify-imported playlists always get their own section,
              // regardless of iTunes sync state (which doesn't apply to them).
              spotifyRoots.push(node);
          } else {
              // Split into TagDeck vs iTunes based on whether the playlist is
              // actively synced with iTunes, not its origin.
              if (p.itunes_sync_enabled) {
                  itunesRoots.push(node);
              } else {
                  tagdeckRoots.push(node);
              }
          }
      });

      // Sort nodes
      const sortNodes = (nodes: PlaylistNode[]) => {
          nodes.sort((a, b) => {
              // 1. Folders first (Descending: true comes before false)
              if (a.is_folder !== b.is_folder) {
                  return a.is_folder ? -1 : 1;
              }
              // 2. Name
              // Special handling for underscores/symbols if desired,
              // but localeCompare usually handles this well or standard ASCII rules.
              // " _" < "A" is standard ASCII.
              return a.name.localeCompare(b.name);
          });
          nodes.forEach(n => sortNodes(n.children));
      };

      sortNodes(tagdeckRoots);
      sortNodes(itunesRoots);
      sortNodes(spotifyRoots);
      return { tagdeckTree: tagdeckRoots, itunesTree: itunesRoots, spotifyTree: spotifyRoots };
  }, [playlists]);

  const isFiltering = filterText.trim().length > 0;

  // Derive filtered trees (and the folders that should render expanded while
  // filtering) from the raw trees + filter text. Ephemeral — does not touch
  // the persisted expandedFolders state.
  const { filteredTagdeckTree, filteredItunesTree, filteredSpotifyTree, filterExpandedFolders } = useMemo(() => {
      if (!isFiltering) {
          return { filteredTagdeckTree: tagdeckTree, filteredItunesTree: itunesTree, filteredSpotifyTree: spotifyTree, filterExpandedFolders: expandedFolders };
      }

      const query = filterText.trim().toLowerCase();

      const filterNodes = (nodes: PlaylistNode[]): PlaylistNode[] => {
          const result: PlaylistNode[] = [];
          for (const n of nodes) {
              const selfMatch = n.name.toLowerCase().includes(query);
              if (n.is_folder) {
                  if (selfMatch) {
                      // Whole subtree matches — keep it intact.
                      result.push(n);
                  } else {
                      const children = filterNodes(n.children);
                      if (children.length > 0) {
                          result.push({ ...n, children });
                      }
                  }
              } else if (selfMatch) {
                  result.push(n);
              }
          }
          return result;
      };

      const ft = filterNodes(tagdeckTree);
      const it = filterNodes(itunesTree);
      const st = filterNodes(spotifyTree);

      const folderIds = new Set<string>();
      const collectFolderIds = (nodes: PlaylistNode[]) => {
          for (const n of nodes) {
              if (n.is_folder) {
                  folderIds.add(n.persistent_id);
                  collectFolderIds(n.children);
              }
          }
      };
      collectFolderIds(ft);
      collectFolderIds(it);
      collectFolderIds(st);

      return { filteredTagdeckTree: ft, filteredItunesTree: it, filteredSpotifyTree: st, filterExpandedFolders: folderIds };
  }, [isFiltering, filterText, tagdeckTree, itunesTree, spotifyTree, expandedFolders]);

  // Collect all folders for the "Move to" submenu
  const allFolders = useMemo(() => {
      const collectFolders = (nodes: PlaylistNode[]): PlaylistNode[] => {
          const result: PlaylistNode[] = [];
          for (const n of nodes) {
              if (n.is_folder) {
                  result.push(n);
                  result.push(...collectFolders(n.children));
              }
          }
          return result;
      };
      return [...collectFolders(tagdeckTree), ...collectFolders(itunesTree)];
  }, [tagdeckTree, itunesTree]);



  return (
    <div className="no-select" style={{
      width: '100%',
      minWidth: '100px',
      maxWidth: '100%',
      height: '100%',
      backgroundColor: 'var(--bg-secondary)', 
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      color: 'var(--text-primary)'
    }}>
      <div style={{ 
        padding: '12px 16px', 
        fontWeight: 600, 
        fontSize: '11px',
        color: 'var(--text-secondary)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em'
      }}>
        Library
      </div>

      <div style={{ padding: '0 16px 8px' }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={13} style={{ position: 'absolute', left: 8, color: 'var(--text-secondary)', pointerEvents: 'none' }} />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    setFilterText('');
                    (e.target as HTMLInputElement).blur();
                }
            }}
            placeholder="Filter playlists"
            style={{
                width: '100%',
                fontSize: '12px',
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                padding: '5px 22px 5px 24px',
                color: 'var(--text-primary)',
                outline: 'none',
                boxSizing: 'border-box',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent-color)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}
          />
          {filterText.length > 0 && (
            <button
                onClick={() => setFilterText('')}
                title="Clear filter"
                style={{
                    position: 'absolute',
                    right: 6,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    padding: 2,
                }}
            >
                <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
           onContextMenu={handleBackgroundContextMenu}
      >
        <div 
          ref={(node) => {
              if (selectedPlaylistId === null) scrollRef(node);
          }}
          onClick={() => onSelectPlaylist(null)}
          style={{
            padding: '6px 16px',
            fontSize: '13px',
            cursor: 'default',
            backgroundColor: selectedPlaylistId === null ? 'var(--accent-color)' : 'transparent',
            color: selectedPlaylistId === null ? '#fff' : 'var(--text-primary)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          <div style={{ width: 14, minWidth: 14, flexShrink: 0 }} /> 
          <ListMusic size={16} style={{ minWidth: 16, flexShrink: 0 }} /> 
          <span style={{ 
              flex: 1,
              minWidth: 0,
              fontSize: '13px',
              fontWeight: 400,
              lineHeight: '20px',
              whiteSpace: 'nowrap', 
              overflow: 'hidden', 
              textOverflow: 'ellipsis'
          }}>All Tracks</span>
        </div>
        
        {/* TagDeck Playlists Section - Always show header with + button */}
        <div style={{ 
          padding: '12px 16px 4px', 
          fontWeight: 600, 
          fontSize: '11px',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginTop: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>TagDeck Playlists</span>
          <button
              className="sidebar-add-btn"
              title="New Playlist"
              onClick={(e) => {
                  e.stopPropagation();
                  handleCreatePlaylist(false);
              }}
              style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  padding: '0 2px',
                  display: 'flex',
                  alignItems: 'center',
                  borderRadius: '3px',
                  transition: 'color 0.15s ease',
              }}
          >
              <Plus size={14} />
          </button>
        </div>

        {filteredTagdeckTree.length > 0 ? (
          <>
            {filteredTagdeckTree.map(node => (
              <PlaylistRow
                  key={node.persistent_id}
                  node={node}
                  level={0}
                  expandedFolders={filterExpandedFolders}
                  selectedPlaylistId={selectedPlaylistId}
                  onSelectPlaylist={onSelectPlaylist}
                  toggleFolder={toggleFolder}
                  scrollRef={scrollRef}
                  highlightScrollRef={highlightScrollRef}
                  highlightedPlaylistId={highlightedPlaylistId}
                  renamingId={renamingId}
                  renameValue={renameValue}
                  onRenameChange={onRenameChange}
                  onRenameCommit={onRenameCommit}
                  onRenameCancel={onRenameCancel}
                  onStartRename={onStartRename}
                  onContextMenu={onContextMenu}
                  folders={allFolders}
                  onFileDrop={handleFileDrop}
              />
            ))}
          </>
        ) : (
          <div style={{
              padding: '8px 16px',
              textAlign: 'center',
              color: 'var(--text-secondary)',
              fontSize: '12px',
              fontStyle: 'italic',
          }}>
              {isFiltering ? 'No matching playlists' : 'No TagDeck playlists yet'}
          </div>
        )}

        {/* iTunes Playlists Section */}
        {filteredItunesTree.length > 0 && (
          <>
            <div
              onClick={() => setItunesCollapsed(!itunesCollapsed)}
              style={{
                padding: '12px 16px 4px',
                fontWeight: 600,
                fontSize: '11px',
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginTop: filteredTagdeckTree.length > 0 ? '16px' : '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              {(!isFiltering && itunesCollapsed) ? (
                <ChevronRight size={12} style={{ minWidth: 12, flexShrink: 0 }} />
              ) : (
                <ChevronDown size={12} style={{ minWidth: 12, flexShrink: 0 }} />
              )}
              <span>iTunes Playlists</span>
            </div>

            {(isFiltering || !itunesCollapsed) && filteredItunesTree.map(node => (
              <PlaylistRow
                  key={node.persistent_id}
                  node={node}
                  level={0}
                  expandedFolders={filterExpandedFolders}
                  selectedPlaylistId={selectedPlaylistId}
                  onSelectPlaylist={onSelectPlaylist}
                  toggleFolder={toggleFolder}
                  scrollRef={scrollRef}
                  highlightScrollRef={highlightScrollRef}
                  highlightedPlaylistId={highlightedPlaylistId}
                  renamingId={renamingId}
                  renameValue={renameValue}
                  onRenameChange={onRenameChange}
                  onRenameCommit={onRenameCommit}
                  onRenameCancel={onRenameCancel}
                  onStartRename={onStartRename}
                  onContextMenu={onContextMenu}
                  folders={allFolders}
                  onFileDrop={handleFileDrop}
              />
            ))}
          </>
        )}

        {/* Spotify Playlists Section — only present once connected or something's imported */}
        {(filteredSpotifyTree.length > 0 || spotifyConnected) && (
          <>
            <div
              onClick={() => setSpotifyCollapsed(!spotifyCollapsed)}
              style={{
                padding: '12px 16px 4px',
                fontWeight: 600,
                fontSize: '11px',
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginTop: (filteredTagdeckTree.length > 0 || filteredItunesTree.length > 0) ? '16px' : '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              {(!isFiltering && spotifyCollapsed) ? (
                <ChevronRight size={12} style={{ minWidth: 12, flexShrink: 0 }} />
              ) : (
                <ChevronDown size={12} style={{ minWidth: 12, flexShrink: 0 }} />
              )}
              <span style={{ flex: 1 }}>Spotify</span>
              {spotifySyncError && (
                <span title={`Spotify sync unavailable: ${spotifySyncError}`}
                      style={{ display: 'flex', flexShrink: 0 }}>
                  <CloudOff size={12} style={{ color: 'var(--text-secondary)', opacity: 0.7 }} />
                </span>
              )}
              <button
                  className="sidebar-add-btn"
                  title="Import playlists…"
                  onClick={(e) => { e.stopPropagation(); setSpotifyImportOpen(true); }}
                  style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--text-secondary)',
                      padding: '0 2px',
                      display: 'flex',
                      alignItems: 'center',
                      borderRadius: '3px',
                      transition: 'color 0.15s ease',
                  }}
              >
                  <Plus size={14} />
              </button>
            </div>

            {(isFiltering || !spotifyCollapsed) && filteredSpotifyTree.map(node => (
              <PlaylistRow
                  key={node.persistent_id}
                  node={node}
                  level={0}
                  expandedFolders={filterExpandedFolders}
                  selectedPlaylistId={selectedPlaylistId}
                  onSelectPlaylist={onSelectPlaylist}
                  toggleFolder={toggleFolder}
                  scrollRef={scrollRef}
                  highlightScrollRef={highlightScrollRef}
                  highlightedPlaylistId={highlightedPlaylistId}
                  renamingId={renamingId}
                  renameValue={renameValue}
                  onRenameChange={onRenameChange}
                  onRenameCommit={onRenameCommit}
                  onRenameCancel={onRenameCancel}
                  onStartRename={onStartRename}
                  onContextMenu={onContextMenu}
                  folders={allFolders}
              />
            ))}
          </>
        )}
      </div>

      <SpotifyImportModal
          isOpen={spotifyImportOpen}
          onClose={() => setSpotifyImportOpen(false)}
          onImported={() => { onPlaylistsChanged?.(); }}
      />

      {showArtwork && selectedTrack && (
          <SidebarArtwork track={selectedTrack} />
      )}

      {/* Context Menu */}
      {contextMenu && (
          <div 
              className="sidebar-context-menu"
              style={{
                  position: 'fixed',
                  left: contextMenu.x,
                  top: contextMenu.y,
                  zIndex: 9999,
              }}
              onMouseDown={(e) => e.stopPropagation()}
          >
              <button className="ctx-item" onClick={() => { setContextMenu(null); handleCreatePlaylist(false, contextMenu.node?.is_folder ? contextMenu.node.id : undefined); }}>
                  <ListPlus size={14} /> New Playlist
              </button>
              <button className="ctx-item" onClick={() => { setContextMenu(null); handleCreatePlaylist(true, contextMenu.node?.is_folder ? contextMenu.node.id : undefined); }}>
                  <FolderPlus size={14} /> New Folder
              </button>

              {contextMenu.node && (
                  <>
                      <div className="ctx-separator" />
                      {contextMenu.node.origin === 'spotify' ? (
                          <>
                              {/* Spotify playlists: rename/duplicate/iTunes-sync/export/move don't apply. */}
                              <button className="ctx-item" onClick={() => { setContextMenu(null); handleSpotifySyncNow(); }}>
                                  <RefreshCw size={14} /> Sync Now
                              </button>
                              <div className="ctx-separator" />
                              <button className="ctx-item ctx-danger" onClick={() => { setContextMenu(null); setDeleteTarget(contextMenu.node!); }}>
                                  <Trash2 size={14} /> Remove from TagDeck
                              </button>
                          </>
                      ) : (
                          <>
                              <button className="ctx-item" onClick={() => { setContextMenu(null); onStartRename(contextMenu.node!); }}>
                                  <Pencil size={14} /> Rename
                              </button>
                              {!contextMenu.node.is_folder && (
                                  <button className="ctx-item" onClick={() => { setContextMenu(null); handleDuplicate(contextMenu.node!); }}>
                                      <Copy size={14} /> Duplicate
                                  </button>
                              )}

                              {!contextMenu.node.is_folder && (
                                  contextMenu.node.itunes_sync_enabled ? (
                                      <button
                                          className="ctx-item"
                                          disabled={syncTogglingId === contextMenu.node.id}
                                          onClick={() => { const n = contextMenu.node!; setContextMenu(null); handleToggleSync(n, false); }}
                                      >
                                          <Unlink size={14} /> Stop Syncing with iTunes
                                      </button>
                                  ) : (
                                      <button
                                          className="ctx-item"
                                          disabled={syncTogglingId === contextMenu.node.id || appleMusicAvailable === false}
                                          title={appleMusicAvailable === false ? 'Music.app not detected' : undefined}
                                          onClick={() => { const n = contextMenu.node!; setContextMenu(null); handleToggleSync(n, true); }}
                                      >
                                          <Music size={14} /> Sync to iTunes
                                      </button>
                                  )
                              )}

                              {!contextMenu.node.is_folder && (
                                  <button className="ctx-item" onClick={() => { const n = contextMenu.node!; setContextMenu(null); handleExportM3u8(n); }}>
                                      <FileDown size={14} /> Export as M3U8…
                                  </button>
                              )}

                              {/* Move to submenu */}
                              <div
                                  className="ctx-item ctx-submenu-trigger"
                                  onMouseEnter={() => setMoveSubmenuOpen(true)}
                                  onMouseLeave={() => setMoveSubmenuOpen(false)}
                              >
                                  <ArrowRight size={14} /> Move to…
                                  {moveSubmenuOpen && (
                                      <div className="sidebar-context-menu ctx-submenu">
                                          <button className="ctx-item" onClick={() => {
                                              setContextMenu(null);
                                              handleMove(contextMenu.node!, null);
                                          }}>
                                              Root
                                          </button>
                                          {allFolders
                                              .filter(f => f.id !== contextMenu.node!.id)
                                              .map(f => (
                                                  <button key={f.id} className="ctx-item" onClick={() => {
                                                      setContextMenu(null);
                                                      handleMove(contextMenu.node!, f.id);
                                                  }}>
                                                      {f.name}
                                                  </button>
                                              ))
                                          }
                                      </div>
                                  )}
                              </div>

                              <div className="ctx-separator" />
                              <button className="ctx-item ctx-danger" onClick={() => { setContextMenu(null); setDeleteTarget(contextMenu.node!); }}>
                                  <Trash2 size={14} /> Delete
                              </button>
                          </>
                      )}
                  </>
              )}
          </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
          <div style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
          }}
              onClick={() => setDeleteTarget(null)}
          >
              <div 
                  className="sidebar-delete-dialog"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      padding: '20px',
                      maxWidth: '360px',
                      width: '90%',
                  }}
              >
                  <h3 style={{ margin: '0 0 8px', fontSize: '15px', fontWeight: 600 }}>
                      Delete {deleteTarget.is_folder ? 'Folder' : 'Playlist'}
                  </h3>
                  <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                      {deleteTarget.itunes_sync_enabled
                          ? `Are you sure you want to remove "${deleteTarget.name}" from TagDeck? This will not delete it from Apple Music.`
                          : deleteTarget.origin === 'spotify'
                          ? `Are you sure you want to remove "${deleteTarget.name}" from TagDeck? This will not delete it from Spotify — you can re-import it later.`
                          : `Are you sure you want to permanently delete "${deleteTarget.name}"? This cannot be undone.`
                      }
                      {deleteTarget.is_folder && deleteTarget.children.length > 0 && (
                          <><br /><br /><strong>This folder contains {deleteTarget.children.length} item{deleteTarget.children.length !== 1 ? 's' : ''} that will also be deleted.</strong></>
                      )}
                  </p>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                      <button className="btn" onClick={() => setDeleteTarget(null)}>Cancel</button>
                      <button 
                          className="btn" 
                          style={{ backgroundColor: 'var(--error-color)', borderColor: 'var(--error-color)', color: '#fff' }}
                          onClick={handleDelete}
                      >
                          Delete
                      </button>
                  </div>
              </div>
          </div>
      )}
    </div>
  );
}

function SidebarArtwork({ track }: { track: Track }) {
    const [artworkUrl, setArtworkUrl] = useState<string | null>(null);

    useEffect(() => {
        setArtworkUrl(null);
        let active = true;
        const fetchArt = async () => {
             try {
                const data = await invoke<number[] | null>('get_track_artwork', { id: track.id });
                if (active && data) {
                     const blob = new Blob([new Uint8Array(data)]);
                     const url = URL.createObjectURL(blob);
                     setArtworkUrl(url);
                }
             } catch(e) { /* ignore */ }
        };
        fetchArt();
        return () => { active = false; };
    }, [track.id]); // Only re-fetch if track ID changes

    useEffect(() => {
        return () => { if (artworkUrl) URL.revokeObjectURL(artworkUrl); };
    }, [artworkUrl]);

    if (!artworkUrl) return null;

    return (
        <div style={{ 
            width: '100%', 
            aspectRatio: '1', 
            position: 'relative', 
            borderTop: '1px solid var(--border-color)',
            background: 'var(--bg-tertiary)',
            flexShrink: 0
        }}>
            <div style={{ 
                position: 'absolute', 
                inset: 0, 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center',
                overflow: 'hidden'
            }}>
                <img 
                    src={artworkUrl} 
                    alt="Album Art" 
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }} 
                />
            </div>
        </div>
    );
}
