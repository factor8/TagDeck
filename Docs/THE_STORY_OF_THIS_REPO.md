# The Story of TagDeck

## The Chronicles: A Year in Numbers

In the span of just **10 days**, from January 30 to February 9, 2026, a solo developer transformed an idea into a fully functional music management application through **149 commits** of relentless iteration.

**The Numbers Tell a Story:**
- **Total Commits:** 149 (100% within the last year)
- **Lines of Code:** ~11,712 across 35 source files
- **Primary Languages:** Rust (50%), TypeScript (40%), Swift (10%)
- **Commit Velocity:** 14.9 commits per day average
- **Peak Day:** February 1, 2026 - 66 commits (44% of all commits in a single day)
- **Feature Commits:** 22 (15%)
- **Bug Fixes:** 16 (11%)
- **Peak Coding Hours:** 11 PM (20 commits), followed by 2 PM (13 commits)
- **Current Version:** 0.1.2

This isn't a leisurely side project. This is **sprint development**—the kind of focused intensity that happens when a developer has a clear vision and the skills to execute it.

## Cast of Characters

### Jordan Layman - The Solo Architect

**Role:** Everything  
**Specialties:** Full-stack development, macOS platform integration, audio engineering  
**Working Style:** Night owl with afternoon bursts  
**Signature Move:** Rapid prototyping with production-quality refactoring

Jordan is the sole contributor to TagDeck, demonstrating remarkable versatility across multiple domains:

- **Systems Programmer:** Comfortable writing low-level Rust code for audio file parsing, database management, and file system watching
- **Frontend Developer:** Crafts responsive React interfaces with complex state management and advanced UI patterns
- **Platform Engineer:** Deep knowledge of macOS integration, from AppleScript automation to Swift binary compilation
- **Domain Expert:** Understanding of DJ workflows, CDJ compatibility requirements, and audio metadata standards
- **Product Designer:** Balances technical architecture with user experience considerations

**The Evidence:**
- Commits span from backend Rust modules (`metadata.rs`, `db.rs`) to frontend components (`Player.tsx`, `TrackList.tsx`)
- Authored Swift code for Music.app integration
- Wrote comprehensive documentation in parallel with code
- Maintained consistent coding conventions and commit message discipline
- Shows pattern of implementing features, then immediately fixing edge cases

**Working Rhythm:**
Jordan's commit timestamps reveal a dedicated developer with a **bimodal schedule**:
- **Late Night Sessions (10 PM - 1 AM):** 40 commits during these hours, suggesting deep focus work when distractions are minimal
- **Afternoon Bursts (12 PM - 4 PM):** 39 commits, indicating productive mid-day coding sessions
- **Minimal Early Morning Activity:** Only 13 commits before 10 AM—not a morning person

## Seasonal Patterns

### The 10-Day Sprint (January 30 - February 9, 2026)

**Week 1: Foundation and Fury**

**January 30 (Day 1):** Genesis - 2 commits
- Project initialization
- Product Requirements Document
- The vision is established

**February 1 (Day 3):** The Big Bang - 66 commits (44% of entire repository)
This was the day everything came together. The commit log shows a developer in the zone:
- Morning: Core architecture and database setup
- Afternoon: Player implementation, tag editor, sidebar
- Evening: Advanced search, keyboard shortcuts, UI polish
- Night: Bug fixes, state management, final touches

66 commits in a single day suggests approximately 12-14 hours of sustained development—the kind of marathon session that builds the skeleton and organs of an application.

**February 2 (Day 4):** Consolidation - 18 commits
- Bug fixes from the previous day's sprint
- Real-time sync implementation
- First version bump to 0.1.2
- Stability improvements

**February 3-6:** The Quiet Period - 0 commits
A necessary pause. After the intensity of February 1-2, Jordan takes time away from the keyboard. This could be:
- Testing and dogfooding the application
- Planning next features
- Simply recovering from the sprint

**February 7 (Day 9):** Return - 14 commits
- Focus on real-time library monitoring
- AppleScript integration enhancements
- Metadata viewer feature
- Developer tooling improvements

**February 8 (Day 10):** Polish Phase - 45 commits
The second-largest commit day reveals a shift in focus:
- Player stability (race conditions, mode switching bugs)
- Audio decoding fallbacks
- UI refinements
- Edge case handling
- Logging infrastructure

**February 9 (Day 11):** Ongoing - 4 commits
- Final player bug fixes
- Waveform display issues
- Production-ready polish

### Activity Heatmap

**By Month:**
- January 2026: 2 commits (project start on Jan 30)
- February 2026: 147 commits (98.7% of all work)

**By Day of Week (inferred):**
- Saturday (Feb 1): 66 commits - The Marathon
- Sunday (Feb 2): 18 commits - The Cleanup
- Friday (Feb 7): 14 commits - The Return
- Saturday (Feb 8): 45 commits - The Polish

The pattern is clear: **weekends are for building**. Intense Saturday sessions followed by Sunday consolidation.

## The Great Themes

### Theme 1: The Battle of the Player (39 commits on Player.tsx)

The audio player component is the second most-changed file in the repository, and recent commits reveal a saga of persistence:

**The Challenge:**
- Initial player worked but had race conditions
- Mode switching (standard/waveform) caused crashes
- Web Audio API decoding failures for certain MP3s
- Play/pause state getting out of sync
- Spacebar triggering multiple players simultaneously

**The Journey:**
- First implementation: Basic playback with WaveSurfer
- Crisis: WaveSurfer DOM manipulation conflicting with React
- Solution attempt 1: Separate DOM containers (Feb 8)
- Issue discovered: Ghost players from stale references
- Solution attempt 2: Explicit play/pause controls (Feb 8)
- Issue discovered: Standard mode broken
- Solution attempt 3: Separate waveform sub-div (Feb 9)
- Issue discovered: User pause triggers canplay re-play
- Solution attempt 4: Add userPausedRef safety flag (Feb 9)
- Current state: Stable with fallback path for decode failures

**The Lesson:**
Building a robust audio player with dual modes (waveform visualization vs. simple scrub bar) while managing React's lifecycle and external libraries' DOM manipulation is **hard**. Jordan's persistence through multiple iterations shows professional debugging discipline.

### Theme 2: The Sync Saga (Real-Time Library Monitoring)

**The Vision:**
Automatic synchronization between Apple Music edits and TagDeck without manual re-imports.

**Evolution:**
1. **Initial state:** Manual library XML imports only
2. **Phase 1:** Add file system watcher for library changes (Feb 2)
3. **Phase 2:** Implement debounced sync triggers (Feb 2)
4. **Phase 3:** AppleScript delta queries for only changed tracks (Feb 2)
5. **Phase 4:** Playlist membership sync (Feb 2)
6. **Refinement:** Fix phantom syncs from duplicates (Feb 2)
7. **Polish:** Reduce watcher log noise (Feb 7)

**The Impact:**
The commit messages show Jordan catching edge cases:
- "Fix phantom playlist syncs caused by duplicates and ordering"
- "filter playlist tracks against DB to prevent infinite sync loops"
- "include playlist changes in total synced count"

This is the difference between a feature that "works" and a feature that's **production-ready**.

### Theme 3: The Tag Format Wars (CDJ Compatibility)

The PRD establishes a clear requirement: tags must be **CDJ-searchable**. This drives major architectural decisions:

**The Format:**
`{Original Comment} && {Tag1}; {Tag2}; {Tag3}`

**The Rationale:**
- Pioneer CDJs can search Comment fields
- Semicolon delimiters work on hardware displays
- The `&&` separator preserves existing metadata (like Mixed In Key energy ratings)
- Capital case enforced for consistency

**Implementation Challenges:**
- Parsing existing comments without data loss
- Case-insensitive deduplication
- Normalization rules (no underscores, brackets, or hashes)
- Writing to ID3 tags via Lofty library

The verify_tags binary in the codebase suggests Jordan built testing tools to ensure metadata correctness—professional engineering practice for a solo developer.

### Theme 4: TrackList.tsx - The Heart of the App (51 commits)

With 51 modifications, the track list is the most battle-tested component:

**Complexity Factors:**
- Virtual scrolling for large libraries (thousands of tracks)
- Sortable, resizable, reorderable columns
- Inline editing for metadata fields
- Selection state management
- Keyboard navigation
- Drag-and-drop to playlists
- Context menus
- Star ratings
- BPM display
- File location links

**Evolution Visible in Commits:**
- Early: Basic table rendering
- Mid: Add column customization and persistence
- Late: Inline editing, undo/redo, selection jumping fixes
- Polish: Prevent text selection in settings, align header heights

The high change count isn't chaos—it's **incremental refinement** of the application's central UI.

## Plot Twists and Turning Points

### Turning Point 1: "100% vibe coded by Gemini 3"

The README includes this intriguing tagline, suggesting Jordan used AI pair programming throughout development. This context reframes the 10-day timeline:

- **Human + AI collaboration** explains the breadth of implementation
- Rapid prototyping with AI scaffolding, then human refinement
- The multiple iterations on Player.tsx show AI can generate code, but **humans debug reality**
- Documentation quality (PRD, changelog, key commands) suggests AI assistance with prose

This isn't "AI wrote my app"—it's **"AI accelerated my vision."** Jordan still made every architectural decision, caught every edge case, and refined every interaction.

### Turning Point 2: The Logging Infrastructure (Feb 7-8)

Around February 7, something changed. Jordan added:
- Persistent logging to `~/Library/Logs/TagDeck/`
- Debug mode toggle
- Log rotation (5 MB limit, 5 files)
- Frontend-to-backend logging bridge
- Logs window with filtering

**Why This Matters:**
This is the moment TagDeck transitions from **personal tool** to **shareable application**. Persistent logging means:
- Users can report bugs with evidence
- Support becomes possible
- Professional macOS conventions followed
- Preparation for distribution

The timing (after the main feature sprint) suggests Jordan is thinking about **other people using this**.

### Turning Point 3: The Icon Journey

The commit log shows **two** icon implementations:
1. Initial generated icon (Day 2)
2. "New app icon — broken-lines hexagon design" (Feb 1)

Five icon files were changed multiple times, suggesting iteration on branding. For a solo developer, this attention to visual identity indicates **pride of creation** and intent to share publicly.

## The Current Chapter

### Where We Stand (February 10, 2026)

TagDeck is in **late alpha / early beta** state:

**Strengths:**
- Core functionality complete and working
- Production-quality logging and error handling
- Comprehensive documentation
- Real-time sync implemented and refined
- CDJ-compatible metadata format
- Professional commit history and code organization

**Active Development:**
- Player stability still being hardened
- Edge cases being discovered through use
- UI polish ongoing
- Performance optimization opportunities
- Mixed In Key integration planned

**What's Next (inferred from commit patterns):**
1. **Public Beta:** The logging infrastructure suggests preparation for external users
2. **Performance Tuning:** Large library handling mentioned but not yet stress-tested
3. **Feature Completion:** Mixed In Key integration plan just added
4. **Distribution:** No commits about signing, notarization, or DMG creation yet

### The Human Story

What makes this repository compelling isn't the technology stack—it's the **intensity of creation**. Jordan built a non-trivial desktop application with:
- Native macOS integration
- Real-time file watching
- Audio metadata manipulation
- Database management
- Complex UI state
- Drag-and-drop interactions
- Audio playback with waveform visualization
- Advanced search parsing

...in **10 days**.

This is what happens when:
1. A developer has **deep domain knowledge** (DJ workflows, CDJ quirks, audio metadata)
2. They have a **clear vision** (the PRD written on Day 1)
3. They have **modern tools** (AI assistance, mature frameworks, fast build systems)
4. They **commit fully** (66 commits in one day is not casual tinkering)

### The Vibe

Reading through the commits chronologically, you can feel the **developer's emotional journey**:

- **Day 1:** Excitement and planning
- **Day 3:** Explosive productivity and flow state
- **Day 4:** Satisfaction and bug fixing
- **Days 5-6:** Breathing and reflection
- **Day 9:** Return with fresh perspective
- **Day 10:** Renewed intensity and refinement
- **Day 11:** Stubborn debugging (player issues persist)
- **Day 12 (today):** Documentation and planning (Mixed In Key integration)

The commit messages evolve from terse labels ("feat: implement X") to detailed explanations with bullet points ("fix: player mode toggle crash and playback stop bugs" with 6 sub-bullets). This shows Jordan learning what future-Jordan (and potential contributors) will need to understand the code.

## Epilogue: What This Repository Teaches Us

1. **Solo doesn't mean simple:** One person can build complex software with modern tools
2. **AI is a multiplier, not a replacement:** Gemini helped, but humans still debug reality
3. **Sprint wisely:** 66 commits in one day works when you have clear architecture
4. **Document obsessively:** The PRD, changelog, and key commands file are as valuable as the code
5. **Iterate ruthlessly:** Player.tsx has 39 commits because perfection is iterative
6. **Own your domain:** Jordan's DJ knowledge drives every design decision
7. **Commit frequently:** Small commits create a readable history
8. **Night owls build great things:** Some of us code best after 10 PM

TagDeck is more than a music tagger—it's a **testament to focused creation**. In an era of sprawling codebases and endless meetings, here's proof that one person with vision, skill, and Gemini 3 can build something real in 10 days.

The story isn't finished. The latest commit added Mixed In Key integration plans, showing Jordan is thinking about the next evolution. That's the mark of a developer who **cares about the details**—and that's what separates good software from great software.

---

*Analysis based on 149 commits spanning January 30 - February 10, 2026*  
*Last update: February 10, 2026*  
*Status: Active development continues*
