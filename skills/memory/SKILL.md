---
name: memory
description: Project memory — search, workstreams, notes, decisions. Auto-initializes on first use.
user-invocable: true
argument-hint: "<command> [args] [--brief] — search <query> | workstream <name> | workstreams | add-workstream <name> <kw...> | recent [n] | decisions [topic] | list | note <text>"
allowed-tools: Bash,Read,Write,Glob,Grep
---

# /memory — Project Memory

---

## Step 0: Resolve memory directory

```bash
# Claude Code uses git root (not cwd) and replaces / and . with - for project key
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PROJ_KEY=$(echo "$GIT_ROOT" | tr '/.' '-' | sed 's/^-//')
MEM_DIR="$HOME/.claude/projects/-${PROJ_KEY}/memory"
```

Resolve `memory.js`:
```bash
MEM="${CLAUDE_PLUGIN_ROOT}/scripts/memory.js"
```

---

## If not initialized (no memory.js and no plugin found)

Bootstrap for this project:

1. Create memory dir: `mkdir -p "$MEM_DIR"`
2. Do NOT copy `memory.js` if the plugin is installed — use `$MEM` resolved above. Only copy if plugin is not installed and no `$MEM` found.
3. Ask: "What workstreams does the project have?" → create `workstreams.json`
4. Ask: "Describe your role in 1-2 sentences" → Profile
5. Ask: "Key links?" → Reference
6. Create MEMORY.md:

```markdown
# {Project} — Memory

## API
\```bash
node {absolute $MEM path} --dir={MEM_DIR} <command>
\```

## Profile
{user answer}

## Rules

### Save
- Decision with reasoning → memory file with **Why:** and **How to apply:**
- User corrects you or confirms non-obvious choice → feedback memory
- Something surprising or counter-intuitive → note + memory
- Convert relative dates to absolute: "Thursday" → "2026-04-10"

### Don't save
- What git log already knows (commits, who changed what)
- What the code already shows (patterns, architecture)
- What CLAUDE.md already says
- Ephemeral task state (use TodoWrite)

### Format
- MEMORY.md = index only, max 200 lines. Details in separate .md files
- Each .md file has frontmatter: name, description, type (feedback/project/user/reference)
- workstreams.json = source of truth for aliases
- Use --brief for quick overviews, full output only when needed

### Session lifecycle
- Start of work → /session-start or /session-continue
- Ideas for later → /park (don't lose the thought)
- After big block of work → /reflect (workarounds, repetitions, insights → backlog)
- Before compact: save key decisions + update handoff
- Long session + topic changed → suggest /session-end
- End of work → /session-end (handoff for next session)

## Reference
{user links}
```

7. Verify: `node "$MEM" --dir="$MEM_DIR" list`
8. "Memory ready. You can start working — `/memory` for lookup."

---

## Commands (when initialized)

All commands pass `--dir=$MEM_DIR` to ensure correct memory directory (required when memory.js is a symlink to plugin):
```bash
node "$MEM" --dir="$MEM_DIR" <command> [args]
```

### No arguments
Show workstreams + quick actions:
```bash
node "$MEM" --dir="$MEM_DIR" workstreams
```

### search <query>
```bash
node "$MEM" --dir="$MEM_DIR" search "<query>"
```
Summarize — don't dump raw. Highlight relevant to current task.

### workstream <name>
```bash
node "$MEM" --dir="$MEM_DIR" workstream "<name>"
```

### workstreams
```bash
node "$MEM" --dir="$MEM_DIR" workstreams
```

### add-workstream <name> <keywords...>
```bash
node "$MEM" --dir="$MEM_DIR" add-workstream "<name>" <keywords...>
```

### recent [n]
```bash
node "$MEM" --dir="$MEM_DIR" recent <n>
```

### decisions [topic]
```bash
node "$MEM" --dir="$MEM_DIR" decisions "<topic>"
```

### list [type]
```bash
node "$MEM" --dir="$MEM_DIR" list <type>
```

### note <text>
```bash
node "$MEM" --dir="$MEM_DIR" note "<text>"
```

---

## Rules

- Don't dump raw output — summarize and highlight relevant
- If not initialized → bootstrap automatically, don't error
- MEMORY.md = index. Detailed content in separate .md files
