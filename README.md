# memory-toolkit

Claude Code plugin for session memory lifecycle.

## The problem

Claude Code forgets everything between sessions. You start fresh every time — re-explain context, re-discover decisions, re-load the mental model. Auto-memory helps, but it's a flat list with no structure, no search, and no session continuity.

## What this plugin does

**memory-toolkit** adds a structured memory layer on top of Claude Code's auto-memory:

- **Session lifecycle** — start, continue, end. Handoff between sessions so you pick up where you left off, not from scratch.
- **Workstreams** — group related memory by project area. Switch context without losing it.
- **Memory API** — search, filter, and query your memory from any skill or hook. No vector DB, no external dependencies — just markdown files and a Node.js script.
- **Auto-save hooks** — save state before context compaction, log commits to daily notes, show handoff on session start.

## Skills

| Skill | What it does |
|-------|-------------|
| `/session-start` | Cold start — load context, show status, pick focus |
| `/session-continue` | Resume a workstream from where you left off |
| `/session-end` | Save state, write handoff for next session |
| `/memory` | Search, list, query memory files |
| `/memory-setup` | Initialize or upgrade memory for a project |
| `/park` | Save an idea for later without losing the thought |
| `/reflect` | Session reflection — what happened, what to improve |
| `/session-insights` | Extract patterns from .jsonl session backups |
| `/session-restore` | Recover context from past sessions |

## How it works

```
  /session-start ──→ work ──→ /session-end
        ↑                          │
        │        handoff.md        │
        └──────────────────────────┘

  During work:
    /park ────→ save idea for later
    /reflect ─→ capture insights
    /memory ──→ search past decisions

  Auto (hooks):
    compact ──→ saves state
    commit ───→ logs to notes
    start ────→ shows handoff
```

Memory is stored as markdown files in `~/.claude/projects/<project>/memory/` — the same directory Claude Code's auto-memory uses. Nothing proprietary, fully portable, human-readable.

## Hooks

| Event | Action |
|-------|--------|
| **PreCompact** | Auto-save session state before context compaction |
| **PostToolUse** (git commit) | Log commits to daily notes |
| **SessionStart** | Show handoff from previous session |

## Install

```bash
# From marketplace (when available)
claude plugin install memory-toolkit

# Or load for one session
claude --plugin-dir /path/to/memory-toolkit
```

See [INSTALL.md](INSTALL.md) for all options including existing auto-memory migration.

## Philosophy

No vector DB. No external services. No complex setup.

Just markdown files, a Node.js script, and Claude Code skills that know how to use them. Your memory stays on your machine, in a format you can read, edit, and version control.

See [PHILOSOPHY.md](PHILOSOPHY.md) for the full rationale.

## License

MIT
