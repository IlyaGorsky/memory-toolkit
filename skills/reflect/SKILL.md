---
name: reflect
description: Session reflection — analyzes what happened, proposes backlog items, captures insights.
user-invocable: true
argument-hint: ""
---

# Reflect — session reflection

Analyze current session and propose additions to `backlog.md`.

## 1. Read context

```
Read: backlog.md
```

Read current backlog to avoid duplicates. If no backlog.md exists, create it.

## 2. Analyze session

Review what happened and find:

- **Workarounds** — bugs/problems worked around, not fixed
- **Repetitions** — pattern that appeared >1 time, asks for automation
- **Gaps** — skill/rule that was missing, had to do manually
- **Insights** — decisions worth scaling to other areas
- **Done** — what from backlog was completed this session

## 3. Propose items

Show list in format:

```
## Reflect: <date>

### New items
- **<section>**: <description> — <why, with specific case from session>

### Close
- <item that is done>

### Skip
- (nothing found / everything already in backlog)
```

**Do NOT write to backlog.md yet.** Show user, wait for confirmation.

## 4. After confirmation

Update `backlog.md`:
- New items → appropriate section (determine by domain)
- Closed items → `[x]`
- New section if needed

Also save insights to memory:
```bash
node "$MEM" note "REFLECT: <key insight from session>"
```

## 5. Check DOC: notes

```bash
node "$MEM" --dir="$MEM_DIR" docs
```

If DOC: notes exist — notify user: "Found N documentation findings. Run /docs-reflect to process them, or /session-end will handle it."

If called from /session-end — pass control to /docs-reflect automatically.

## Rules

- Don't duplicate what's already in backlog
- Quality over quantity — 1 good item beats 5 vague ones
- Wording: what to do + why (specific case from session)
- Done items stay in their section with [x], don't move to separate block
