---
name: session-start
description: Cold session start — context, status, focus. Use at the beginning of each new session.
user-invocable: true
argument-hint: "[workstream]"
---

# /session-start — Cold session start

Quick context entry. Gather state, show what's remaining, suggest focus.

---

## Step 1: Memory — load context

Read MEMORY.md (context map).

If a workstream argument is provided — load details immediately and go to Step 3.

If no argument is provided — resolve paths and show workstreams:

```bash
MEM="${CLAUDE_PLUGIN_ROOT}/scripts/memory.js"
PROJ_KEY=$(pwd | tr '/.' '-' | sed 's/^-//')
MEM_DIR="$HOME/.claude/projects/-${PROJ_KEY}/memory"
node "$MEM" --dir="$MEM_DIR" workstreams
```

Show menu. **REQUIRED format** — list workstreams from the command output, then ALWAYS add the ➕ line as the last numbered item:

```
Workstreams:
  1. <name> — <N> files, handoff from <date>
  ...
  N. ➕ Create new workstream

What do we do?
```

**The ➕ Create new workstream line is MANDATORY. Never omit it.**

Response options:
- Number or workstream name → load details and go to Step 3
- "All" / "overview" → show a brief snapshot for each, then focus candidates
- Last number / "New" / ➕ → Step 1b: create workstream

---

## Step 1b: Create new workstream (if ➕ selected)

Ask:
1. **Name**: "What should the workstream be called?" (e.g. `auth-refactor`, `mobile-fix`)
2. **Keywords**: "Which keywords to use for finding related files?" (e.g. `auth, login, session, token`)

Update `workstreams.json`:

```bash
# Read current, add new, write
node -e "
const fs = require('fs');
const p = '$MEM_DIR/workstreams.json';
const data = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
data['{name}'] = [{keywords}];
fs.writeFileSync(p, JSON.stringify(data, null, 2));
console.log('Added workstream: {name}');
"
```

Create directory and initial file:

```bash
mkdir -p "$MEM_DIR/workstreams"
```

Write note:

```bash
node "$MEM" note "NEW_WORKSTREAM: {name} keywords: {keywords}"
```

Go to Step 3 with the new workstream.

---

## Step 2: Git status

```bash
git status
git log --oneline -5
git branch --show-current
```

If there are uncommitted changes — report and ask: "Commit or continue on top?"
If the last commit was >5 days ago — note it.

---

## Step 3: Task plan (brief first)

Load the workstream with `--brief` to save context:

```bash
node "$MEM" --dir="$MEM_DIR" workstream <name> --brief
```

Show only the brief snapshot:
- How many tasks [ ] / [x]
- What is blocked
- What can be picked up now

**Do NOT load full file contents yet.** Full context loads only after the user picks a specific task in Step 4.

---

## Step 4: Focus candidates

Format:

```text
## Session YYYY-MM-DD

Git: <branch> / clean tree / N uncommitted files
Last commit: <hash> <message> (<days> days ago)

### Focus candidates
1. <task> — <SP> — why now
2. <task> — <SP> — why now
3. <task> — <SP> — why now
```

---

## Step 5: Model recommendation

For each candidate — suggest a model based on work type:

| Task type | Model | Why |
| --- | --- | --- |
| Planning, architecture, new domain | Opus | exploration, reasoning needed |
| Coding from a ready plan, scaffold | Sonnet | execution by rules |
| Routine: translations, pattern copying | Haiku | cheap, rules are sufficient |
| Review, analysis, refactoring | Sonnet/Opus | depends on depth |

Format: after each candidate — `→ recommendation: Sonnet (execution by pattern)`

---

## Step 6: Ask

"What do we do? Or pick from the candidates? Model ok or switch?"

---

## Step 7: Session label

After choosing a focus — write a label:

```bash
node "$MEM" --dir="$MEM_DIR" note "SESSION_START branch:$(git branch --show-current) workstream:<chosen> focus:<task>"
```

This allows `/session-restore search SESSION_START` to find all session entry points.

---

## Rules

- Do not read entire files — only headers and [ ] tasks
- Do not suggest more than 3 candidates
- If there are blocked tasks (waiting for mockups/backend) — note them, do not suggest
- When a workstream argument is provided — go deeper into context immediately, without a general overview
- If the previous session ended with compact — check what the last action was via `/session-restore`
- **Never skip Step 1 workstream menu**, even when startup hook context is available in system prompt. Hook context enriches Step 4 candidates — it does not replace the explicit selection step. The user must choose the workstream, not the assistant.
