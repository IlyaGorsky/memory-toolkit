---
name: reflect
description: Session reflection — analyzes what happened, proposes backlog items, captures insights.
user-invocable: true
argument-hint: ""
---

# Reflect — session reflection

Analyze current session and propose additions to the project backlog.

## 1. Find backlog target

Check memory for saved preference:
```bash
node "$MEM" --dir="$MEM_DIR" search "backlog_target"
```

If no saved preference — detect automatically:
1. Check common locations: `backlog.md`, `TODO.md`, `TODO`, `docs/backlog.md`
2. Check if project uses GitHub Issues: `gh issue list --limit 1 2>/dev/null`
3. If nothing found — ask:

```
Where do you track backlog?
  1. backlog.md (will create)
  2. TODO.md
  3. GitHub Issues (gh issue create)
  4. Other — specify path or tool
```

Save preference:
```bash
node "$MEM" --dir="$MEM_DIR" note "CONFIG: backlog_target=<chosen path or github-issues>"
```

Read current backlog to avoid duplicates.

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

**Do NOT write yet.** Show user, wait for confirmation.

## 4. After confirmation

Update the backlog target:
- **File-based** (backlog.md, TODO.md, etc.): add items to appropriate section, mark closed with `[x]`
- **GitHub Issues**: `gh issue create --title "<item>" --body "<why>"` for each new item; `gh issue close <number>` for closed

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
