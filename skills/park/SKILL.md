---
name: park
description: Park an idea or task for the next session — save context, don't lose the thought.
user-invocable: true
argument-hint: "[idea name]"
---

# /park — Park an idea

Quickly save an idea/task from the current session to pick up in the next one. Does not close the session — only captures the thought.

## Step 1: Determine what to park

From the argument or from the context of recent messages, determine:

- **What** — the essence of the idea/task (1-2 sentences)
- **Why** — what problem it solves
- **Workstream** — which workstream it belongs to (from `workstreams.json` or a new one)
- **Context** — key details from the current conversation that would be lost without recording

If unclear — ask the user briefly.

## Step 2: Choose where to save

By priority:

1. **Existing workstream file** — if the idea belongs to an active workstream, append to its file
2. **New file in ideas** — if it's a new topic:

```markdown
---
name: {short name}
description: {one line — for search via memory.js}
type: project
---

## What
{essence}

## Why
{problem it solves}

## Context
{key details from the conversation}

## Next step
{what to do when you come back to this}
```

3. **Quick note** — if the idea is raw and has no structure:

```bash
node $MEM/memory.js note "{essence of the idea}"
```

## Step 3: Update MEMORY.md

If a new file was created — add a line to the MEMORY.md index.

## Step 4: Confirm

Show the user:

```
Parked: {name}
File: {path}
Pick up: /session-start {workstream}
```

## Rules

- Do not close the session — the user continues working
- Do not duplicate — if the idea is already in backlog or memory, point out where
- Context from the conversation matters more than wording — better to record it raw than to lose it
- One park = one idea. If there are multiple — offer to park them one by one
- If the user did not provide an argument — suggest the last discussed topic
