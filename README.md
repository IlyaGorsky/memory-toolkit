# memory-toolkit

Session memory lifecycle for Claude Code. Structured markdown memory, workstreams, handoff between sessions, auto-save hooks.

No vector DB. No external dependencies. Pure markdown + Node.js.

## Philosophy

See [PHILOSOPHY.md](PHILOSOPHY.md)

## Skills

| Skill | Description |
|-------|-------------|
| `/memory` | Search, workstreams, notes, decisions. Auto-initializes on first use |
| `/session-start` | Cold start — context, status, focus selection |
| `/session-continue` | Resume workstream from where you left off |
| `/session-end` | Save state, prepare handoff for next session |
| `/park` | Park an idea for later — save context without losing the thought |
| `/reflect` | Session reflection — analyze what happened, propose backlog items |
| `/session-insights` | Extract insights from .jsonl session backups |
| `/session-restore` | Restore context from .jsonl session backups |

## Hooks

- **PreCompact** — auto-save git state to `workstreams/handoff.md` before context compaction
- **PostToolUse** (git commit) — log commits to daily notes
- **SessionStart** — show handoff from previous session

## Memory API

```bash
node memory.js search <query>
node memory.js workstream <name>
node memory.js workstreams
node memory.js add-workstream <name> <keywords...>
node memory.js remove-workstream <name>
node memory.js decisions [topic]
node memory.js recent [n]
node memory.js list [type]
node memory.js note <text>
node memory.js dir
```

## Install

### As plugin (recommended)

```bash
claude --plugin-dir /path/to/memory-toolkit
```

### From marketplace

```bash
claude plugin install memory-toolkit@claude-plugins-community
```

## License

MIT
