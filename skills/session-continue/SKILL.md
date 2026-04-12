---
name: session-continue
description: Continue a workstream from where you left off — faster than /session-start, no focus selection.
user-invocable: true
argument-hint: "[workstream]"
---

# /session-continue — Quick Continue

Pick up a workstream without a full cold start. For cases when you know what you're doing.

---

## Step 1: Find handoff

```bash
MEM="${CLAUDE_PLUGIN_ROOT}/scripts/memory.js"
PROJ_KEY=$(pwd | tr '/.' '-' | sed 's/^-//')
MEM_DIR="$HOME/.claude/projects/-${PROJ_KEY}/memory"
cat "$MEM_DIR/workstreams/handoff.md" 2>/dev/null || echo "NO_HANDOFF"
```

If no handoff exists → suggest `/session-start` instead.

---

## Step 2: Git status (silently)

```bash
git status --short
git log --oneline -3
git branch --show-current
```

If there are uncommitted changes — show in one line.
If the tree is clean — don't mention it.

---

## Step 3: Show summary

Format (10 lines max):

```
## Continuing: {workstream}

**Where we left off:** {from handoff — last action}
**What's next:** {from handoff — next step}
**Branch:** {branch} {uncommitted count if any}

Shall we begin?
```

Don't show task plan, focus candidates, model recommendations — that's for `/session-start`.

---

## Step 4: Load context on demand

If the user confirmed — load only what's needed for the next step:

- The file that was last edited
- Task plan if available
- Last 3 feedback entries via `node $MEM search`

Do NOT load the entire memory — only what's relevant.

---

## Step 5: Mark

```bash
node $MEM_DIR/memory.js note "SESSION_CONTINUE branch:$(git branch --show-current) workstream:{name}"
```

---

## Rules

- Maximum speed — 10 lines of output, then get to work
- Don't ask about the model, don't show candidates — the user already knows
- If handoff is older than 7 days — warn: "Handoff from {date}, context may be stale. /session-start for a full overview?"
- If no argument is passed — take the workstream from the latest handoff
