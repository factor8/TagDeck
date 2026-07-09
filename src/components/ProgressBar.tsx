export function ProgressBar({ value, label }: { value: number; label: string }) {
    return (
        <div style={{ marginTop: '12px' }}>
            <div style={{ height: '6px', background: 'var(--bg-secondary)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ width: `${value}%`, height: '100%', background: 'var(--accent-color)', transition: 'width 0.2s' }} />
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '5px' }}>{label}</div>
        </div>
    );
}
