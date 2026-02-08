import React, { useState } from 'react';

interface StarRatingProps {
    value: number; // 0-100
    onChange: (newValue: number) => void;
    readonly?: boolean;
}

export const StarRating: React.FC<StarRatingProps> = ({ value, onChange, readonly = false }) => {
    const [hoverValue, setHoverValue] = useState<number | null>(null);

    const stars = 5;
    const displayValue = hoverValue !== null ? hoverValue : value;

    const handleClick = (index: number) => {
        if (readonly) return;
        const newValue = (index + 1) * 20;
        // If clicking the current value, maybe clear it? iTunes doesn't do that easily usually.
        // But let's allow setting to 0 if they click slightly to left? No, let's keep it simple.
        // To clear, maybe we implement a "click again to clear" logic or just external clear.
        // For now: set to value.
        // Actually, if value is already X and we click X, maybe set to 0?
        if (value === newValue) {
            onChange(0);
        } else {
            onChange(newValue);
        }
    };

    return (
        <div 
            style={{ display: 'inline-flex', cursor: readonly ? 'default' : 'pointer' }}
            onMouseLeave={() => setHoverValue(null)}
        >
            {[...Array(stars)].map((_, index) => {
                const starValue = (index + 1) * 20;
                // Use >= logic for filled state
                const filled = starValue <= displayValue;
                
                return (
                    <span 
                        key={index}
                        onClick={(e) => {
                            e.stopPropagation();
                            handleClick(index)
                        }}
                        onMouseEnter={() => !readonly && setHoverValue(starValue)}
                        style={{ 
                            color: filled ? 'var(--accent-color)' : '#444', 
                            fontSize: '14px',
                            lineHeight: '1',
                            marginRight: '1px' 
                        }}
                    >
                        {filled ? '★' : '☆'}
                    </span>
                );
            })}
        </div>
    );
};
