# Search Specifications

This document outlines the advanced search syntax and filtering logic for TagDeck.

## Overview
The search bar supports advanced query syntax to allow precise filtering of the music library. It supports exact phrases, field-specific searches, logical operators, and numeric ranges.

## Syntax

### 1. Basic Text Search
*   **Behavior**: Terms separated by spaces are treated as an implicit **AND**.
*   **Example**: `house party` matches tracks containing both "house" AND "party" in any searchable field.

### 2. Exact Phrases
*   **Syntax**: Double quotes `""`.
*   **Behavior**: Matches the exact sequence of characters, including spaces.
*   **Example**: `"Deep House"` matches "Deep House" but not "Deep Blue House".

### 3. Negation (Exclusion)
*   **Syntax**: Minus sign `-` prefix.
*   **Behavior**: Excludes tracks containing the term.
*   **Example**: `techno -minimal` matches "techno" but excludes tracks with "minimal".

### 4. Field-Specific Filtering
*   **Syntax**: `field:value` (no space after colon).
*   **Supported Fields**:
    *   `artist:`
    *   `title:`
    *   `album:`
    *   `genre:`
    *   `label:` (mapped from grouping or label field if available)
    *   `tag:` (specifically searches the Comment/Tag field)
    *   `key:` (Musical key)
*   **Example**: `artist:Prince title:"Purple Rain"`

### 5. Numeric Ranges (BPM & Year)
*   **Syntax**:
    *   Exact: `bpm:124`
    *   Greater than: `bpm:>120`
    *   Less than: `bpm:<130`
    *   Range: `bpm:120-130`
*   **Supported Fields**: `bpm`, `year`.
*   **Example**: `genre:House bpm:120-126`

## Logic & Precedence
1.  **Tokenization**: The query is split into tokens (words, quoted phrases, field filters).
2.  **Filtering**: A track must match ALL conditions (implicit AND).
    *   If multiple values are provided for the *same* field (e.g. `tag:warm tag:vocal`), the behavior is **AND** (must have both tags).
    *   Free text search terms check against a concatenated string of all text fields.

## Future Considerations
*   Explicit `OR` operator `(house OR techno)`.
*   Regular expressions `regex:`.
