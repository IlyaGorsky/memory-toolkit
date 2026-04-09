---
name: session-restore
description: Context restoration from .jsonl session backups. Parses history, builds chronology, saves key decisions to memory.
user-invocable: true
argument-hint: "[backup|restore|list|search <query>]"
---

# Session Restore — backup and context restoration

Parses `.jsonl` files of Claude Code sessions, extracts chronology and key decisions.

## Where data is stored

```
~/.claude/projects/-<project-key>/
├── <UUID>.jsonl          # current session (or completed)
├── <UUID>.jsonl.bak      # backup before last compact
└── <UUID>/
    └── subagents/        # subagent logs
```

## Commands

### `/session-restore list`

Show all sessions with dates and sizes:

```bash
SESSIONS_DIR=~/.claude/projects/-$(pwd | tr '/.' '-' | sed 's/^-//')
ls -lat "$SESSIONS_DIR"/*.jsonl 2>/dev/null | head -20
```

Output a table:
| File | Date | Size | .bak |

### `/session-restore restore`

Restore context from the latest (or specified) session:

1. **Find the file** — by default the most recent `.jsonl`, or by UUID from the argument
2. **Parse** — extract USER and CLAUDE messages using python3:

```python
import json, sys

path = sys.argv[1]
with open(path) as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    try:
        obj = json.loads(line.strip())
        role = obj.get('role', '?')
        msg_type = obj.get('type', '?')
        c = obj.get('message', {}).get('content', obj.get('content', ''))

        if isinstance(c, list):
            for item in c:
                if isinstance(item, dict):
                    tp = item.get('type', '')
                    if tp == 'text':
                        text = item.get('text', '').strip()
                        if role == '?' and msg_type == 'user':
                            if text and not text.startswith('<ide_') and not text.startswith('<system') and not text.startswith('<local-command') and not text.startswith('<command-') and len(text) > 5:
                                print(f'USER [{i}]: {text[:200]}')
                        elif role == '?' and msg_type == 'assistant':
                            if text and len(text) > 20:
                                print(f'  CLAUDE [{i}]: {text.split(chr(10))[0][:200]}')
        elif isinstance(c, str):
            clean = c.strip()
            if role == '?' and msg_type == 'user' and clean and not clean.startswith('<') and len(clean) > 3:
                print(f'USER [{i}]: {clean[:200]}')
            elif role == '?' and msg_type == 'assistant' and clean and len(clean) > 20:
                print(f'  CLAUDE [{i}]: {clean.split(chr(10))[0][:200]}')
    except:
        pass
```

3. **Group into blocks** — identify thematic blocks of the session (by topic changes)
4. **Show the user** a brief chronology:

```
## Session restoration <UUID>
Date: <file date>
Lines: <N>

### Block 1: <topic>
- <what was done>
- <key decisions>

### Block N: <topic>
- <what was done>
- **Last action:** <what was happening at the moment of termination/crash>
```

5. **Find the termination reason** — check the last 20 lines:
   - `API Error` — crash, specify the reason
   - `context` summary — compact, context was compressed
   - Normal termination — user closed the session

### `/session-restore backup`

Save current session state to memory:

1. Identify the current task (from todo, plan, or context)
2. Write to memory file `project_session_snapshot.md`:

```markdown
---
name: Session snapshot
description: Session state snapshot as of <date>
type: project
---

## Task
<what we are doing>

## Done
- <list>

## In progress
- <current step>

## Remaining
- <list>

## Key decisions
- <decisions that affect further work>
```

3. Update MEMORY.md if needed

### `/session-restore search <query>`

Search for a specific moment in session history:

1. **Find the file** — the most recent `.jsonl` (or `.jsonl.bak` for pre-compact history)
2. **Grep** — quick search through jsonl without full parsing:

```bash
grep -i "<query>" "$SESSIONS_DIR"/*.jsonl | head -30
```

3. **Context** — for each found fragment, show ±5 lines around it (to understand the topic):

```bash
grep -n -i "<query>" <file> | head -10
# for each line number:
sed -n '<line-5>,<line+5>p' <file>
```

4. **Parse the results** — extract text from JSON, filter out system messages
5. **Show the result**:

```
## Search: "<query>" in <file>
Found: N matches

### Match 1 (line N)
USER: <text>
CLAUDE: <text>

### Match 2 (line N)
...
```

6. If there are many results (>10) — show the first 5 and ask "show more?"
7. If not found in `.jsonl` — check `.jsonl.bak`

## Rules

- During restore DO NOT show system messages, ide_opened_file, tool calls — only USER and CLAUDE text
- Group by topics, not by lines — the user needs the big picture, not a log
- If `.bak` exists — it contains the full history before compact, `.jsonl` may contain a compact summary
- During backup do not duplicate what is already in memory files — only save what is missing
- For large sessions (>10K lines) parse in chunks using offset
