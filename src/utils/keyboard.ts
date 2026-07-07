// Types where the spacebar types a character (or the field otherwise owns
// text editing). Checkboxes, radios, ranges, buttons, etc. are deliberately
// absent: focus on those must not swallow global shortcuts like
// space-to-play-pause.
const TEXT_INPUT_TYPES = new Set([
    'text', 'search', 'url', 'email', 'password', 'number', 'tel',
    'date', 'time', 'datetime-local', 'month', 'week',
]);

/** True when the focused element is a real text-entry surface. */
export function isTextEntryFocused(): boolean {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
    return false;
}
