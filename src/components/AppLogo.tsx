export function AppLogo({ size = 24, color = "var(--accent-color)" }: { size?: number, color?: string }) {
    // Helper to generate equilateral hexagon points (point-up orientation)
    // Center (12, 12)
    const hex = (r: number) => {
        const cx = 12;
        const cy = 12;
        const pts = [];
        for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 180) * (60 * i - 90);
            pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
        }
        return pts.join(' ');
    };

    // Helper to get a single hex vertex
    const hv = (r: number, i: number) => {
        const a = (Math.PI / 180) * (60 * i - 90);
        return { x: 12 + r * Math.cos(a), y: 12 + r * Math.sin(a) };
    };

    // Outer hex r=9.5 dashed lines (6 edges)
    const outerEdges = Array.from({ length: 6 }, (_, i) => {
        const a = hv(9.5, i);
        const b = hv(9.5, (i + 1) % 6);
        return (
            <line key={`o${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="currentColor" strokeWidth="0.8" opacity="0.2"
                strokeDasharray="1.2 0.8" />
        );
    });

    // Mid hex r=6.5 partial segments (6 edges, slightly inset to create gaps)
    const midEdges = Array.from({ length: 6 }, (_, i) => {
        const a = hv(6.5, i);
        const b = hv(6.5, (i + 1) % 6);
        // Inset endpoints 15% from each end to create broken look
        const x1 = a.x + (b.x - a.x) * 0.1;
        const y1 = a.y + (b.y - a.y) * 0.1;
        const x2 = a.x + (b.x - a.x) * 0.85;
        const y2 = a.y + (b.y - a.y) * 0.85;
        return (
            <line key={`m${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="currentColor" strokeWidth="0.8" opacity="0.5" />
        );
    });

    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            style={{ color: color }}
            xmlns="http://www.w3.org/2000/svg"
        >
            {/* Outer hex - dashed segments */}
            {outerEdges}
            {/* Mid hex - broken segments */}
            {midEdges}
            {/* Inner solid hexagon */}
            <polygon points={hex(4)} fill="currentColor" opacity="0.85" />
            {/* Bright core hexagon */}
            <polygon points={hex(2.2)} fill="currentColor" />
        </svg>
    );
}
