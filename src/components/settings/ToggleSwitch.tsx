interface ToggleSwitchProps {
    checked: boolean;
    onChange: () => void;
}

export function ToggleSwitch({ checked, onChange }: ToggleSwitchProps) {
    return (
        <button
            onClick={onChange}
            style={{
                width: '40px', height: '22px',
                background: checked ? 'var(--accent-color)' : 'var(--bg-secondary)',
                borderRadius: '11px', position: 'relative',
                border: '1px solid var(--border-color)', cursor: 'pointer',
                transition: 'background 0.2s', padding: 0
            }}
        >
            <div style={{
                width: '18px', height: '18px', background: 'white', borderRadius: '50%',
                position: 'absolute', top: '1px',
                left: checked ? '19px' : '1px',
                transition: 'left 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
            }} />
        </button>
    );
}
