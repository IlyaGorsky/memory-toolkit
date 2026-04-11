# memory-toolkit

**CLAUDE.md is for your codebase. Not for your sessions.**

People stuff session state into CLAUDE.md because there's nowhere
else to put it. It works until it doesn't — size limit, goes stale,
resets every session, mixes personal state with team conventions.

memory-toolkit is the session layer that should have existed
alongside CLAUDE.md from the start.

Built for tech leads who run multiple workstreams in parallel.

```bash
git clone https://github.com/IlyaGorsky/memory-toolkit.git
claude plugin marketplace add ./memory-toolkit
claude plugin install memory-toolkit
```

See [INSTALL.md](INSTALL.md) for other methods (per-session, manual copy, existing auto-memory migration).

## The problem

Three documented pain points this plugin solves:

**1. Compaction silently destroys context** — you're 4 hours into an auth refactor, compaction fires, Claude forgets every architectural decision you made together. Starting over takes 45 minutes and never fully recovers. ([real report](https://dev.to/gonewx/claude-code-lost-my-4-hour-session-heres-the-0-fix-that-actually-works-24h6))

**2. `--resume` doesn't actually restore context** — `claude --continue` and `claude --resume` start fresh. All accumulated context — files read, decisions made, in-progress work state — is irrecoverable. ([issue #43696](https://github.com/anthropics/claude-code/issues/43696))

**3. Switching between tasks means re-explaining everything** — each context rebuild takes 10–15 minutes. Switching between workstreams multiple times a day compounds into hours of lost time. ([real report](https://dev.to/kaz123/how-i-solved-claude-codes-context-loss-problem-with-a-lightweight-session-manager-265d))

memory-toolkit fixes all three with hooks that fire at the right moment — not at session start.

## What this plugin does

**memory-toolkit** adds a structured memory layer on top of Claude Code's auto-memory:

- **Session lifecycle** — start, continue, end. Handoff between sessions so you pick up where you left off, not from scratch.
- **Workstreams** — group related memory by project area. Switch context without losing it.
- **Memory API** — search, filter, and query your memory from any skill or hook. No vector DB, no external dependencies — just markdown files and a Node.js script.
- **Auto-save hooks** — save state before context compaction, log commits to daily notes, show handoff on session start.

## How it works

### Session lifecycle

```text
/session-start ──→  work  ──→ /session-end
      ▲                            │
      │                            │
      └────── workstreams/ ────────┘
              handoff.md
       (what you did, where you stopped, what's next)
```

### Use case 1: Context survives compaction

Without plugin:

```text
you ──→ work 2h ──→ [compact] ──→ "wait, what were we doing?"
```

With plugin — PreCompact hook fires before compaction:

```text
you ──→ work 2h ──→ [PreCompact hook] ──→ [compact] ──→ next session
                            │                                 ▲
                            ├──→ workstreams/handoff.md       │
                            │    (session_id, branch,         │
                            │     last commit, uncommitted)   │
                            │                                 │
                            └──→ notes/<today>.md             │
                                 (PRE_COMPACT entry)          │
                                                              │
                  SessionStart hook reads handoff ────────────┘
                  "here's where we left off"
```

The PreCompact hook captures **state metadata** (session_id, branch, commit, uncommitted files) — fast and deterministic. Richer summaries (decisions made, what's next) are written by `/session-end` when you close a session manually.

### Use case 2: Switching between workstreams

```text
Mon  /session-start auth-refactor
       ├── loads decisions/auth-token-format.md
       ├── loads feedback/no-mocks-in-tests.md
       └── /session-end ──→ workstreams/handoff.md

Tue  /session-start billing
       ├── loads billing context
       └── auth-refactor handoff untouched

Thu  /session-continue auth-refactor
       └── picks up from Monday's handoff, fresh context
```

### Use case 3: Ideas don't get lost

```text
working on feature X...
   └── "we should also refactor Y"
         │
         ▼
       /park "refactor Y — noticed coupling in auth module"
         │
         ├──→ appended to the active workstream file
         │    (or a quick note in notes/<today>.md)
         │
         └── you keep working on X

next week:
   /memory search "refactor Y"
      └── full context from that moment
```

### Use case 4: Every session is reachable from any session

Claude Code keeps `.jsonl` transcripts but doesn't connect them. Each session starts blind. This plugin tracks every session with an ID, so you can look back:

```text
SessionStart hook (fires automatically)
   ├──→ reads session_id from Claude Code
   ├──→ notes/<today>.md
   │    "14:30 SESSION_START uuid:a1b2c3 branch:main
   │     transcript:/path/to/a1b2c3.jsonl"
   └──→ sessions.jsonl  (searchable index, one line per session)

PreCompact hook
   └──→ writes session_id into workstreams/handoff.md
        (next session knows which session wrote the handoff)
```

Now any session can reach any past session:

```text
/session-restore list
   └── all sessions with dates, branches, UUIDs

/session-restore search "why did we choose PostgreSQL"
   └── greps across .jsonl transcripts, returns matching turns

/session-restore restore <uuid>
   └── rebuilds timeline of that specific session:
         Block 1: discussed auth architecture
         Block 2: implemented token refresh
         Block 3: fixed test flake ← crashed here

/session-insights
   └── patterns across recent sessions:
         "auth tests failed 3 times this week — same mock issue"
```

### Memory structure

```text
~/.claude/projects/<project>/memory/
├── MEMORY.md            ← index (loaded into every session)
├── workstreams.json     ← workstream definitions
├── sessions.jsonl       ← session ID index (auto, from hooks)
│
├── feedback/            ← corrections, confirmed approaches
├── decisions/           ← architectural choices with reasoning
├── reference/           ← external links, dashboards
├── notes/               ← daily notes (auto, from hooks + /park fallback)
├── profile/             ← (optional) user role, language preferences
└── workstreams/
    └── handoff.md       ← session continuity (per workstream)
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

## Current limitations

- **Workstream isolation** — `workstreams/handoff.md` is currently a single file overwritten on every `/session-end`. True per-workstream isolation is on the roadmap.

## Philosophy

No vector DB. No external services. No complex setup.

Just markdown files, a Node.js script, and Claude Code skills that know how to use them. Your memory stays on your machine, in a format you can read, edit, and version control.

See [PHILOSOPHY.md](PHILOSOPHY.md) for the full rationale.

## License

MIT
