export function AppLogo({ size = 24, color = "var(--accent-color)" }: { size?: number, color?: string }) {
    // Helper to generate hexagon points
    // Center (12, 12)
    const createHexagon = (r: number) => {
        const cx = 12;
        const cy = 12;
        const points = [];
        for (let i = 0; i < 6; i++) {
            // Start at -30 deg (330) to get point-up orientation
            const angle_deg = 60 * i - 30; 
            const angle_rad = (angle_deg * Math.PI) / 180;
            const x = cx + r * Math.cos(angle_rad);
            const y = cy + r * Math.sin(angle_rad);
            points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
        }
        return points.join(' ');
    };

    return (
        <svg 
            width={size} 
            height={size} 
            viewBox="0 0 24 24" 
            fill="none" 
            style={{ color: color }}
            xmlns="http://www.w3.org/2000/svg"
        >
            {/* Inner solid hexagon */}
            <polygon points={createHexagon(3.5)} fill="currentColor" />
            
            {/* Middle ring */}
            <polygon points={createHexagon(6.5)} stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
            
            {/* Outer ring */}
            <polygon points={createHexagon(9.5)} stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
        </svg>
    );
}
