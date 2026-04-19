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

## 1b. Collect watcher auto-findings

The session watcher captures decisions, plans, corrections, and phase changes in real time. Review them before analyzing manually — many candidates for backlog / DOC notes are already surfaced:

```bash
node "$MEM" --dir="$MEM_DIR" findings
```

Output groups entries by type (`decision`, `plan`, `correction`, `phase`). Treat them as candidates, not authoritative:
- **correction** — strong candidate for `feedback/` memory
- **decision** — candidate for `decisions/` or backlog
- **plan** — candidate for backlog entry
- **phase** — context only, usually skip

User confirms which findings promote to backlog / memory in step 3.

## 2. Analyze session

Review what happened and find:

- **Workarounds** — bugs/problems worked around, not fixed
- **Repetitions** — pattern that appeared >1 time, asks for automation
- **Gaps** — skill/rule that was missing, had to do manually
- **Insights** — decisions worth scaling to other areas
- **Done** — what from backlog was completed this session

### DOC classification check

For each insight, ask: "Should any contributor to this project know this?" If yes — it's a DOC, not just a backlog item or feedback. Save it immediately:

```bash
node "$MEM" --dir="$MEM_DIR" note "DOC: <domain> — <insight>"
```

Examples of what IS a DOC:
- Tool/framework choices: "use node:test, not vitest" — project convention
- Architecture decisions: "services return null, not throw" — pattern everyone must follow
- Build/deploy constraints: "no external deps in hooks" — technical requirement

Examples of what is NOT a DOC:
- Personal workflow preference: "I prefer short commit messages"
- One-time workaround: "had to restart dev server"
- Backlog item: "refactor auth module"

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

Also save insights to memory (included in the same confirmation — no separate prompt needed):
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
