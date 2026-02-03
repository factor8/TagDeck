import React, { useState } from 'react';
import { Track } from '../types';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';

interface Props {
  track: Track | null;
}

export const MetadataViewer: React.FC<Props> = ({ track }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!track) return null;

  const formatDate = (timestamp: number) => {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp * 1000).toLocaleString();
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatBitrate = (bpm: number) => {
      // note: field is named bit_rate in interface but often stores raw kb/s
      // Assuming bpm param name was copy paste error in my own logic, using track.bit_rate
      return track.bit_rate ? `${track.bit_rate} kbps` : 'Unknown';
  };

  return (
    <div style={{ 
      borderTop: '1px solid var(--border-color)',
      padding: '10px 16px',
      fontSize: '12px',
      background: 'var(--bg-tertiary)',
      color: 'var(--text-secondary)'
    }}>
      <div 
        onClick={() => setIsExpanded(!isExpanded)}
        style={{ 
          display: 'flex', 
          alignItems: 'center', 
          cursor: 'pointer',
          userSelect: 'none',
          fontWeight: 600,
          marginBottom: isExpanded ? '10px' : '0'
        }}
      >
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span style={{ marginLeft: '6px' }}>Technical Info</span>
      </div>

      {isExpanded && (
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'auto 1fr', 
          gap: '6px 16px',
          paddingLeft: '6px'
        }}>
          <Label>Title</Label> <Value>{track.title || '-'}</Value>
          <Label>Artist</Label> <Value>{track.artist || '-'}</Value>
          <Label>Album</Label> <Value>{track.album || '-'}</Value>
          <Label>Grouping</Label> <Value>{track.grouping_raw || '-'}</Value>
          <Label>Rating</Label> <Value>{track.rating || 0}</Value>
          <Label>Duration</Label> <Value>{Math.floor(track.duration_secs / 60)}:{(track.duration_secs % 60).toFixed(0).padStart(2, '0')}</Value>
          
          <div style={{ gridColumn: '1 / -1', height: '1px', background: 'var(--border-color)', margin: '4px 0' }} />
          
          <Label>ID</Label> <Value>{track.id}</Value>
          <Label>Persistent ID</Label> <Value>{track.persistent_id}</Value>
          <Label>Format</Label> <Value>{track.format?.toUpperCase()}</Value>
          <Label>Size</Label> <Value>{formatSize(track.size_bytes)}</Value>
          <Label>Bitrate</Label> <Value>{formatBitrate(track.bit_rate)}</Value>
          <Label>BPM</Label> <Value>{track.bpm || '-'}</Value>
          <Label>Date Added</Label> <Value>{formatDate(track.date_added)}</Value>
          <Label>Date Modified</Label> <Value>{formatDate(track.modified_date)}</Value>
          <Label>Missing</Label> <Value>{track.missing ? 'Yes' : 'No'}</Value>
          
          <div style={{ gridColumn: '1 / -1', height: '1px', background: 'var(--border-color)', margin: '4px 0' }} />
          
          <Label>Full Path</Label> 
          <Value style={{ wordBreak: 'break-all', fontSize: '11px', lineHeight: '1.2' }}>{track.file_path}</Value>
        </div>
      )}
    </div>
  );
};

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ fontWeight: 500, color: 'var(--text-tertiary)' }}>{children}:</span>
);

const Value: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <span style={{ color: 'var(--text-primary)', ...style }}>{children}</span>
);
