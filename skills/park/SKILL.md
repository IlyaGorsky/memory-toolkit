---
name: park
description: Park an idea, task or question for later — set it aside with its context, don't lose the thought.
user-invocable: true
argument-hint: "[what to park]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" *)
---

# /park — Set something aside

Parked is a state, not a kind of content: an idea, a task, a question put aside with its context to come back to. Does not close the session — only captures the thought. Unlike an ideas catalog, a parked item has to end: picked up, moved on, or dropped (see Step 5).

## Step 1: Determine what to park

From the argument or from the context of recent messages, determine:

- **What** — the essence (1-2 sentences)
- **Kind** — idea, task or question
- **Why** — what problem it solves or why it matters
- **Workstream** — which workstream it belongs to (from `workstreams.json`), or none
- **Context** — key details from the current conversation that would be lost without recording
- **Next step** — what to do when coming back

If unclear — ask the user briefly.

## Step 2: Choose the form

1. **Item** (default) — one file per item, so Claude Code's recall can bring it back by its description when the topic returns. Save the draft to /tmp/park.md:

```markdown
---
name: {short title}
description: {one line — what it is and when it matters}
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

2. **Quick line** — when the thought is raw and stopping to structure it costs more than it's worth:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" note "PARKED: {essence}"
```

## Step 3: Propose & confirm

**MUST show the user what will be saved and where BEFORE writing anything:**

```
Park this?
  What: {essence}
  Kind: {idea | task | question}
  Workstream: {name, or none}

Save? (yes/skip)
```

**Wait for explicit confirmation. Do NOT write until the user confirms.**

## Step 4: Write

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" park --title="{short title}" --kind={kind} --workstream={name} --content=/tmp/park.md
```

Omit `--workstream` when the item belongs to none: it goes to `parked/`. Within a workstream it goes to `workstreams/{name}/`. The command stamps `category: parked` and the date and never overwrites. Show its output as the receipt.

## Step 5: The exit

A parked item is done when it was picked up, moved to the backlog, a decision or an ideas catalog, or dropped. Then remove it and record where it went:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" parked [<workstream>]                 # what is parked, oldest flagged
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" unpark <file> --to={picked-up|backlog|decision|ideas|drop}
```

Move the content first if it goes somewhere; `unpark` only removes the item and notes the exit.

## Rules

- Do not close the session — the user continues working
- Do not duplicate — if it is already in the backlog or memory, point out where
- Context from the conversation matters more than wording — better to record it raw than to lose it
- One park = one item. If there are several — offer to park them one by one
- If the user did not provide an argument — suggest the last discussed topic
