---
name: session-insights
description: Extract insights from past .jsonl sessions — problems, decisions, friction points. Analyzes sessions you can't see in current context.
user-invocable: true
argument-hint: "[ticket|session-id|workstream]"
---

# /session-insights — Extract insights from past sessions

Parse `.jsonl` session transcripts and extract structured insights: problems, decisions, patterns, friction points. Works on sessions outside the current context.

## Step 1: Find sessions

Resolve memory directory, then find sessions by argument:

```bash
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PROJ_KEY=$(echo "$GIT_ROOT" | tr '/.' '-' | sed 's/^-//')
SESSIONS_DIR="$HOME/.claude/projects/-${PROJ_KEY}/"
```

- **Ticket/keyword** — grep across all `.jsonl` files
- **Session ID** — specific file by UUID
- **Workstream** — use `node "$MEM" --dir="$MEM_DIR" workstream <name>` for context, match by dates/keywords
- **No argument** — most recent session

```bash
grep -l "<query>" "$SESSIONS_DIR"*.jsonl 2>/dev/null | head -10
```

Also check session index if available:
```bash
cat "$MEM_DIR/sessions.jsonl" 2>/dev/null
```

## Step 2: Extract user messages

For each session found:

```python
import json, sys

with open(sys.argv[1]) as f:
    for i, line in enumerate(f):
        try:
            obj = json.loads(line.strip())
            if obj.get('type') != 'user':
                continue
            c = obj.get('message', {}).get('content', obj.get('content', ''))
            if isinstance(c, list):
                for item in c:
                    if isinstance(item, dict) and item.get('type') == 'text':
                        text = item.get('text', '').strip()
                        if text and not text.startswith('<') and len(text) > 5:
                            print(text[:300])
            elif isinstance(c, str):
                text = c.strip()
                if text and not text.startswith('<') and len(text) > 5:
                    print(text[:300])
        except:
            pass
```

## Step 3: Analyze

Extract structured insights from the user messages:

1. **Problems** — what didn't work, was redone, caused friction
2. **Decisions** — what was chosen and why (architectural, process)
3. **Insights** — non-obvious conclusions, patterns, reassessments
4. **Friction points** — where the agent repeatedly failed, what required many iterations

Format:

```
## Session insights: <date range or session id>

### Problems
- <description> → <resolution or status>

### Decisions
- <what> — <why>

### Insights
- <insight> — <evidence from session>

### Friction
- <what> (×N iterations) — <root cause>
```

## Step 4: Save

Ask the user:

- "Save insights to memory?" → create files in `feedback/` or `decisions/`
- "Add friction points to backlog?" → append to `backlog.md`
- "Mark as DOC:?" → `node "$MEM" --dir="$MEM_DIR" note "DOC: <domain> — <insight>"` for /docs-reflect
- "Skip" → display only

## Rules

- Filter system messages, ide_opened_file, tool calls — only USER text
- Large sessions (>50KB user text) — split into chunks
- Don't dump raw output — format into readable blocks
- If multiple sessions found for a query — combine chronologically
- If session index (`sessions.jsonl`) exists — use it for faster lookup
