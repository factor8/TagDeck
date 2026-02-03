import Foundation
import iTunesLibrary

// Standard output wrapper for JSON
struct LibraryExport: Encodable {
    let tracks: [ExportTrack]
    let playlists: [ExportPlaylist]
}

struct ExportPlaylist: Encodable {
    let persistent_id: String
    let parent_persistent_id: String?
    let name: String
    let is_folder: Bool
    let track_ids: [String]
}

struct ExportTrack: Encodable {
    let persistent_id: String
    let file_path: String
    let artist: String?
    let title: String?
    let album: String?
    let comment_raw: String?
    let grouping_raw: String?
    let duration_secs: Double
    let format: String
    let size_bytes: Int64
    let bit_rate: Int64
    let modified_date: Int64
    let rating: Int
    let date_added: Int64
    let bpm: Int
}

func main() {
    do {
        // Initialize the library
        // Note: This may crash or throw if the user denies permission, 
        // or if running in an environment without TCC permissions.
        let library = try ITLibrary(apiVersion: "1.0")
        
        var exportTracks: [ExportTrack] = []
        
        let allItems = library.allMediaItems
        
        for item in allItems {
            // Filter for only music/audio files with valid locations
            guard let location = item.location else { continue }
            // Skip "File not found" or remote files if possible (location usually implies local)
            
            // Basic metadata
            let artist = item.artist?.name
            let title = item.title
            let album = item.album.title
            
            // Comments & User Grouping
            let comment = item.comments
            let grouping = item.grouping
            
            // Technical details
            let duration = Double(item.totalTime) / 1000.0 // ms to seconds
            let size = Int64(item.fileSize)
            let bitrate = Int64(item.bitrate)
            
            // Check if rating is computed (derived from Album Rating)
            // We only want explicit user ratings for individual tracks.
            var rating = item.rating
            if item.isRatingComputed {
                rating = 0
            }
            
            let dateAdded = item.addedDate?.timeIntervalSince1970 ?? 0
            let bpm = item.beatsPerMinute
            
            // Date Modified
            // ITLibMediaItem does not expose modificationDate, so we read it from the file system
            var modDate: Double = 0
            if let attributes = try? FileManager.default.attributesOfItem(atPath: location.path),
               let date = attributes[.modificationDate] as? Date {
                modDate = date.timeIntervalSince1970
            }
            
            // Persistent ID
            // ITLibMediaItemPersistentID is NSNumber (long long)
            // We convert to Hex String to match XML format typically: "D2F...12"
            // The framework returns `persistentID` as NSNumber.
            let pidNumber = item.persistentID.uint64Value
            let pidString = String(format: "%016llX", pidNumber)

            // Format extension
            let ext = location.pathExtension.lowercased()
            
            let track = ExportTrack(
                persistent_id: pidString,
                file_path: location.path, // Absolute path
                artist: artist,
                title: title,
                album: album,
                comment_raw: comment,
                grouping_raw: grouping,
                duration_secs: duration,
                format: ext,
                size_bytes: size,
                bit_rate: bitrate,
                modified_date: Int64(modDate),
                rating: rating,
                date_added: Int64(dateAdded),
                bpm: bpm
            )
            
            exportTracks.append(track)
        }
        
        // Collect Playlists
        var exportPlaylists: [ExportPlaylist] = []
        let allPlaylists = library.allPlaylists
        
        for playlist in allPlaylists {
            // Skip master library to avoid duplication
            if playlist.isMaster { continue }
            
            let pidNumber = playlist.persistentID.uint64Value
            let pidString = String(format: "%016llX", pidNumber)
            
            // Parent Persistent ID
            var parentPidString: String? = nil
            if let parent = playlist.parentID {
                parentPidString = String(format: "%016llX", parent.uint64Value)
            }
            
            // Get track Persistent IDs for this playlist
            // ITLibPlaylist.items -> [ITLibMediaItem]
            let trackIds = playlist.items.map { item in
                String(format: "%016llX", item.persistentID.uint64Value)
            }
            
            let isFolder = (playlist.kind == .folder)
            
            exportPlaylists.append(ExportPlaylist(
                persistent_id: pidString,
                parent_persistent_id: parentPidString,
                name: playlist.name,
                is_folder: isFolder,
                track_ids: trackIds
            ))
        }

        // Output JSON
        let exportData = LibraryExport(tracks: exportTracks, playlists: exportPlaylists)
        let encoder = JSONEncoder()
        // encoder.outputFormatting = .prettyPrinted // Compact matches Rust better
        
        let data = try encoder.encode(exportData)
        if let jsonString = String(data: data, encoding: .utf8) {
            print(jsonString)
        }
        
    } catch {
        // Print error to stderr so Rust can capture it distinct from stdout JSON
        fputs("Error loading iTunesLibrary: \(error)\n", stderr)
        exit(1)
    }
}

main()
