import { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Playlist } from '../types';
import { ChevronRight, ChevronDown, Folder, ListMusic } from 'lucide-react';

interface SidebarProps {
  onSelectPlaylist: (id: number | null) => void;
  selectedPlaylistId: number | null;
  refreshTrigger?: number;
}

interface PlaylistNode extends Playlist {
    children: PlaylistNode[];
}

export default function Sidebar({ onSelectPlaylist, selectedPlaylistId, refreshTrigger }: SidebarProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [loading, setLoading] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadPlaylists();
  }, [refreshTrigger]);

  async function loadPlaylists() {
    setLoading(true);
    try {
      const data = await invoke<Playlist[]>('get_playlists');
      setPlaylists(data);
    } catch (e) {
      console.error("Failed to load playlists", e);
    } finally {
      setLoading(false);
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

  const renderNode = (node: PlaylistNode, level: number) => {
      const isExpanded = expandedFolders.has(node.persistent_id);
      const isSelected = selectedPlaylistId === node.id;
      
      const paddingLeft = 16 + (level * 16);

      return (
          <div key={node.persistent_id}>
              <div 
                  onClick={() => {
                      if (node.is_folder) {
                          toggleFolder(node.persistent_id);
                      } else {
                          onSelectPlaylist(node.id);
                      }
                  }}
                  style={{
                      padding: `6px 16px 6px ${paddingLeft}px`,
                      fontSize: '13px',
                      cursor: 'default',
                      backgroundColor: isSelected ? 'var(--accent-color)' : 'transparent',
                      color: isSelected ? '#fff' : 'var(--text-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      userSelect: 'none'
                  }}
                  onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)';
                  }}
                  onMouseLeave={(e) => {
                       if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                  }}
              >
                  {node.is_folder ? (
                      <div 
                        style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleFolder(node.persistent_id);
                        }}
                      >
                         {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </div>
                  ) : <div style={{ width: 14 }}></div>}
                  
                  {node.is_folder ? <Folder size={16} fill={isSelected ? "currentColor" : "var(--text-secondary)"} color={isSelected ? "currentColor" : "var(--text-secondary)"} /> : <ListMusic size={16} />}
                  
                  <span style={{ 
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
                      {node.children.map(child => renderNode(child, level + 1))}
                  </div>
              )}
          </div>
      );
  };

  return (
    <div style={{
      width: '250px',
      minWidth: '200px',
      maxWidth: '400px',
      height: '100%',
      backgroundColor: 'var(--bg-secondary)', // Use theme var
      borderRight: '1px solid var(--border-color)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      userSelect: 'none',
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
      
      <div style={{ flex: 1, overflowY: 'auto' }}>
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
          <div style={{ width: 14 }} /> 
          <ListMusic size={16} /> 
          <span style={{ 
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

        {playlistTree.map(node => renderNode(node, 0))}
      </div>
    </div>
  );
}
