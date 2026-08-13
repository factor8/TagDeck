import type { Track } from '../types';

/** Result of the `recheck_missing_files` command. */
export interface RecheckReport {
    checked: number;
    restored: number;
    relocated: number;
    still_missing: number;
    /** Set when the Music.app read failed; those tracks stay missing. */
    itunes_lookup_error: string | null;
}

/**
 * The ids a recheck would actually act on — the command ignores everything
 * that isn't flagged missing, so the UI shouldn't offer the action for them.
 */
export function recheckableIds(tracks: Track[]): number[] {
    return tracks.filter(t => t.missing).map(t => t.id);
}

/** `true` when the recheck put at least one file back. */
export function recheckFoundSomething(report: RecheckReport): boolean {
    return report.restored + report.relocated > 0;
}

/**
 * One-line summary for the toast. "Restored" = the file was back where it
 * always was; "relocated" = Music.app pointed us at its new home.
 */
export function summarizeRecheck(report: RecheckReport): string {
    if (report.checked === 0) return 'No missing files to recheck';

    const parts: string[] = [];
    if (report.restored > 0) parts.push(`${report.restored} restored`);
    if (report.relocated > 0) parts.push(`${report.relocated} relocated`);
    if (report.still_missing > 0) parts.push(`${report.still_missing} still missing`);

    let msg = `Rechecked ${report.checked} missing file${report.checked === 1 ? '' : 's'}: ${parts.join(', ')}`;
    if (report.itunes_lookup_error) msg += " — couldn't read the Music app library";
    return msg;
}
