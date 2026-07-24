import { createContext, useContext } from 'react';

// The droppable id (e.g. `playlist-12` or `builder-no-target`) that has been
// hovered long enough by a track drag to be "armed" for an add, or null.
// Provided by App; consumed by add targets (sidebar rows, Build pane) to show a
// "release to add" state distinct from the plain hover ("hold to add…") state.
export const DragArmContext = createContext<string | null>(null);

export const useArmedDroppableId = () => useContext(DragArmContext);
