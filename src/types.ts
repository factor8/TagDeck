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
}

export interface Playlist {
    id: number;
    persistent_id: string;
    parent_persistent_id?: string;
    name: string;
    is_folder: boolean;
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
