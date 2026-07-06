// Shared style object for the player footer (LocalPlayer and SpotifyPlayer).
// Extracted to its own module so neither player component needs to import
// from the other — avoids a Player.tsx <-> SpotifyPlayer.tsx circular import.
export const playerStyles = {
    container: {
        padding: '0 20px',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        borderTop: '1px solid var(--border-color)',
        // position: 'fixed' removed to allow flex parent to manage layout space
        width: '100%',
        height: '80px',
        flexShrink: 0,
        position: 'relative' as 'relative', // Ensure z-index works
        display: 'flex',
        flexDirection: 'row' as const,
        alignItems: 'center', // Horizontal layout: Info | Controls
        justifyContent: 'space-between',
        zIndex: 100,
        boxShadow: '0 -4px 20px rgba(0,0,0,0.2)'
    },
    info: {
        fontSize: '14px',
        whiteSpace: 'nowrap' as const,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: '200px',
        maxWidth: '30%',
    },
    iconButton: {
        background: 'transparent',
        border: 'none',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        padding: '8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
    }
};
