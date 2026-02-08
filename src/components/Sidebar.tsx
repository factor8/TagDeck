import { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useDroppable } from '@dnd-kit/core';
import { Playlist, Track } from '../types';
import { ChevronRight, ChevronDown, Folder, ListMusic } from 'lucide-react';

interface SidebarProps {
  onSelectPlaylist: (id: number | null) => void;
  selectedPlaylistId: number | null;
  refreshTrigger?: number;
  selectedTrack?: Track | null;
  showArtwork?: boolean;
  highlightedPlaylistId?: number | null;
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
}: PlaylistRowProps) => {
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
    const paddingLeft = 16 + (level * 16);

    return (
        <div key={node.persistent_id}>
              <div 
                  ref={(el) => {
                      setNodeRef(el);
                      if (isSelected) scrollRef(el);
                  }}
                  onClick={() => {
                      if (node.is_folder) {
                          toggleFolder(node.persistent_id);
                      } else {
                          onSelectPlaylist(node.id);
                      }
                  }}
                  className={isHighlighted ? 'flash-highlight' : ''}
                  style={{
                      padding: `6px 16px 6px ${paddingLeft}px`,
                      fontSize: '13px',
                      cursor: 'default',
                      backgroundColor: isSelected 
                        ? 'var(--accent-color)' 
                        : (isOver ? 'rgba(59, 130, 246, 0.3)' : 'transparent'),
                      color: isSelected ? '#fff' : 'var(--text-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      userSelect: 'none',
                      transition: 'background-color 0.2s ease',
                      // Override transition if highlighted to allow flash
                  }}
                  onMouseEnter={(e) => {
                      if (!isSelected && !isOver && !isHighlighted) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)';
                  }}
                  onMouseLeave={(e) => {
                       if (!isSelected && !isOver && !isHighlighted) e.currentTarget.style.backgroundColor = 'transparent';
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
                        />
                      ))}
                  </div>
              )}
        </div>
    );
};

export default function Sidebar({ onSelectPlaylist, selectedPlaylistId, refreshTrigger, selectedTrack, showArtwork, highlightedPlaylistId }: SidebarProps) {
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

  useEffect(() => {
    loadPlaylists();
  }, [refreshTrigger]);

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
          node.scrollIntoView({ block: 'center' });
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

  const playlistTree = useMemo(() => {
      const map = new Map<string, PlaylistNode>();
      const roots: PlaylistNode[] = [];

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
              roots.push(node);
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

      sortNodes(roots);
      return roots;
  }, [playlists]);



  return (
    <div className="no-select" style={{
      width: '100%',
      minWidth: '100px', // Handled by Panel now
      maxWidth: '100%',
      height: '100%',
      backgroundColor: 'var(--bg-secondary)', 
      // borderRight: '1px solid var(--border-color)', // Handled by Panel Resize Handle
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
      
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <div 
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
        
        <div style={{ 
          padding: '12px 16px 4px', 
          fontWeight: 600, 
          fontSize: '11px',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginTop: '8px'
        }}>
          Playlists
        </div>

        {playlistTree.map(node => (
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
          />
        ))}
      </div>
      
      {showArtwork && selectedTrack && (
          <SidebarArtwork track={selectedTrack} />
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
