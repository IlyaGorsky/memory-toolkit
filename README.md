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

### Session lifecycle

```
  /session-start ──→ work ──→ /session-end
        ↑                          │
        │      handoff.md          │
        │  (what you did,          │
        │   where you stopped,     │
        │   what's next)           │
        └──────────────────────────┘
```

### Use case 1: Context survives compaction

Without plugin — context is lost after compact:
```
  you ──→ work 2h ──→ [compact] ──→ "what were we doing?"
```

With plugin — hooks auto-save before compact:
```
  you ──→ work 2h ──→ [PreCompact hook] ──→ [compact]
                            │
                            ▼
                      handoff.md saved
                            │
                            ▼
                      "here's where we left off"
```

### Use case 2: Switching between workstreams

```
  Monday:   /session-start auth-refactor
              ├── decisions/auth-token-format.md
              ├── feedback/no-mocks-in-tests.md
              └── workstreams/handoff.md ← saved on /session-end

  Tuesday:  /session-start billing
              ├── loads billing context
              └── auth-refactor untouched

  Thursday: /session-continue auth-refactor
              └── picks up from Monday's handoff
```

### Use case 3: Ideas don't get lost

```
  working on feature X...
    └── "we should also refactor Y"
          │
          ▼
        /park "refactor Y — noticed coupling in auth module"
          │
          ├── saves to notes/ with context
          └── you keep working on X

  next week:
    /memory search "refactor Y"
      └── found: full context from that moment
```

### Use case 4: Look into past sessions

Claude Code keeps `.jsonl` logs of every session but can't read them itself. This plugin can:

```
  /session-restore list
    → shows all past sessions with dates and sizes

  /session-restore search "why did we choose PostgreSQL"
    → greps across .jsonl files, parses results

  /session-restore restore
    → rebuilds timeline from last session:
        Block 1: discussed auth architecture
        Block 2: implemented token refresh
        Block 3: fixed test flake ← crashed here

  /session-insights
    → patterns across sessions:
        "auth tests failed 3 times this week — same mock issue"
```

### Memory structure

```
  ~/.claude/projects/<project>/memory/
    ├── MEMORY.md            ← index (loaded every session)
    ├── workstreams.json     ← workstream definitions
    ├── feedback/            ← corrections, confirmed approaches
    ├── decisions/           ← architectural choices with reasoning
    ├── profile/             ← user role, preferences
    ├── reference/           ← external links, dashboards
    ├── notes/               ← daily notes (auto from hooks)
    └── workstreams/
         └── handoff.md      ← session continuity
```

All files are markdown. Human-readable, git-friendly, portable.

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
