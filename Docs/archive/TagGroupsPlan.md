# Tag Groups Implementation Plan

## 1. Overview
The Tag Groups feature allows users to organize their tags into distinct, non-overlapping categories (e.g., "Instruments", "Styles"). This enhances the tag selection experience by reducing clutter and providing structure.

**Key Requirements:**
- Create, rename, delete, and reorder groups.
- A tag can belong to only one group.
- Drag-and-drop support for moving tags between groups.
- Tags not assigned to a specific group appear in an "Uncategorized" section (default).
- Groups are collapsible in the UI.

## 2. Data Structure & Persistence (Backend)

The application uses a SQLite database (`src-tauri/src/db.rs`). We will extend the existing schema.

### 2.1 Database Schema Changes
1.  **New Table: `tag_groups`**
    ```sql
    CREATE TABLE IF NOT EXISTS tag_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        position INTEGER DEFAULT 0  -- To store display order
    );
    ```

2.  **Modify Table: `tags`**
    Add a foreign key column to the existing `tags` table.
    ```sql
    ALTER TABLE tags ADD COLUMN group_id INTEGER REFERENCES tag_groups(id) ON DELETE SET NULL;
    ```
    *   `group_id` stores the ID of the group the tag belongs to.
    *   If `group_id` is `NULL`, the tag is considered "Uncategorized".
    *   `ON DELETE SET NULL` ensures that if a group is deleted, its tags simply become uncategorized rather than being deleted.

### 2.2 Backend Commands (Rust)
We need to expose new Tauri commands in a suitable module (e.g., `src-tauri/src/commands.rs` or a new `tag_groups.rs`).

#### Data Models (Rust)
```rust
struct TagGroup {
    id: i64,
    name: String,
    position: i64,
}

// Update Tag struct
struct Tag {
    id: i64,
    name: String,
    usage_count: i64,
    group_id: Option<i64>, // New field
}
```

#### API Methods
1.  `get_tag_groups() -> Vec<TagGroup>`: Fetch all groups sorted by `position`.
2.  `create_tag_group(name: String) -> Result<TagGroup>`: Create a new group.
3.  `update_tag_group(id: i64, name: String) -> Result<()>`: Rename.
4.  `delete_tag_group(id: i64) -> Result<()>`: Remove group. Tags become uncategorized.
5.  `set_tag_group(tag_id: i64, group_id: Option<i64>) -> Result<()>`: Move a tag to a group (or ungroup it).
6.  `reorder_tag_groups(ordered_ids: Vec<i64>) -> Result<()>`: Update `position` for list of groups.

## 3. Frontend Implementation (React)

### 3.1 Data Types (`src/types.ts`)
Update existing interfaces:
```typescript
interface TagGroup {
    id: number;
    name: string;
    position: number;
}

interface Tag {
    id: number;
    name: string;
    usageCount: number;
    groupId?: number; // New field
}
```

### 3.2 UI Components

#### `TagList` / `TagCloud` Refactor
The current list of tags needs to be segmented.
- **State**: Needs to hold `groups` (array of `TagGroup`) and `tags` (array of `Tag`).
- **Derived State**: A helper to organize tags into a structure like:
    ```typescript
    {
        uncategorized: Tag[],
        [groupId: number]: Tag[]
    }
    ```

#### Drag functionality
- Use `@dnd-kit` (or similar library if already present, or native API) to allow:
    - Draggable Tags.
    - Droppable Groups (headers/areas).
- **Interactions**:
    - Dragging a tag from "Uncategorized" to "Instruments".
    - Dragging a tag from "Instruments" to "Styles".
    - (Nice to have) Reordering groups via drag-and-drop.

#### Group Management UI
- **Add Group**: A button (probably near usage headers) to "Create Group".
- **Edit/Delete**: A small menu (three dots) on each group header to Rename or Delete.
- **Collapse/Expand**: Group headers should be clickable to toggle visibility of their tags.

### 3.3 Visual Hierarchy
- **Uncategorized**: Always at the top (or configurable). Default state for tags.
- **Groups**: Rendered below Uncategorized, sorted by user preference (position).
- **Visuals**: Distinct styling for Group Headers vs Tag items.

## 4. Implementation Steps
1.  **Backend**: modify `db.rs` schema initialization to add `tag_groups` and alter `tags`.
2.  **Backend**: Implement the CRUD commands for groups and tag assignment.
3.  **Frontend**: Update API service to call these new commands.
4.  **Frontend**: Build the `TagGroup` components and integrate DnD.
5.  **Migration**: Ensure existing tags automatically appear in "Uncategorized" (implied by `NULL` group_id).
