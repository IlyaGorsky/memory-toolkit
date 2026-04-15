---
name: session-end
description: Session completion — handoff, reflect, docs-reflect cascade.
user-invocable: true
argument-hint: ""
metadata:
  pipeline: true
---

# /session-end — Handoff for the next session

Save context before finishing. Three phases: handoff → reflect → docs-reflect.

## Phase 1: Handoff

### 1a: Update MEMORY.md

Check what is current:
- Profile — no changes?
- Rules — new agreements?
- Reference — new links?

### 1b: Routing analysis (preview)

Classify session activity by workstream — preview, not yet written (AP-24).

```bash
node "$MEM" --dir="$MEM_DIR" session-activity > /tmp/activity.json
node "$MEM" --dir="$MEM_DIR" session-changes > /tmp/changes.json

# Combine items + file paths + commit subjects into one array for classify
jq -s '[.[0].items[], .[1].commits[], .[1].files[]]' /tmp/activity.json /tmp/changes.json > /tmp/items.json
node "$MEM" --dir="$MEM_DIR" classify --items=/tmp/items.json
```

Show user a compact routing table:

```text
Routing analysis:
  lifecycle       → 7 items
  infrastructure  → 3 items
  research        → 1 item
  _unassigned     → 2 items

(preview — handoffs per workstream will be written in step 1d)
```

### 1c: Propose handoff

**MUST show the proposed handoff content to the user and wait for confirmation before writing.**

Prepare `workstreams/handoff.md` content:

```markdown
---
name: Session handoff
description: Context for starting the next session
type: project
---

## Last session: YYYY-MM-DD

### What was done
- <list>

### Where we stopped
- <current state>

### What's next
1. <task> → recommendation: <model>
2. <task> → recommendation: <model>

### Uncommitted changes
- <git status summary, or "clean tree">

### Session decisions
- <new agreements, if any>
```

### 1d: Confirm and write

Show handoff to user. **Wait for "ok" / "save" before writing.**

On confirm, write in two layers:

1. **Per-workstream handoffs** — for each non-empty bucket from routing (excl. `_unassigned`):
   ```bash
   # Compose per-workstream slice (relevant What-was-done / What's-next / decisions).
   # Save to /tmp/<ws>-handoff.md, then:
   node "$MEM" --dir="$MEM_DIR" write-handoff --workstream=<ws> --content=/tmp/<ws>-handoff.md
   ```

2. **Global handoff** — write `workstreams/handoff.md` (overall summary + cross-refs):
   ```markdown
   ### Per-workstream handoffs
   - lifecycle  → workstreams/lifecycle/handoff.md
   - research   → workstreams/research/handoff.md
   ```
   Use the Write tool directly for the global file.

If all items land in `_unassigned`, skip per-workstream writes and save only the global handoff.

## Phase 2: Reflect

Session analysis — run /reflect:

1. Check backlog.md — what's closed, what's new
2. Find workarounds, repetitions, gaps, insights
3. Show to user, wait for confirmation
4. Write to backlog + memory

## Phase 3: Docs-reflect

Check DOC: labels from the session:

```bash
node "$MEM" --dir="$MEM_DIR" docs
```

If DOC: labels found — run /docs-reflect:
1. Collect and group DOC: labels
2. Generalize, determine target files
3. Show to user, wait for confirmation
4. Write to `.claude/rules/` or `docs/`

If no DOC: labels — skip, report: "No documentation findings this session."

## Phase 4: Report

```
Session complete:
  ✓ Handoff saved to workstreams/handoff.md
  ✓ Reflect: N items → backlog.md
  ✓ Docs: N rules → .claude/rules/ (or: no DOC: notes)
  
On next start — /session-start will pick up the context.
```

## Rules

- Handoff = concise, 20-30 lines maximum
- Model recommendation — based on the type of the next task
- If there's nothing to save — say so, don't create an empty handoff
- Phases 2 and 3 can be skipped if the user requests a quick finish
- Each phase requires user confirmation before writing
