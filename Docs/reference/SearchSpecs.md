# Search Specifications

This document outlines the advanced search syntax and filtering logic for TagDeck.

> **Ground truth**: This spec reflects the shipped implementation in
> `src/utils/searchParser.ts` (tokenizer + parser) and the filter loop in
> `src/components/TrackList.tsx`. The in-app **Search Syntax** popover
> (`src/components/SearchHelpPanel.tsx`) is the user-facing summary of the same
> behavior. Only syntax that actually filters correctly is documented as
> supported; parsed-but-non-functional syntax is called out explicitly below.

## Overview
The search bar supports advanced query syntax to allow precise filtering of the music library. It supports exact phrases, field-specific searches, implicit AND, negation, per-field comma OR, and BPM numeric ranges.

## Syntax

### 1. Basic Text Search
*   **Behavior**: Terms separated by spaces are treated as an implicit **AND**.
*   **Example**: `house party` matches tracks containing both "house" AND "party".
*   **Searched fields**: free-text terms match against a concatenation of
    **title, artist, album, comment/tags (`comment_raw`), grouping (`grouping_raw`), and BPM**.
    Note there is no dedicated genre or key field on a track, so those are not searched.

### 2. Exact Phrases
*   **Syntax**: Double quotes `""`.
*   **Behavior**: Quotes let a value contain spaces; the quoted string is matched as a
    substring (case-insensitive `includes`).
*   **Example**: `"deep house"` matches "Deep House" but not "Deep Blue House".

### 3. Negation (Exclusion)
*   **Syntax**: Minus sign `-` prefix.
*   **Behavior**: Excludes tracks matching the term. Works on plain terms and on field
    filters (e.g. `-tag:vocal`).
*   **Example**: `techno -minimal` matches "techno" but excludes tracks with "minimal".

### 4. Field-Specific Filtering
*   **Syntax**: `field:value` (no space after colon). Unrecognized `field:value` is
    treated as plain free text.
*   **Supported (working) fields**:
    *   `artist:`
    *   `title:`
    *   `album:`
    *   `tag:` — matches the track's tags (stored in `comment_raw` after the ` && ` separator).
    *   `label:` — matches the **grouping** field (`grouping_raw`).
*   **Example**: `artist:Prince title:"Purple Rain"`

#### Comma-separated OR within a field (tags)
*   **Syntax**: `tag:ValueA,ValueB`
*   **Behavior**: A comma inside a `tag:` value is **OR** — the track matches if it has
    *any* of the listed tags.
*   **Example**: `tag:Ambient,Downtempo` matches tracks tagged Ambient **or** Downtempo.

### 5. Numeric Ranges (BPM)
*   **Syntax**:
    *   Exact: `bpm:124`
    *   Greater than: `bpm:>120`   (also `bpm:>=120`)
    *   Less than: `bpm:<130`      (also `bpm:<=130`)
    *   Range: `bpm:120-130`
*   **Supported field**: `bpm` only.
*   **Example**: `bpm:120-126`

## Parsed but NOT yet functional
The parser recognizes the following fields, but the filter loop does **not** resolve
them to any track data. Because an unmatched required filter fails the track, using these
(un-negated) currently **excludes every track**. Do not present these as working:

*   **`year:`** — accepted as a numeric field by the parser, but `TrackList.tsx` only maps
    `bpm`; the `year` branch is commented out and `Track` has no `year` property.
*   **`key:`** — accepted as a string field, but the filter resolves it to `undefined`
    (no musical-key data on the track), so nothing matches.
*   **`genre:`** — accepted as a string field, but there is no `genre` case in the filter
    switch and no `genre` property on `Track`, so it falls through to no match.
    (The in-app help panel still lists a `genre:` badge; that badge is aspirational and
    does not currently filter.)

## Logic & Precedence
1.  **Tokenization**: The query is split into tokens (words, quoted phrases, field filters).
    Quotes suppress space-splitting so a quoted value stays one token.
2.  **Filtering**: A track must match **ALL** conditions (implicit AND across tokens).
    *   Multiple filters on the *same* field (e.g. `tag:warm tag:vocal`) are separate
        conditions, so the effect is **AND** (must satisfy both).
    *   Within a single `tag:` value, commas are **OR** (see above).
    *   Free-text terms check against the concatenated text fields listed in §1.

## Future Considerations
*   Wire up `genre:`, `key:`, and `year:` (currently parsed-only).
*   Explicit grouped `OR` operator, e.g. `(house OR techno)`, across arbitrary fields.
    (Only comma-OR within `tag:` ships today.)
*   Regular expressions `regex:`.
