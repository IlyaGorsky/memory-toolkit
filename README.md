# memory-toolkit

**Claude Code forgets between sessions.** This plugin adds session lifecycle, workstreams, and a memory API on top of auto-memory — just markdown files, no daemon, no vector DB.

```bash
git clone https://github.com/IlyaGorsky/memory-toolkit.git
claude plugin marketplace add ./memory-toolkit
claude plugin install memory-toolkit
```

See [INSTALL.md](INSTALL.md) for other methods (per-session, manual copy, existing auto-memory migration).

## The problem

Claude Code forgets everything between sessions. You start fresh every time — re-explain context, re-discover decisions, re-load the mental model. Auto-memory helps, but it's a flat list with no structure, no search, and no session continuity.

## Why not just CLAUDE.md?

CLAUDE.md is great for **stable** project rules — conventions, architecture, commands. It's the wrong tool for **session state**:

- **It's loaded into every conversation**, so it has a hard size budget (~200 lines / 25KB) before truncation. Session-by-session details would push out the rules that need to survive.
- **It's rewritten by hand.** There's no structure for "what did I do yesterday", "where am I in this refactor", "which idea did I park last week".
- **It's shared (committed).** Personal session state and team conventions don't belong in the same file.

memory-toolkit keeps CLAUDE.md for what it's good at and handles the rest separately: handoffs, workstreams, session logs, parked ideas.

## What this plugin does

**memory-toolkit** adds a structured memory layer on top of Claude Code's auto-memory:

- **Session lifecycle** — start, continue, end. Handoff between sessions so you pick up where you left off, not from scratch.
- **Workstreams** — group related memory by project area. Switch context without losing it.
- **Memory API** — search, filter, and query your memory from any skill or hook. No vector DB, no external dependencies — just markdown files and a Node.js script.
- **Auto-save hooks** — save state before context compaction, log commits to daily notes, show handoff on session start.

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

### Use case 4: Every session is reachable from any session

Claude Code keeps `.jsonl` logs but doesn't connect them. Each session starts blind. This plugin tracks every session with an ID, so you can look back:

```
  SessionStart hook fires automatically:
    → reads session_id from Claude Code
    → logs to notes/:
        "14:30 SESSION_START uuid:a1b2c3 branch:main transcript:/path/to/a1b2c3.jsonl"
    → appends to sessions.jsonl (searchable index)

  PreCompact hook:
    → saves session_id in handoff.md
    → next session knows which session wrote the handoff
```

Now any session can reach any past session:

```
  /session-restore list
    → shows all sessions with dates, branches, UUIDs

  /session-restore search "why did we choose PostgreSQL"
    → greps across .jsonl transcripts, parses results

  /session-restore restore <uuid>
    → rebuilds timeline of that specific session:
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
    ├── sessions.jsonl       ← session ID index (auto from hooks)
    ├── feedback/            ← corrections, confirmed approaches
    ├── decisions/           ← architectural choices with reasoning
    ├── profile/             ← user role, preferences
    ├── reference/           ← external links, dashboards
    ├── notes/               ← daily notes (auto from hooks)
    └── workstreams/
         └── handoff.md      ← session continuity
```

All files are markdown. Human-readable, git-friendly, portable.

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
| `/docs-reflect` | Extract session knowledge into repo documentation |

All skills are also available with the plugin namespace prefix: `/memory-toolkit:session-start`, `/memory-toolkit:memory`, etc. Use namespaced names to avoid conflicts with other plugins.

## Hooks

| Event | Action |
|-------|--------|
| **PreCompact** | Auto-save session state before context compaction |
| **PostToolUse** (git commit) | Log commits to daily notes (triggers when Claude Code runs `git commit`, not manual terminal commits) |
| **SessionStart** | Log session ID, show handoff, display DOC: reminder |

## How it compares

There are great memory tools out there. They solve different problems.

**[claude-mem](https://github.com/thedotmack/claude-mem)** — automatically captures everything Claude does, compresses with AI, injects into future sessions. Full automation, progressive disclosure, web viewer. Trade-offs: requires SQLite, runs a background worker daemon, **AGPL 3.0** (viral license — derivative works must also be AGPL).

**[MemPalace](https://github.com/milla-jovovich/mempalace)** — stores verbatim conversations in ChromaDB, semantic search with 96.6% LongMemEval score. Best for "find what we discussed 3 months ago". Trade-offs: requires Python, ChromaDB, `pip install`.

**memory-toolkit** solves a different problem: **session workflow, not storage**. No daemon, no DB, MIT license.

| | claude-mem | MemPalace | memory-toolkit |
|---|---|---|---|
| Problem solved | "What did Claude do?" | "What did we discuss?" | "Where did I stop and what's next?" |
| Storage | SQLite + AI compression | ChromaDB + embeddings | Markdown files (human-readable) |
| Dependencies | Node.js, SQLite, worker | Python, ChromaDB | None (built-in Node.js) |
| Auto-capture | Full (hooks capture all tool use) | Manual (`mine` command) | Hooks (compact, commit, session start) |
| Session history search | Compressed observations | Semantic (vector) | Grep across .jsonl transcripts |
| Session lifecycle | No | No | Yes — start, continue, end, handoff |
| Workstreams | No | Wings/halls/rooms | Yes — switch context, keep each isolated |
| Works offline | Yes | Yes | Yes |
| License | AGPL 3.0 | MIT | MIT |

**When to use what:**

- You want total recall of everything Claude did, and you're OK with a daemon and AGPL → **claude-mem**
- You want semantic search across months of conversations → **MemPalace**
- You want session continuity, workstreams, and a workflow that survives compaction — with no daemon, no DB, MIT license → **memory-toolkit**

They're complementary — you could use memory-toolkit for session workflow and claude-mem or MemPalace for long-term recall.

## Philosophy

No vector DB. No external services. No complex setup.

Just markdown files, a Node.js script, and Claude Code skills that know how to use them. Your memory stays on your machine, in a format you can read, edit, and version control.

See [PHILOSOPHY.md](PHILOSOPHY.md) for the full rationale.

## License

MIT
