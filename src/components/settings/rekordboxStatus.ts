export interface RekordboxSyncStatus {
  state: 'disabled' | 'up_to_date' | 'pending' | 'writing' | 'error';
  last_written_at: number | null;
  last_error: string | null;
  tracks: number;
  playlists: number;
}

function formatAgo(secs: number): string {
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

export function formatRekordboxStatus(s: RekordboxSyncStatus, nowSecs: number): string {
  switch (s.state) {
    case 'disabled': return 'Off';
    case 'writing': return 'Saving…';
    case 'pending': return 'Pending — updating shortly';
    case 'error': return `Error: ${s.last_error ?? 'unknown'}`;
    case 'up_to_date':
      if (s.last_written_at == null) return 'Up to date';
      return `Up to date · updated ${formatAgo(Math.max(0, nowSecs - s.last_written_at))}`;
  }
}
