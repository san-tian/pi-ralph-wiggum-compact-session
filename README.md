# Ralph Wiggum Compact Session

A standalone fork of the Ralph Wiggum Pi extension.

Long-running agent loops for iterative development. Best for long-running-tasks that are verifiable. Builds on Geoffrey Huntley's ralph-loop for Claude Code and adapts it for Pi.
This one is cool because:
- You can ask Pi and it will set up and run the loop all by itself in-session
- You can keep multiple loop definitions in the same repo and resume the one you want in the current session
- You can ask Pi to self-reflect at regular intervals so it doesn't mindlessly grind through wrong instructions (optional)

Active loops are now session-owned: unrelated Pi sessions in the same repo will not auto-bind to them. Use `/ralph resume <name> --takeover` if you intentionally want to claim a loop from another session.

<img width="432" height="357" alt="Screenshot 2026-01-07 at 17 16 24" src="https://github.com/user-attachments/assets/68cdab11-76c6-4aed-9ea1-558cbb267ea6" />

**Note: This is a flat version without subagents, similar to the [Anthropic plugins implementation](https://github.com/anthropics/claude-code-plugins/tree/main/ralph-loop).**

## What's different in this fork

- `ralph_done` compacts before continuing
- The loop stays in one Pi session instead of hopping across handoff-style fresh sessions
- The compaction prompt is tuned for Ralph iteration continuity
- This fork focuses on in-session loops rather than tmux orchestration

## Install

For local development, point Pi at this folder as a package or copy `index.ts` and `SKILL.md` into your Pi package setup.

Example local package entry:

```json
{
  "packages": [
    {
      "source": "./pi-ralph-wiggum-compact-session"
    }
  ]
}
```

## Recommended usage: just ask Pi
You ask Pi to set up a ralph-wiggum loop.
- Pi sets up `~/.pi/projects/<project-id>/ralph/<name>.md` with goals and a checklist (like a list of features to build, errors to check, or files to refactor)
- You let Pi know:
  1. What the task is and completion / tests to run
  2. How many items to process per iteration
  3. (optionally) After how many iterations it should take a step back and self-reflect
- Pi runs `ralph_start`, beginning iteration 1.
  - It gets a prompt telling it to work on the task, update the task file, and call ralph_done when it finishes that iteration
  - When the iteration is done, it calls `ralph_done`, compacts the current session, and then queues the next prompt in that same session
- Each `ralph_done` compacts the thread first, so long loops keep reusing one session instead of bouncing through handoff-style fresh threads.
- Pi runs until either:
  - All tasks are done (Pi sends `<promise>COMPLETE</promise>`)
  - Max iterations (default 50)
  - You hit `esc` (pausing the loop)
If you hit `esc`, you can run `/ralph-stop` to clear the loop. Alternatively, just tell Pi to continue to keep going.

Generated loop state lives under `~/.pi/projects/<project-id>/ralph/`, and local debug payloads may appear under `.tmp/`. Keep `.tmp/` out of git if provider payloads may contain sensitive project details.

## Commands

| Command | Description |
|---------|-------------|
| `/ralph start <name\|path>` | Start a new loop |
| `/ralph resume <name>` | Resume a paused loop |
| `/ralph stop` | Pause current loop |
| `/ralph-stop` | Stop active loop (idle only) |
| `/ralph status` | Show all loops |
| `/ralph list --archived` | Show archived loops |
| `/ralph archive <name>` | Move loop to archive |
| `/ralph clean [--all]` | Clean completed loops |
| `/ralph cancel <name>` | Delete a loop |
| `/ralph nuke [--yes]` | Delete all managed Ralph data |

### Options for start

| Option | Description |
|--------|-------------|
| `--max-iterations N` | Stop after N iterations (default 50) |
| `--items-per-iteration N` | Suggest N items per turn (prompt hint) |
| `--reflect-every N` | Reflect every N iterations |

## Agent Tool

The agent can self-start loops using `ralph_start`:

```
ralph_start({
  name: "refactor-auth",
  taskContent: "# Task\n\n## Checklist\n- [ ] Item 1",
  maxIterations: 50,
  itemsPerIteration: 3,
  reflectEvery: 10
})
```

## Credits

Based on Geoffrey Huntley's Ralph Wiggum approach for long-running agent tasks.

## Changelog

See `CHANGELOG.md`.
