


# Project Context and Coding Guidelines

This project is a MacOS desktop application for managing and playing local music files with tagging capabilities. The application is built using Tauri and React. Key features include Apple Music playlist ingestion, audio playback, and a tag-based organization system that writes to the metadata of audio files.

## Protocols and Standards

- Follow best practices for Tauri and React development.
- Commit often with clear, descriptive messages.
- Update documentation alongside code changes.
- Update changelogs for user-facing changes. Ask before updating version numbers.
- Do not be verbose. Do not explain code to the user. Conserve tokens when possible.
- Subtask agents liberally.

## User Tasks

`USER_TASKS.md` (repo root) tracks things **Jordan** must do himself — manual tests, model downloads, external setup, decisions — not the agent's code work.

- Read it when starting a session and when picking up related work.
- Add a task whenever something surfaces that only Jordan can do; check it off when he confirms it's done.
- Remind Jordan of open items when they're relevant, and at natural stopping points.
- If **🔴 Blocking** is non-empty and the current work depends on one of those items, surface it and pause before proceeding.
- Date each item `(YYYY-MM-DD)`. Keep everything in that one file — don't build tooling around it.

## User Experience and Design

- Always prioritize a clean, intuitive user interface.
- Weave new features seamlessly into the existing design language.
- Ensure accessibility standards are met.

## Logging and Error Handling

- Implement comprehensive logging for debugging and user support.
- Handle errors gracefully with user-friendly messages.
- Validate user inputs to prevent crashes or data corruption.

## Performance Considerations

- Profile and address performance bottlenecks regularly.

# Misc

- "Apple Music" and "iTunes" refer to the same program. I will probably say itunes more.

# Final Note

Thank you for all your help on this project! Your contributions have been great!
