import { useState, useCallback, useEffect, useRef } from 'react';
import { Activity } from 'lucide-react';

export function BpmCounter() {
    const [taps, setTaps] = useState<number[]>([]);
    const [bpm, setBpm] = useState<number | null>(null);
    const [showNumbers, setShowNumbers] = useState(false);
    const [isDull, setIsDull] = useState(false);
    const [isButtonDull, setIsButtonDull] = useState(false);
    
    const idleTimeoutRef = useRef<number | null>(null);
    const dullTimeoutRef = useRef<number | null>(null);
    const hideTimeoutRef = useRef<number | null>(null);

    const resetTimers = () => {
        if (idleTimeoutRef.current) window.clearTimeout(idleTimeoutRef.current);
        if (dullTimeoutRef.current) window.clearTimeout(dullTimeoutRef.current);
        if (hideTimeoutRef.current) window.clearTimeout(hideTimeoutRef.current);
        
        setIsDull(false);
        setIsButtonDull(false);
        
        // Start idle timer (3 seconds) to hide numbers
        idleTimeoutRef.current = window.setTimeout(() => {
            setShowNumbers(false);
        }, 3000);

        // Start dull timer (10 seconds) to fade BPM
        dullTimeoutRef.current = window.setTimeout(() => {
            setIsDull(true);
        }, 10000);

         // Start hide timer (30 seconds) to remove BPM and dull button
        hideTimeoutRef.current = window.setTimeout(() => {
            setBpm(null);
            setIsButtonDull(true);
        }, 30000);
    };

    const handleTap = useCallback(() => {
        const now = Date.now();
        setShowNumbers(true);
        resetTimers();

        setTaps(prev => {
            // If we have 4 taps already, this is the 5th tap (start of new cycle)
            if (prev.length >= 4) {
                // Don't clear BPM here, keep it visible
                return [now];
            }

            // Check if it's been too long since last tap (e.g. > 3 seconds), reset 
            if (prev.length > 0 && now - prev[prev.length - 1] > 3000) {
                // Don't clear BPM here either
                return [now];
            }
            
            const newTaps = [...prev, now];
            
            // Calculate BPM on the 4th tap
            if (newTaps.length === 4) {
                const intervals = [];
                for (let i = 1; i < newTaps.length; i++) {
                    intervals.push(newTaps[i] - newTaps[i-1]);
                }
                const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
                if (avgInterval > 0) {
                    const calculatedBpm = Math.round(60000 / avgInterval);
                    setBpm(calculatedBpm);
                    // Hide numbers when BPM is shown
                    // But maybe keep them visible for a moment?
                    // The user said: "when you complete the first set, the bpm appears and then when you have left it for a bit, the numbers slide back"
                    // This implies numbers stay for a bit.
                    // My previous logic in useEffect handles the `showNumbers` via timeout.
                    // But I just added `&& bpm === null` to the jsx style logic which hides numbers immediately if BPM is set.
                    // Let me revert that JSX change and rely on the timeout logic instead, 
                    // or handle it explicitly.
                    // If I want the numbers to slide back "after a bit", I should let the timeout do it.
                    // So I will revert the JSX change I just made.
                }
            }
            
            return newTaps;
        });
    }, []);
    
    // Clear timeouts on unmount
    useEffect(() => {
        return () => {
            if (idleTimeoutRef.current) window.clearTimeout(idleTimeoutRef.current);
            if (dullTimeoutRef.current) window.clearTimeout(dullTimeoutRef.current);
            if (hideTimeoutRef.current) window.clearTimeout(hideTimeoutRef.current);
        };
    }, []);

    const count = taps.length;

    // Anchor button style (invisible but taking space)
    const anchorBtnStyle = {
        padding: '2px 8px',
        fontSize: '11px',
        fontWeight: 'bold',
        height: '22px',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        visibility: 'hidden' as const,
        whiteSpace: 'nowrap' as const
    };

    // Real visible content
    return (
        <div style={{ position: 'relative', height: '34px', display: 'flex', alignItems: 'center', marginLeft: '8px' }}>
            {/* 
               Ghost element to reserve space in the layout for just the button part.
               We include margins/padding of the container here? 
               The outer container has margin-left: 8px.
               We want to reserve space for the "pill" in its collapsed state.
            */}
            <div style={{
               padding: '4px 8px',
               border: '1px solid transparent', // account for border width
               visibility: 'hidden',
               opacity: 0,
               pointerEvents: 'none',
               display: 'flex',
               alignItems: 'center'
            }}>
                <div style={anchorBtnStyle}>
                    <Activity size={12} />
                    TAP
                </div>
            </div>


            {/* Absolute Overlay that contains everything */}
            <div style={{ 
                position: 'absolute',
                left: 0,
                // top: '50%',
                // transform: 'translateY(-50%)',
                display: 'flex', 
                alignItems: 'center', 
                background: 'var(--bg-tertiary)',
                padding: '4px 8px',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                height: '34px',
                transition: 'all 0.3s ease',
                overflow: 'hidden',
                zIndex: 50,
                // Allow width to fit content
                width: 'max-content',
                maxWidth: 'none',
                boxShadow: showNumbers || bpm !== null ? '0 2px 8px rgba(0,0,0,0.2)' : 'none'
            }}>
                <button
                    onClick={handleTap}
                    style={{
                        background: isButtonDull ? 'var(--text-secondary)' : 'var(--accent-color)',
                        transition: 'background-color 0.5s ease',
                        border: 'none',
                        borderRadius: '4px',
                        color: '#fff',
                        cursor: 'pointer',
                        padding: '2px 8px',
                        fontSize: '11px',
                        fontWeight: 'bold',
                        height: '22px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        flexShrink: 0,
                        zIndex: 2,
                        whiteSpace: 'nowrap'
                    }}
                >
                    <Activity size={12} />
                    TAP
                </button>

                <div style={{ 
                    display: 'flex', 
                    alignItems: 'center',
                    maxWidth: showNumbers ? '100px' : '0px',
                    opacity: showNumbers ? 1 : 0,
                    overflow: 'hidden',
                    transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
                    marginLeft: showNumbers ? '8px' : '0px'
                }}>
                    <div style={{ display: 'flex', gap: '4px' }}>
                        {[1, 2, 3, 4].map(num => (
                            <div 
                                key={num}
                                style={{
                                    width: '16px',
                                    height: '16px',
                                    borderRadius: '50%',
                                    background: num <= count ? 'var(--accent-color)' : 'rgba(128,128,128,0.2)',
                                    color: num <= count ? '#fff' : 'var(--text-secondary)',
                                    fontSize: '10px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    transition: 'all 0.1s ease',
                                    fontWeight: num <= count ? 'bold' : 'normal',
                                    flexShrink: 0
                                }}
                            >
                                {num}
                            </div>
                        ))}
                    </div>
                </div>

                <div style={{
                    maxWidth: bpm !== null ? '80px' : '0px',
                    opacity: bpm !== null ? 1 : 0,
                    overflow: 'hidden',
                    transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
                    marginLeft: bpm !== null ? '8px' : '0px'
                }}>
                    <div style={{ 
                        fontSize: '12px', 
                        fontWeight: 'bold', 
                        color: isDull ? 'var(--text-secondary)' : 'var(--text-primary)',
                        minWidth: '60px',
                        whiteSpace: 'nowrap',
                        transition: 'color 1s ease'
                    }}>
                        {bpm} BPM
                    </div>
                </div>
            </div>
        </div>
    );
}
