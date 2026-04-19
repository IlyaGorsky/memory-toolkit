RE# Architecture

memory-toolkit is a **layered extension** over Claude Code's native memory subsystem — not a replacement. It inherits CC's 4-type taxonomy, stays compatible with CC's recall selector, and adds layers CC doesn't provide: workstream grouping, explicit continuity, session lifecycle, compaction safety, and a docs promotion pipeline.

Companion to [README.md](README.md) (what + how to use) and [PHILOSOPHY.md](PHILOSOPHY.md) (why this approach) — this doc is the **what's under the hood + why each layer exists**.

## Layered model

```text
┌─────────────────────────────────────────────────────────────────┐
│  Utility         │ /memory CLI · health · scripts              │
├─────────────────────────────────────────────────────────────────┤
│  Integration     │ hooks (SessionStart · PostToolUse ·          │
│                  │ PreCompact · SubagentStop) · background      │
│                  │ watcher (Haiku) · DOC → .claude/rules/       │
├─────────────────────────────────────────────────────────────────┤
│  Orchestration   │ /session-start · /continue · /end · /park ·  │
│                  │ /reflect · /docs-reflect · /memory-setup     │
├─────────────────────────────────────────────────────────────────┤
│  Domain          │ workstream · handoff · notes · sessions      │
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
| Taxonomy | Category vocabulary for memory entries | `type: user|feedback|project|reference` in frontmatter | Optional `category:` field for semantic subtyping (e.g. `category: decision`, `category: handoff`) |
| Structure | Physical layout of memory files on disk | Flat `memory/*.md` | Subdirs for human navigation — `type:` stays CC-compatible |
| Recall | Which memory files load into context per user turn | `findRelevantMemories.ts` — Sonnet side-query, top-5 per user turn | — (CC handles this; we stay compatible via valid `type:`) |
| Continuity between boundaries | State that survives session end, compaction, and `/resume` | — | `workstreams/<name>/handoff.md` — explicit savepoint surviving compaction + `/resume` + daily boundaries |
| Grouping | Namespace for parallel work tracks within one project | — | Workstream as namespace + `workstreams.json` keyword aliases for routing |
| Session lifecycle | Explicit skills for start/continue/end/reflect ceremonies | — | `/session-start`, `/continue`, `/end`, `/park`, `/reflect`, `/docs-reflect` |
| Auto-extraction | Background save from transcript into memory files | `extractMemories.ts` — forked-agent background save, gated OFF in public builds | Background watcher (Haiku via `claude -p`), always on when key/CLI available, writes `WATCH:*` markers to `notes/` |
| Compaction safety | Protection from context destruction when compaction fires | Compaction destroys transcript | `PreCompact` hook captures branch + commit + uncommitted before loss |
| Docs promotion | Bridge from session findings to repo-level rules | — | `DOC:` notes → `/docs-reflect` → `.claude/rules/<domain>.md` |
| User-facing memory CLI | Scripting + admin + debugging surface over the memory dir | — | `memory.js` with `search`, `list`, `workstream`, `health`, `docs` commands |

## Convention: type ↔ directory

Directory is our convention (human navigation + grep scope). `type:` in frontmatter stays CC-valid so CC's recall selector continues to work on our data.

| Directory | `type:` in frontmatter | Optional `category:` | CC recall sees it? |
|---|---|---|---|
| `feedback/` | `feedback` | — | ✅ |
| `decisions/` | `project` | `decision` | ✅ |
| `reference/` | `reference` | — | ✅ |
| `project/` | `project` | — | ✅ |
| `profile/` | `user` | — | ✅ |
| `workstreams/<name>/handoff.md` | `project` | `handoff` | ✅ |
| `workstreams/<name>/workstream.md` (planned) | `project` | `identity` | ✅ |
| `notes/YYYY-MM-DD.md` | (event log, no frontmatter) | — | ❌ (not a memory file by CC's model) |

**Why the separation:** CC's `parseMemoryType` in `memoryTypes.ts` validates against a closed enum of 4 types. Custom values like `type: decision` return `undefined` — CC silently ignores the file in recall. By mapping our semantic dirs to valid types, the recall selector ranks and surfaces our files alongside CC's own. Our `category:` field carries the extra semantic nuance without breaking CC.

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

Workstream itself is a namespace + keyword router (`workstreams.json` holds aliases). Enables classification of session activity into the right bucket on `/session-end`.

### Orchestration layer (lifecycle skills)

CC has no lifecycle primitives. It starts, runs, and exits — the user is responsible for context ceremony. memory-toolkit adds explicit skills for boundary moments:

- `/session-start` — load handoff, show focus candidates, suggest model
- `/session-continue <workstream>` — resume specific track
- `/session-end` — reflect, write handoff, run docs promotion, confirm at each step
- `/park` — save an idea mid-session without losing context
- `/reflect` — periodic self-audit: workarounds, gaps, insights → your backlog of choice
- `/docs-reflect` — promote session-level `DOC:` notes to repo rules

Each skill is a deterministic routine with user confirmation gates — not a free-form LLM interaction.

### Integration layer (hooks + watcher)

Hooks run automatically on CC events, outside the user's attention:

- **`SessionStart`** (`session-log.js`) — logs session ID to `notes/`, injects handoff context, runs memory health check
- **`PostToolUse`** (every tool call, throttled to 3 min) — `session-watcher.js` analyzes transcript via Haiku, extracts `WATCH:DECISION/CORRECTION/PLAN` + `DOC:` markers into `notes/`. Also logs git commits as `COMMIT:` entries
- **`SubagentStop`** — same watcher for subagent turns
- **`PreCompact`** — `session-save.js` captures branch + commit + uncommitted files before compaction destroys them

The watcher fills the gap left by CC's `extractMemories` being feature-flag-gated OFF in public builds. It's an optional layer (`ANTHROPIC_API_KEY` or `claude` CLI required) but high-ROI when active.

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
   └─ handoff.md content injected into the new session context

2. Optional: user runs /session-start <workstream>

   session-start skill:
   ├─ Reads workstream handoff (if exists)
   ├─ Shows focus candidates from handoff "What's next"
   ├─ Suggests model per task type (Opus/Sonnet/Haiku)
   └─ Renders workstream menu and status

3. User works on their task (code, read, edit, search)

   PostToolUse hook fires (throttled, every 3 min + 6+ new messages):
   ├─ session-watcher.js checks if watcher is due
   ├─ Sends transcript fragment to Haiku
   ├─ Haiku emits JSON: { findings: [WATCH:*, DOC:*], phase: ... }
   └─ Findings written to notes/<today>.md

   PostToolUse hook (on git commit):
   └─ COMMIT: <message> appended to notes/<today>.md

   Claude itself (during turns, guided by MEMORY.md Rules):
   └─ Saves feedback/decisions/project/reference files when applicable

4. Compaction approaches (context gets big):

   PreCompact hook fires:
   └─ session-save.js writes workstreams/<name>/handoff.md with
      branch + commit SHA + uncommitted files + session decisions

5. User runs /session-end:

   session-end skill:
   ├─ Phase 1: Compose + save handoff (propose → confirm → write)
   ├─ Phase 2: /reflect — patterns + gaps → actionable items
   └─ Phase 3: /docs-reflect — DOC: notes → .claude/rules/<domain>.md
```

## Strategic position

- **Not competing with CC's memory engine.** CC handles recall selection, frontmatter validation, forked-agent extraction (when enabled). memory-toolkit stays aligned via valid `type:` values and `MEMORY.md` format — CC continues to rank and surface our files.
- **Adding what CC deliberately doesn't do.** Session lifecycle, workstream grouping, explicit continuity, compaction safety, docs promotion. These aren't gaps CC plans to fill — they're intentional scope limitations.
- **Zero vendor lock at the data layer.** Remove memory-toolkit and your memory dir remains readable by CC: valid types, plain markdown, flat-scannable. You lose orchestration; your data is intact.
- **Lock-in at orchestration layer.** Skills, hooks, and CLI are plugin-specific. Uninstalling the plugin keeps your data but collapses the workflow automations — you'd need to replicate them manually.

## Known architectural gaps

Open items being worked on:

- **Workstream identity gap** — handoff is a savepoint, not identity. A second file per workstream (what is this workstream, why, scope) is needed alongside handoff for long-running initiatives. Without identity, handoff alone goes stale and workstreams lose meaning as reference.
- **Memory dir resolution alignment with CC** — `scripts/lib/find-memory-dir.js` currently uses filesystem ancestor walk + glob fallback, diverging from CC's `findCanonicalGitRoot` + `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` / `autoMemoryDirectory` protocol. Can cause split-brain between CC auto-memory and memory-toolkit writes in monorepo subfolders.
- **Watcher subprocess HOME isolation** — `claude -p` spawn should pass an isolated `HOME` so its own session-log artefacts don't pollute the parent project's `sessions.jsonl`.

## See also

- [README.md](README.md) — features, installation, use cases
- [PHILOSOPHY.md](PHILOSOPHY.md) — design principles, why no vector DB, why markdown
