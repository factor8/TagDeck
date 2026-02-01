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
    modified_date: number;
}
