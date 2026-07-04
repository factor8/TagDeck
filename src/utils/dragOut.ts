import { startDrag } from '@crabnebula/tauri-plugin-drag';

// Base64 of src-tauri/icons/32x32.png, used as the native drag preview icon.
const DRAG_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAE5ElEQVR42r1XS28bVRT+5j0eP+MkJglJk6YbNhURSJRHkECAuimi/6DZILHkJ/AT+AmwYolYIIHUgnhUlVhAK7ECKtomJMGx68SPGc+MZ6bnXE+mYzuJbVRyLcv2Hd97vvOd75xzr4rUKOUXbkRRtAVEG1GEEp7xkIC7kix/etja/zw1R4ZLa6XIt7+PgA2cwxBANOvtw8MHh/J5G+fBttgmf1dMxfiIJram3USRFEiShLyRhRf4/wXHQsbMP1QMPfcFR2GalbIko2jk0O255E1EvyUYio5e2JuSimhNKmQr0eRey5gxC3jcPUIYDS4zFEMwEoQB/HByRiYCwIazWgZ2r0teBmf+l4EwQ27gEshwLAD1bKr71DLNHd9BkNrQUMlQP4mEITfwxHc2zAA0WaNPhcLkiPWn2jjtgaaowmuf4trteQPGV/KLuFRchUdU8/OLxYtYyi0mz/uAXGLLh0pATDUzXQhmzDzaniM2T4/5TBnLZHynvY8Duz7wbC4zh4XsInbbu6SRwWemwo54CJmLobCMAGDaFVmBHzw1bhLd68UVtDwb263dFKA5QW7NqcUFRsJidgmWlqP/PSQWusl/s1qe0tUVQM4EYCiaiHvT6yRzz2XncOS2RNrxsDQL7114B+/SO4gk3Hx0E7e2b8Hx7VgfJnJaAXWnOlA3JmaARXSs9rJZIuPNRAObz7+GDy5do/l5ijWnnUSfwIHzGF8/+Aq/7N2O91GQ0wtouo04DBZ6kS90MZBhhp79ZCAtZBU6MXAc//XSBTQEgAAfXr5Bxt+nkGRhWhpe2VzAhfU8qv96kMIMLpdfJv3M4ff6ryRiHQvWCq2txftqCJiDIQbU8cVKSr6XaXP2enmtgJeuVJL5a9eXced2HX/+ZaNoVlI1/+laP3RFCMamIXt6nNOjaCQBgL0fHlZOFc/SgAe1lYUqqeMBcAGxUnmbxsyq4JhHpzDFAMJQOnGtG3RIA73xlZDreC8KcNIuwgD9brdHy3GL5jgjwlPCp8qGEGEwTgOcLsyCHTojXtSdOtYLMu7f72Bvz8Orr8+K+R9/auCoFQqAjW5tZN1UzUijLBAAen0AJaNENaGZNJYri5u4unodRX0+ZkQSntfJ8HfbX+K36g9JGlpUC9peI/kdTVIHuKXK9ApSYZi3KlQFW6Kx8MhoWby5dBVv0Js18fPuN7iz9y2cXicWXIaMF4mN/WSPjFoQmdAL3bMBcA3gd9trp+YMakCrsKkj7nd2ku42Y8yLz4Z7EIOXqTwvC8Xv239TOe+mQquRPoLJGWAQTuxx0qSMWSrLy6jae9RwqkMNrIKysUQVcYdCVhvSlSZA2b3DyQ8kGUrFfjmORk44FWuJmksJj5p/iCPuSv4FEeua88+QYdKTYhITLoXUn/5ExN2NeznrgWt4+oTDpVaGEqdnMNDlWHDsNbPJYTjrQKKefXyOKAy2aE46ecIAvDiu/onVUhJprFPjcYM2FaXxRzJ5klxlw10Cwp6ywlmUI6b5iK7PxqCbE50H+2wB9yY9wXIY3MABy5S7myrrIkw5rSy8b5H4wiiY5oZ0jwBIn017o2AQAbVrXTbZdVL30Uh6TQSA7omiWBezlbskkxdxjoO9P+pUN4QG6KL41jSheBbG2WZyO05dz7eiMPz4/2JDGO5fz5OwPwH7XVnjXK7UWAAAAABJRU5ErkJggg==';

let active = false;

/** True while a native (Option-drag) drag-out is in progress. */
export function isNativeDragOutActive(): boolean {
    return active;
}

/** Starts a native OS drag of the given track file(s) so they can be dropped into Finder, Mail, Rekordbox, etc. */
export function startTrackDragOut(paths: string[]): void {
    if (paths.length === 0) return;
    active = true;
    startDrag({ item: paths, icon: DRAG_ICON, mode: 'copy' }, () => {
        active = false;
    }).catch((err) => {
        active = false;
        console.error('Failed to start native drag out:', err);
    });
}
