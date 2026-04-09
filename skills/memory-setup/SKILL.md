---
name: memory-setup
description: Initialize or upgrade project memory for memory-toolkit. Works with existing auto-memory.
user-invocable: true
argument-hint: "[--fresh]"
---

# /memory-setup — Initialize or upgrade project memory

Detects existing memory, adds what's missing, doesn't overwrite anything.

---

## Step 1: Find memory directory

```bash
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PROJ_KEY=$(echo "$GIT_ROOT" | tr '/.' '-' | sed 's/^-//')
MEM_DIR="$HOME/.claude/projects/-${PROJ_KEY}/memory"
```

Check what already exists:

```bash
echo "=== Memory dir: $MEM_DIR ==="
[ -d "$MEM_DIR" ] && echo "DIR: exists" || echo "DIR: missing"
[ -f "$MEM_DIR/MEMORY.md" ] && echo "MEMORY.md: exists" || echo "MEMORY.md: missing"
[ -f "$MEM_DIR/memory.js" ] && echo "memory.js: exists" || echo "memory.js: missing"
[ -f "$MEM_DIR/workstreams.json" ] && echo "workstreams.json: exists" || echo "workstreams.json: missing"
ls "$MEM_DIR"/*.md 2>/dev/null | wc -l | xargs -I{} echo "MD files: {}"
ls -d "$MEM_DIR"/*/ 2>/dev/null | wc -l | xargs -I{} echo "Subdirs: {}"
```

Report findings to the user before making any changes.

---

## Step 2: Branch by state

### A) No memory dir at all → fresh setup

If `--fresh` argument or no `$MEM_DIR`:

1. `mkdir -p "$MEM_DIR"`
2. If no `CLAUDE_PLUGIN_ROOT`: `cp /path/to/memory-toolkit/scripts/memory.js "$MEM_DIR/"`
3. Ask: "What are the main workstreams in this project?" → create `workstreams.json`
4. Ask: "Describe your role in 1-2 sentences" → create `profile/role.md`
5. Ask: "Key links (Jira, Figma, Slack, docs)?" → create `reference/links.md`
6. Create MEMORY.md from template (see Step 4)
7. Create subdirectories: `mkdir -p "$MEM_DIR"/{feedback,decisions,profile,reference,notes,workstreams}`

### B) Existing MEMORY.md → upgrade in place

This is the common path for users with Claude Code auto-memory.

1. **Backup MEMORY.md** before any changes:
   ```bash
   cp "$MEM_DIR/MEMORY.md" "$MEM_DIR/MEMORY.md.backup.$(date +%Y%m%d-%H%M%S)"
   ```
   Tell the user: "Backed up MEMORY.md to MEMORY.md.backup.{timestamp}"
2. Read existing MEMORY.md — understand current structure
3. Copy `memory.js` if missing
4. Analyze existing `.md` files — detect types from frontmatter
5. Propose changes (don't apply yet)

---

## Step 3: Upgrade checklist (for path B)

Show the user what will be added/changed:

```text
## Memory setup for {project}

Found: {N} memory files, MEMORY.md ({lines} lines)

Proposed changes:
  [ ] Backup MEMORY.md → MEMORY.md.backup.{timestamp}
  [ ] Ensure memory.js accessible (plugin or manual copy)
  [ ] Add API block to MEMORY.md
  [ ] Add Rules block to MEMORY.md  
  [ ] Add Session lifecycle block to MEMORY.md
  [ ] Create workstreams.json from existing files
  [ ] Create subdirectories (feedback/, decisions/, etc.)
  [ ] Move files to subdirectories by type

Already in place:
  [x] MEMORY.md exists
  [x] {list what's already there}

Proceed? (or pick specific items)
```

Wait for user confirmation before making changes.

---

## Step 4: Apply changes

### 4a: Resolve memory.js path

Find memory.js — plugin install path first, then local copy:

```bash
PLUGIN_MEM=$(claude plugin list --json 2>/dev/null | node -e "
  try { const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const p=d.find(x=>x.id.includes('memory-toolkit'));
  if(p)console.log(p.installPath+'/scripts/memory.js') } catch{}" 2>/dev/null)

if [ -n "$PLUGIN_MEM" ] && [ -f "$PLUGIN_MEM" ]; then
  MEM="$PLUGIN_MEM"
elif [ -f "$MEM_DIR/memory.js" ]; then
  MEM="$MEM_DIR/memory.js"
else
  MEM=$(find ~/.claude/plugins/cache -name "memory.js" -path "*/memory-toolkit/*/scripts/*" 2>/dev/null | head -1)
fi
```

**Do NOT copy** `memory.js` if the plugin is installed — use the resolved `$MEM` path.
Only copy as last resort if plugin is not installed and no `$MEM` found.

Use `$MEM` as an absolute path when writing the API block into MEMORY.md.

### 4b: Update MEMORY.md

Read current MEMORY.md. Ensure the structure follows this order:

1. **Heading** (first line)
2. **API block** (lines 3-6) — always near the top
3. **Rules block** (lines 8-30) — always before index entries
4. **Index entries** — the rest of the file

This order matters: Claude Code truncates MEMORY.md after 200 lines. By keeping API and Rules at the top, they survive truncation even if auto-memory adds many index entries.

**API block** (add if missing, right after heading — use the absolute `$MEM` path resolved in 4a):
```markdown
## API
```bash
node {absolute path to memory.js} --dir={MEM_DIR} <command>
```
```

**Rules block** (add if missing, after API and before index entries):
```markdown
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
- workstreams.json = source of truth for workstream aliases
- Use --brief for quick overviews, full output only when needed

### Session lifecycle
- Start of work → /session-start or /session-continue
- Ideas for later → /park (don't lose the thought)
- After big block of work → /reflect
- Before compact: save key decisions + update handoff
- Long session + topic changed → suggest /session-end
- End of work → /session-end (handoff for next session)
```

Do NOT remove or rewrite existing content in MEMORY.md. Only add new blocks.

### 4c: Create workstreams.json

Scan existing files for patterns — group by frontmatter `type` or directory:

```bash
node "$MEM_DIR/memory.js" --dir="$MEM_DIR" list
```

Ask: "Based on these files, I see topics like {X, Y, Z}. Want me to create workstreams for them?"

### 4d: Create subdirectories and move files

Only if user agrees. For each `.md` file with frontmatter `type`:

```
type: feedback  → feedback/
type: project   → decisions/ or notes/ (by content)
type: user      → profile/
type: reference → reference/
```

After moving files — update paths in MEMORY.md index.

### 4e: Verify

```bash
node "$MEM_DIR/memory.js" --dir="$MEM_DIR" list
node "$MEM_DIR/memory.js" --dir="$MEM_DIR" workstreams
```

---

## Step 5: Summary

```text
## Setup complete

Memory: $MEM_DIR
Files: {N} ({moved} organized into subdirectories)
Workstreams: {list}
MEMORY.md: updated ({added blocks})

Ready to use:
  /session-start    — begin a session
  /memory search    — search memory
  /memory workstream <name> — load workstream context
```

---

## Step 6: Auto-memory protection (optional)

Explain the 200-line limit to the user and offer protection options:

```
## Auto-memory protection

Claude Code's auto-memory writes to MEMORY.md automatically. The file is 
truncated after 200 lines — anything below line 200 silently disappears 
from context.

Your MEMORY.md is currently {N} lines. Options:

1. Keep as-is — auto-memory enabled, Rules block is at the top (safe)
2. Disable auto-memory — plugin handles memory, no auto-writes:
   Add to settings.json: { "autoMemoryEnabled": false }
3. Trim index — move old entries to archive, keep MEMORY.md under 150 lines

Which do you prefer? (1/2/3 or skip)
```

If user chooses 2:
```json
// Add to ~/.claude/settings.json or .claude/settings.json
{ "autoMemoryEnabled": false }
```

If user chooses 3 — identify entries that can be removed (old, superseded, or redundant) and propose which to cut. Move to `memory-backup/` rather than deleting.

---

## Rules

- Always backup MEMORY.md before modifying it
- Never overwrite or delete existing files
- Always show proposed changes before applying
- Preserve all existing MEMORY.md content
- If MEMORY.md is already >150 lines, warn about the 200-line limit and suggest trimming
- If user says "just do it" — apply all changes without individual confirmations
- If `--fresh` flag — skip detection, create everything from scratch
