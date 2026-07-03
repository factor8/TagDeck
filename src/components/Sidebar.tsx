import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useDroppable } from '@dnd-kit/core';
import { Playlist, Track } from '../types';
import { ChevronRight, ChevronDown, Folder, ListMusic, Plus, Music, Copy, Trash2, Pencil, FolderPlus, ListPlus, ArrowRight } from 'lucide-react';
import { useToast } from './Toast';

interface SidebarProps {
  onSelectPlaylist: (id: number | null) => void;
  selectedPlaylistId: number | null;
  refreshTrigger?: number;
  selectedTrack?: Track | null;
  showArtwork?: boolean;
  highlightedPlaylistId?: number | null;
  onPlaylistsChanged?: () => void;
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
    highlightedPlaylistId?: number | null;
    renamingId: number | null;
    renameValue: string;
    onRenameChange: (val: string) => void;
    onRenameCommit: () => void;
    onRenameCancel: () => void;
    onStartRename: (node: PlaylistNode) => void;
    onContextMenu: (e: React.MouseEvent, node: PlaylistNode) => void;
    folders: PlaylistNode[];
    onFileDrop: (playlistId: number, playlistName: string, paths: string[]) => Promise<void>;
}

const PlaylistRow = ({
    node,
    level,
    expandedFolders,
    selectedPlaylistId,
    onSelectPlaylist,
    toggleFolder,
    scrollRef,
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
                      if (node.is_folder || !e.dataTransfer.types.includes('Files')) return;
                      e.preventDefault();
                      e.stopPropagation();
                      fileDragCounter.current += 1;
                      if (fileDragCounter.current === 1) setIsFileDragOver(true);
                  }}
                  onDragOver={(e) => {
                      if (node.is_folder || !e.dataTransfer.types.includes('Files')) return;
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
                      if (node.is_folder) return;
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
                      if (paths.length > 0) onFileDrop(node.id, node.name, paths);
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

                  {node.origin === 'itunes' && !isRenaming && (
                      <Music size={12} style={{ 
                          minWidth: 12, 
                          flexShrink: 0, 
                          opacity: 0.4,
                          color: isSelected ? '#fff' : 'var(--text-secondary)'
                      }} />
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

export default function Sidebar({ onSelectPlaylist, selectedPlaylistId, refreshTrigger, selectedTrack, showArtwork, highlightedPlaylistId, onPlaylistsChanged }: SidebarProps) {
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

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false);

  // Inline rename state
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<PlaylistNode | null>(null);

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

  const { tagdeckTree, itunesTree } = useMemo(() => {
      const map = new Map<string, PlaylistNode>();
      const tagdeckRoots: PlaylistNode[] = [];
      const itunesRoots: PlaylistNode[] = [];

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
          } else {
              // Split into TagDeck vs iTunes based on persistent_id prefix
              if (p.persistent_id.startsWith('TD-')) {
                  tagdeckRoots.push(node);
              } else {
                  itunesRoots.push(node);
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
      return { tagdeckTree: tagdeckRoots, itunesTree: itunesRoots };
  }, [playlists]);

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

        {tagdeckTree.length > 0 ? (
          <>
            {tagdeckTree.map(node => (
              <PlaylistRow
                  key={node.persistent_id}
                  node={node}
                  level={0}
                  expandedFolders={expandedFolders}
                  selectedPlaylistId={selectedPlaylistId}
                  onSelectPlaylist={onSelectPlaylist}
                  toggleFolder={toggleFolder}
                  scrollRef={scrollRef}
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
              No TagDeck playlists yet
          </div>
        )}

        {/* iTunes Playlists Section */}
        {itunesTree.length > 0 && (
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
                marginTop: tagdeckTree.length > 0 ? '16px' : '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              {itunesCollapsed ? (
                <ChevronRight size={12} style={{ minWidth: 12, flexShrink: 0 }} />
              ) : (
                <ChevronDown size={12} style={{ minWidth: 12, flexShrink: 0 }} />
              )}
              <span>iTunes Playlists</span>
            </div>

            {!itunesCollapsed && itunesTree.map(node => (
              <PlaylistRow
                  key={node.persistent_id}
                  node={node}
                  level={0}
                  expandedFolders={expandedFolders}
                  selectedPlaylistId={selectedPlaylistId}
                  onSelectPlaylist={onSelectPlaylist}
                  toggleFolder={toggleFolder}
                  scrollRef={scrollRef}
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
      </div>
      
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
                      <button className="ctx-item" onClick={() => { setContextMenu(null); onStartRename(contextMenu.node!); }}>
                          <Pencil size={14} /> Rename
                      </button>
                      {!contextMenu.node.is_folder && (
                          <button className="ctx-item" onClick={() => { setContextMenu(null); handleDuplicate(contextMenu.node!); }}>
                              <Copy size={14} /> Duplicate
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
                      {deleteTarget.origin === 'itunes' 
                          ? `Are you sure you want to remove "${deleteTarget.name}" from TagDeck? This will not delete it from Apple Music.`
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
