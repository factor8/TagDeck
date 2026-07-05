export interface Track {
    id: number;
    persistent_id: string;
    file_path: string;
    artist?: string;
    title?: string;
    album?: string;
    comment_raw?: string;
    grouping_raw?: string;
    duration_secs: number;
    format: string;
    size_bytes: number;
    bit_rate: number;
    modified_date: number;
    rating: number;
    date_added: number;
    bpm: number;
    missing?: boolean;
    /** Link to the Music.app track; null = TagDeck-native or unlinked. */
    itunes_pid?: string | null;
    /** Set when a previously linked track disappeared from Music.app. */
    unlinked_at?: number | null;
    /** 'local' (has a file) or 'spotify' (ghost — no file yet). */
    source: 'local' | 'spotify';
    /** Spotify track ID; kept after merge onto the local track. */
    spotify_id?: string | null;
}

export interface Playlist {
    id: number;
    persistent_id: string;
    parent_persistent_id?: string;
    name: string;
    is_folder: boolean;
    origin: 'itunes' | 'tagdeck' | 'spotify';
    itunes_sync_enabled: boolean;
    description?: string;
    color?: string;
    sort_position: number;
    created_at: number;
    updated_at: number;
    spotify_playlist_id?: string | null;
    spotify_snapshot_id?: string | null;
}

export interface Tag {
    id: number;
    name: string;
    usage_count: number;
    group_id?: number | null;
}

export interface TagGroup {
    id: number;
    name: string;
    position: number;
}
