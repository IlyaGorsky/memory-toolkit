RE# Architecture

memory-toolkit is a **layered extension** over Claude Code's native memory subsystem — not a replacement. It inherits CC's 4-type taxonomy, stays compatible with CC's recall selector, and adds layers CC doesn't provide: workstream grouping, explicit continuity, session lifecycle, compaction safety, and a docs promotion pipeline.

Companion to [README.md](README.md) (what + how to use) and [PHILOSOPHY.md](PHILOSOPHY.md) (why this approach) — this doc is the **what's under the hood + why each layer exists**.

## Layered model

```text
┌─────────────────────────────────────────────────────────────────┐
│  Utility         │ /memory CLI · health · scripts              │
├─────────────────────────────────────────────────────────────────┤
│  Integration     │ hooks (SessionStart · Stop · PostToolUse ·   │
│                  │ PreCompact · SubagentStop) · background      │
│                  │ watcher (Haiku) · DOC → .claude/rules/       │
├─────────────────────────────────────────────────────────────────┤
│  Orchestration   │ /session-start · /continue · /end · /park ·  │
│                  │ /reflect · /docs-reflect · /memory-setup     │
├─────────────────────────────────────────────────────────────────┤
│  Domain          │ workstream card · handoff · parked · notes   │
│                  │ (grouping + continuity — CC has no analog)   │
├─────────────────────────────────────────────────────────────────┤
│  Structure       │ subdirs per type (feedback/, decisions/,     │
│                  │ reference/, project/, profile/, workstreams/)│
├─────────────────────────────────────────────────────────────────┤
│  Taxonomy (CC)   │ 4 types: user · feedback · project ·         │
│                  │ reference (inherited from CC system prompt)  │
└─────────────────────────────────────────────────────────────────┘
```

## What CC provides vs what memory-toolkit adds

| Layer | Purpose | CC-native | memory-toolkit adds |
|---|---|---|---|
| Taxonomy | Category vocabulary for memory entries | `type:` in frontmatter — one of `user`, `feedback`, `project`, `reference` | Optional `category:` field for semantic subtyping (e.g. `category: decision`, `category: workstream`, `category: parked`); `origin: memory-toolkit` on every file MT writes, so tools sharing the folder can tell whose file is whose |
| Structure | Physical layout of memory files on disk | Flat `memory/*.md` | Subdirs for human navigation — `type:` stays CC-compatible |
| Recall | Which memory files load into context per user turn | `findRelevantMemories.ts` — Sonnet side-query, top-5 per user turn | — (CC handles this; we stay compatible via valid `type:`) |
| Continuity between boundaries | State that survives session end, compaction, and `/resume` | — | `workstreams/<name>/handoff.md` — explicit savepoint surviving compaction + `/resume` + daily boundaries |
| Grouping | Namespace for parallel work tracks within one project | — | Workstream as namespace + `workstreams.json` keyword aliases for routing; a living card `workstreams/<name>.md` per workstream |
| Session lifecycle | Explicit skills for start/continue/end/reflect ceremonies | — | `/session-start`, `/continue`, `/end`, `/park`, `/reflect`, `/docs-reflect` |
| Auto-extraction | Background save from transcript into memory files | `extractMemories.ts` — forked-agent background save, gated OFF in public builds | Background watcher (Haiku via `claude -p`), always on when key/CLI available, writes `WATCH:*` markers to `notes/` |
| Compaction safety | Protection from context destruction when compaction fires | Compaction destroys transcript | `PreCompact` hook captures branch + commit + uncommitted before loss |
| Docs promotion | Bridge from session findings to repo-level rules | — | `DOC:` notes → `/docs-reflect` → `.claude/rules/<domain>.md` |
| User-facing memory CLI | Scripting + admin + debugging surface over the memory dir | — | `memory.js` with `search`, `list`, `workstream`, `card`, `parked`, `receipt`, `health`, `docs` commands |

## Convention: type ↔ directory

Directory is our convention (human navigation + grep scope). `type:` in frontmatter stays CC-valid so CC's recall selector continues to work on our data.

| Directory | `type:` in frontmatter | Optional `category:` | CC recall sees it? |
|---|---|---|---|
| `feedback/` | `feedback` | — | ✅ |
| `decisions/` | `project` | `decision` | ✅ |
| `reference/` | `reference` | — | ✅ |
| `project/` | `project` | — | ✅ |
| `profile/` | `user` | — | ✅ |
| `workstreams/<name>.md` (card) | `project` | `workstream` | ✅ |
| `workstreams/<name>/handoff.md` | `project` | `handoff` | ✅ |
| `workstreams/<name>/<item>.md`, `parked/<item>.md` | `project` | `parked` | ✅ — recall brings a parked item back when its topic does |
| `notes/YYYY-MM-DD.md` | (event log, no frontmatter) | — | ❌ (not a memory file by CC's model) |

**Why the separation:** CC's `parseMemoryType` in `memoryTypes.ts` validates against a closed enum of 4 types. Custom values like `type: decision` return `undefined` — the file stays in recall but loses its `[type]` tag in the selector's manifest, so the selector has less to rank it by. By mapping our semantic dirs to valid types, the recall selector ranks and surfaces our files alongside CC's own. Our `category:` field carries the extra semantic nuance without breaking CC.

## Why each layer exists

### Taxonomy layer (inherited)

CC's 4 types (`user`/`feedback`/`project`/`reference`) come from CC's system prompt — every session already loads instructions about these categories. We don't invent taxonomy; we surface it in our `MEMORY.md` Rules block as explicit reminders.

### Structure layer (subdirs)

Flat `memory/` is hard to navigate once you have 60+ files. Subdirs give:

- `grep -r pattern feedback/` → search only rules, not history
- Clear placement decisions when writing (`decisions/` vs `reference/`)
- File count scaling — browse by category instead of scanning one giant list

Tradeoff: divergence from CC's flat convention. Mitigated by CC's recursive scan (it walks subdirs anyway) and valid `type:` preservation.

### Domain layer (workstream + handoff)

CC's recall selector picks top-5 relevant files per query, but this is **stateless** — it doesn't remember where the previous session stopped. When compaction fires or `/resume` starts fresh, continuity is gone.

`workstreams/<name>/handoff.md` is an **explicit savepoint** that survives all boundaries:

- Written on `/session-end` with "What was done / Where stopped / What's next / Uncommitted / Session decisions"
- Loaded on `/session-start` as primary context anchor
- Routed per workstream — switching between parallel tracks (backend vs frontend vs refactor) doesn't lose state

Workstream itself is a namespace + keyword router (`workstreams.json` holds aliases, matched as words). Enables classification of session activity into the right bucket on `/session-end`.

A handoff goes stale in two weeks; the **card** `workstreams/<name>.md` doesn't: what the workstream is (a task, an experiment, an area), why, what it doesn't do, where results live, what's open. The model keeps it current during work — in real use that, not the ritual handoff, carried the context. `card <name> --material` lists the decisions logged since the card was last updated, to draft or update it; `write-card` writes it once the user agrees.

**Parked** is a state, not a kind of content: an idea, a task or a question set aside with its context, one file per item (so recall can surface it), with an exit — `unpark` once it is picked up, moved to the backlog, or dropped.

### Orchestration layer (lifecycle skills)

CC has no lifecycle primitives. It starts, runs, and exits — the user is responsible for context ceremony. memory-toolkit adds explicit skills for boundary moments:

- `/session-start` — load handoff, show focus candidates, suggest model
- `/session-continue <workstream>` — resume specific track
- `/session-end` — receipt of what the session left, then handoff (carrying over what's still open), reflect, docs promotion, confirm at each step
- `/park` — set an idea, task or question aside with its context
- `/reflect` — periodic self-audit: workarounds, gaps, insights → your backlog of choice
- `/docs-reflect` — promote session-level `DOC:` notes to repo rules

Each skill is a deterministic routine with user confirmation gates — not a free-form LLM interaction.

### Integration layer (hooks + watcher)

Hooks run automatically on CC events, outside the user's attention:

- **`SessionStart`** (`session-log.js`) — logs session ID to `notes/`, injects the handoff with its age and branch (an old or other-branch one is labelled, not passed off as the last session) and the card index, runs memory health check. Shows the user up to two 💡 invitations (card, `/docs-reflect`, new workstream, old parked items, a branch that looks like a workstream); logs `OFFERED: <key>` and doesn't repeat one for two weeks
- **`Stop`** (`async`, after each turn, throttled to 3 min) — `session-watcher.js` analyzes the transcript via Haiku, extracts `WATCH:DECISION/CORRECTION/PLAN` + `DOC:` markers into `notes/`. CC runs it in the background; the agent never waits for it, and it prints nothing (async output would reach the model, not the user)
- **`PostToolUse`** (git commit) — `commit-note.js` logs `COMMIT:` entries
- **`SubagentStop`** (`async`, named subagents) — same watcher for subagent turns
- **`PreCompact`** — `session-save.js` captures branch + commit + uncommitted files before compaction destroys them

The watcher fills the gap left by CC's `extractMemories` being feature-flag-gated OFF in public builds. It's an optional layer (needs the `claude` CLI, Claude Code 2.1.169+; it runs `claude -p --safe-mode` with the login Claude Code already has, so the plugin never touches credentials) but high-ROI when active.

### Utility layer (CLI)

CC has no user-facing memory commands — memory is an implementation detail, not an API. `memory.js` exposes:

- `search <query>` — full-text across all memory files
- `workstream <name>` — filtered load for a specific workstream
- `list [type]` — index files by type
- `health` — dead links, stale files, duplicates, watcher parse errors
- `docs` — collect `DOC:` notes for `/docs-reflect`
- `reindex` — rebuild `MEMORY.md` index sorted by relevance

Enables scripting, CI health checks, debugging, and admin — without going through an LLM.

## Data flow on a session

```text
1. User runs: claude

   SessionStart hook fires:
   ├─ session-log.js writes SESSION_START to notes/<today>.md
   ├─ memory health check runs, emits any warnings
   ├─ handoff.md injected — labelled with its age and branch when old
   ├─ card index injected for the model
   └─ up to two 💡 invitations shown to the user (OFFERED: logged)

2. Optional: user runs /session-start <workstream>

   session-start skill:
   ├─ Reads the workstream card and handoff (if they exist)
   ├─ Shows focus candidates from handoff "What's next"
   ├─ Suggests model per task type as /model opus|sonnet|haiku
   └─ Renders workstream menu and status

3. User works on their task (code, read, edit, search)

   Stop hook fires after each turn (async, every 3 min + 6+ new messages):
   ├─ session-watcher.js claims the run, checks it is due
   ├─ Sends transcript fragment to Haiku
   ├─ Haiku emits JSON: { findings: [WATCH:*, DOC:*], phase: ... }
   └─ Findings written to notes/<today>.md

   PostToolUse hook (on git commit):
   └─ COMMIT: <message> appended to notes/<today>.md

   Claude itself (during turns, guided by MEMORY.md Rules and the card index):
   ├─ Saves feedback/decisions/project/reference files when applicable
   └─ Offers to update a workstream card when its topic comes up

4. Compaction approaches (context gets big):

   PreCompact hook fires:
   └─ session-save.js writes workstreams/precompact.md (never handoff.md) with
      branch + commit SHA + uncommitted files + session decisions

5. User runs /session-end:

   session-end skill:
   ├─ Phase 0: Receipt — memory files written (originSessionId), logged items,
   │           workstreams moved and whether their cards kept up
   ├─ Phase 1: Compose + save handoff (reads the old one; propose → confirm → write)
   ├─ Phase 2: /reflect — patterns + gaps → actionable items
   └─ Phase 3: /docs-reflect — DOC: notes → .claude/rules/<domain>.md
```

## Strategic position

- **Not competing with CC's memory engine.** CC handles recall selection, frontmatter validation, forked-agent extraction (when enabled). memory-toolkit stays aligned via valid `type:` values and `MEMORY.md` format — CC continues to rank and surface our files.
- **Adding what CC deliberately doesn't do.** Session lifecycle, workstream grouping, explicit continuity, compaction safety, docs promotion. These aren't gaps CC plans to fill — they're intentional scope limitations.
- **Zero vendor lock at the data layer.** Remove memory-toolkit and your memory dir remains readable by CC: valid types, plain markdown, flat-scannable. You lose orchestration; your data is intact.
- **Lock-in at orchestration layer.** Skills, hooks, and CLI are plugin-specific. Uninstalling the plugin keeps your data but collapses the workflow automations — you'd need to replicate them manually.

## Known architectural gaps

Resolved:

- **Workstream identity gap** (1.10.0) — a handoff is a savepoint and goes stale; each workstream can now keep a living card, `workstreams/<name>.md`, drafted from logged decisions and kept current during work.
- **Watcher held the agent up** (1.10.0) — on `PostToolUse` its model call blocked a tool for up to 144 s; it now runs on `Stop` with `async: true`.
- **Session boundary** (1.10.0) — `session-activity` took the last `SESSION_START`, which resume, compaction and parallel sessions log again; it now starts at the first marker with the session's uuid (`CLAUDE_CODE_SESSION_ID`).

- **Memory dir resolution alignment with CC** (1.9.16) — `scripts/lib/find-memory-dir.js` follows CC's chain: `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` → `autoMemoryDirectory` (local, user) → canonical git root (worktrees share the main repo's memory) → CC's `sanitizePath`. It no longer walks above the git root into a parent folder's memory.
- **Hooks write to the session's memory** (1.10.0) — hooks resolve from `CLAUDE_PROJECT_DIR`, the root the session started in, not from the current directory: a session that `cd`s into another repo no longer writes its notes into that repo's memory.
- **Watcher subprocess isolation** (1.9.14) — the nested `claude -p` runs with `--no-session-persistence` and `MEMORY_TOOLKIT_NESTED`, so it writes no transcript and the plugin's own hooks are no-ops inside it.

## See also

- [README.md](README.md) — features, installation, use cases
- [PHILOSOPHY.md](PHILOSOPHY.md) — design principles, why no vector DB, why markdown
