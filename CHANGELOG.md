# Changelog

## Unreleased

### Changed
- Store managed Ralph state under `~/.pi/projects/<project-id>/ralph/` instead of the project directory, with migration from older in-repo locations.

## 0.2.1 - 2026-04-02

### Fixed
- Keep the current iteration number stable when resuming a paused loop.
- Restore only loops owned by the current Pi session on startup, avoiding cross-session prompt injection.
- Pause the current session loop before starting a different one, avoiding hidden concurrent session state.
- Prevent `/ralph stop`, `/ralph-stop`, and `ralph_done` from acting on loops owned by other sessions.

### Changed
- Synced README and skill instructions with the actual `ralph_start` behavior.
- Added package metadata and git ignore rules to keep local task state and temp payloads out of published artifacts and git.
- Moved project-local Ralph storage from `.ralph/` to `.pi/ralph/`, with legacy directory migration.

## 0.2.0 - 2026-04-02

### Changed
- Forked into a standalone repository folder.
- `ralph_done` now compacts and continues in the same Pi session.
- Added loop state tracking for pending post-compaction continuation.
- Updated docs to describe single-session compaction-based continuation.

## 0.1.5 - 2026-02-03

### Added
- Add preview image metadata for the extension listing.

## 0.1.4 - 2026-02-02

### Changed
- **BREAKING:** Updated tool execute signatures for Pi v0.51.0 compatibility (`signal` parameter now comes before `onUpdate`)
- **BREAKING:** Changed `before_agent_start` handler to use `systemPrompt` instead of deprecated `systemPromptAppend` (Pi v0.39.0+)

## 0.1.3 - 2026-01-26
- Added note clarifying this is a flat version without subagents.

## 0.1.1 - 2026-01-25
- Clarified that agents must write the task file themselves (tool does not auto-create it).

## 0.1.0 - 2026-01-13
- Initial release.
