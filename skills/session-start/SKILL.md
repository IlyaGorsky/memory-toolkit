---
name: session-start
description: Cold session start — context, status, focus. Use at the beginning of each new session.
user-invocable: true
argument-hint: "[workstream]"
---

# /session-start — Cold session start

Quick context entry via pipeline. Each phase must complete before the next begins.

## Load pipeline

```
Read: ${CLAUDE_PLUGIN_ROOT}/skills/task-template/templates/session-start.yaml
```

Read the YAML and execute phases in dependency order. Follow the orchestrator rules:

```
Read: ${CLAUDE_PLUGIN_ROOT}/skills/task-template/SKILL.md
```

## Bootstrap (before pipeline)

Resolve paths for use in all phases:

```bash
MEM="${CLAUDE_PLUGIN_ROOT}/scripts/memory.js"
PROJ_KEY=$(pwd | tr '/.' '-' | sed 's/^-//')
MEM_DIR="$HOME/.claude/projects/-${PROJ_KEY}/memory"
```

## Phase-specific instructions

These supplement the YAML — the pipeline defines order and gates, these provide implementation detail.

### context phase

Read MEMORY.md. Run `node "$MEM" --dir="$MEM_DIR" workstreams`.

If a workstream argument is provided — skip the menu, load details immediately.

Show menu. **REQUIRED format** — list workstreams from the command output, then ALWAYS add the + line as the last numbered item:

```
Workstreams:
  1. <name> — <N> files, handoff from <date>
  ...
  N. + Create new workstream

What do we do?
```

**The + Create new workstream line is MANDATORY. Never omit it.**

Response options:
- Number or workstream name → chosen
- "All" / "overview" → brief snapshot for each, then candidates
- Last number / "New" / + → create new workstream:
  1. Ask name and keywords
  2. `node "$MEM" add-workstream <name> <keywords>`
  3. `node "$MEM" note "NEW_WORKSTREAM: <name> keywords: <keywords>"`

### git phase

```bash
git status
git log --oneline -5
git branch --show-current
```

If uncommitted changes — report and ask: "Commit or continue on top?"
If the last commit was >5 days ago — note it.

### workstream-detail phase

```bash
node "$MEM" --dir="$MEM_DIR" workstream <name> --brief
```

Show only: task count, blocked items, available items.
Do NOT load full file contents yet.

### candidates phase

Pick up to 3 unblocked tasks. Format:

```text
## Session YYYY-MM-DD

Git: <branch> / clean tree / N uncommitted files
Last commit: <hash> <message> (<days> days ago)

### Focus candidates
a. <task> — <SP> — why now
b. <task> — <SP> — why now
c. <task> — <SP> — why now
```

Use letters `a. b. c.` (not numbers — numbers are for workstreams).

Model recommendation per candidate:

| Task type | Model |
| --- | --- |
| Planning, architecture, new domain | Opus |
| Coding from a ready plan | Sonnet |
| Routine: translations, pattern copying | Haiku |
| Review, analysis, refactoring | Sonnet/Opus |

Ask: "What do we do? Pick from candidates? Model ok?"

### task-card phase

After user picks — build a task card from context (handoff, memory, and project backlog if one exists). Do NOT ask the user to fill in fields manually — gather everything yourself, then confirm.

```text
### Task
What: <one sentence — what and why>
Workstream: <name>
Files: <path1>, <path2>
AP: <AP-ID or ->
Depends: <blockers or ->
```

Ask: "Start? Or adjust?"

After confirmation — save:

```bash
node "$MEM" --dir="$MEM_DIR" note "SESSION_START branch:$(git branch --show-current) workstream:<chosen> focus:<what>"
```

### work phase

Load full context for files listed in the task card. Begin work.

## Rules

- Do not read entire files until work phase — only headers and [ ] tasks
- Do not suggest more than 3 candidates
- Blocked tasks — note them, do not suggest
- When a workstream argument is provided — go deeper into context immediately
- If the previous session ended with compact — check what the last action was via `/session-restore`
- **Never skip the context phase workstream menu**, even when startup hook context is available. Hook context enriches candidates — it does not replace the explicit selection step.
