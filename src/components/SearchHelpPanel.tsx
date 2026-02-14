
import { useRef, useEffect } from 'react';
import { X, Search } from 'lucide-react';

interface SearchHelpPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

export function SearchHelpPanel({ isOpen, onClose }: SearchHelpPanelProps) {
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
                onClose();
            }
        }
        if (isOpen) {
            document.addEventListener("mousedown", handleClickOutside);
        }
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div 
            ref={panelRef}
            style={{
                position: 'absolute',
                top: '55px',
                // Position it near the center/search bar, or distinct from Settings
                left: '50%',
                transform: 'translateX(-50%)',
                width: '500px',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
                zIndex: 100,
                color: 'var(--text-primary)',
                maxHeight: '80vh',
                display: 'flex',
                flexDirection: 'column'
            }}
        >
            <div style={{ 
                padding: '16px', 
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Search size={18} color="var(--accent-color)" />
                    <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Search Syntax</h3>
                </div>
                <button 
                    onClick={(e) => { e.stopPropagation(); onClose(); }} 
                    style={{ 
                        background: 'none', 
                        border: 'none', 
                        color: 'var(--text-secondary)', 
                        cursor: 'pointer', 
                        padding: 4,
                        display: 'flex',
                        alignItems: 'center'
                    }}
                >
                    <X size={18} />
                </button>
            </div>

            <div style={{ padding: '16px', overflowY: 'auto' }}>
                <Section title="Basic Search">
                    <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        Terms are combined with AND logic. All terms must match.
                    </p>
                    <CodeExample code="house party" desc="Matches tracks with both words" />
                </Section>

                <Section title="Exact Phrases">
                    <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        Use quotes to match an exact sequence of characters.
                    </p>
                    <CodeExample code='"deep house"' desc="Matches exact phrase only" />
                </Section>

                <Section title="Exclusion">
                    <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        Prefix a term with <code>-</code> to exclude it.
                    </p>
                    <CodeExample code="techno -minimal" desc="Techno tracks without 'minimal'" />
                </Section>

                <Section title="Field Filters">
                    <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        Target specific fields with <code>field:value</code>.
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
                        <CodeBadge>artist:</CodeBadge>
                        <CodeBadge>title:</CodeBadge>
                        <CodeBadge>album:</CodeBadge>
                        <CodeBadge>genre:</CodeBadge>
                        <CodeBadge>label:</CodeBadge>
                        <CodeBadge>tag:</CodeBadge>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <CodeExample code='artist:Prince title:"Rain"' desc="Specific artist and title" />
                        <CodeExample code='tag:Ambient tag:Downtempo' desc="Multiple tags (AND logic)" />
                    </div>
                </Section>

                <Section title="Numeric Ranges (BPM)">
                    <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        Filter by BPM using ranges or comparison operators.
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <CodeExample code="bpm:120-125" desc="Between 120 and 125" />
                        <CodeExample code="bpm:>128" desc="Faster than 128 BPM" />
                    </div>
                </Section>
            </div>
        </div>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: '20px' }}>
            <h4 style={{ 
                margin: '0 0 8px', 
                fontSize: '14px', 
                fontWeight: 600,
                color: 'var(--text-primary)'
            }}>{title}</h4>
            {children}
        </div>
    );
}

function CodeExample({ code, desc }: { code: string; desc: string }) {
    return (
        <div style={{ 
            background: 'var(--bg-tertiary)', 
            padding: '8px 12px', 
            borderRadius: '6px',
            fontSize: '13px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '4px'
        }}>
            <code style={{ 
                color: 'var(--accent-color)', 
                fontFamily: 'monospace',
                fontWeight: 600 
            }}>{code}</code>
            <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>{desc}</span>
        </div>
    );
}

function CodeBadge({ children }: { children: React.ReactNode }) {
    return (
        <code style={{ 
            background: 'var(--bg-tertiary)', 
            padding: '2px 6px', 
            borderRadius: '4px',
            fontSize: '12px',
            color: 'var(--text-secondary)',
            fontFamily: 'monospace'
        }}>{children}</code>
    );
}
