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

**Before creating anything, show the user what will be set up:**

```
Fresh memory setup for this project:
  Dir: {MEM_DIR}
  Will create: MEMORY.md, workstreams.json, memory-schema.json
  Subdirs: feedback/, decisions/, profile/, reference/, notes/, workstreams/
  Will ask: workstreams, role, language, key links

Proceed? (yes/skip)
```

**Wait for confirmation before creating any files.**

1. `mkdir -p "$MEM_DIR"`
2. If no `CLAUDE_PLUGIN_ROOT`: `cp /path/to/memory-toolkit/scripts/memory.js "$MEM_DIR/"`
3. Ask: "What are the main workstreams in this project?" → create `workstreams.json`
4. Ask: "Describe your role in 1-2 sentences" → create `profile/role.md`
5. Ask: "What language do you prefer for documentation and rules? (e.g. English, Russian)" → create `profile/language.md`
6. Ask: "Key links (Jira, Figma, Slack, docs)?" → create `reference/links.md`
7. Create MEMORY.md from template (see Step 4)
8. Copy memory-schema.json: `cp "${CLAUDE_PLUGIN_ROOT}/scripts/lib/memory-schema.default.json" "$MEM_DIR/memory-schema.json"`
9. Create subdirectories: `mkdir -p "$MEM_DIR"/{feedback,decisions,profile,reference,notes,workstreams}`

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
  [ ] Create memory-schema.json (weighted eviction config)
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

```bash
MEM="${CLAUDE_PLUGIN_ROOT}/scripts/memory.js"
```

Use `$MEM` as an absolute path when writing the API block into MEMORY.md.

### 4b: Update MEMORY.md

Read current MEMORY.md. Ensure the structure follows this order:

1. **Heading** (first line)
2. **API block** (lines 3-6) — always near the top
3. **Rules block** (lines 8-30) — always before index entries
4. **Index entries** — the rest of the file

This order matters: Claude Code truncates MEMORY.md after 200 lines. By keeping API and Rules at the top, they survive truncation even if auto-memory adds many index entries.

**API block** (add if missing, right after heading — one compact line, use the absolute `$MEM` path resolved in 4a):
```markdown
## API
`node {absolute path to memory.js} --dir={MEM_DIR} <command>`
```

**Rules block** (add if missing, after API and before index entries).

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

### 4d: Add workstreams to MEMORY.md index

After creating workstreams.json, add a Workstreams section to MEMORY.md so they are visible in the index:

```markdown
## Workstreams
- **{name}** — keywords: {keywords}
```

This ensures agents see workstreams without running `memory.js workstreams`.

### 4e: Create subdirectories and move files

Only if user agrees. For each `.md` file with frontmatter `type`:

```
type: feedback  → feedback/
type: project   → decisions/ or notes/ (by content)
type: user      → profile/
type: reference → reference/
```

After moving files — update paths in MEMORY.md index.

### 4f: Create memory-schema.json


If `memory-schema.json` is missing in `$MEM_DIR`:

```bash
if [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/lib/memory-schema.default.json" ]; then
  cp "${CLAUDE_PLUGIN_ROOT}/scripts/lib/memory-schema.default.json" "$MEM_DIR/memory-schema.json"
  echo "Created memory-schema.json (weighted eviction config)"
fi
```

This file controls section protection and eviction weights for `memory.js reindex`. Never overwrite if it already exists — user may have customized it.

### 4g: Verify


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

## Step 6: Mode selection (optional)

Explain the two modes and let the user choose. **Default is Collaborative — no action required.**

```
## Memory mode

memory-toolkit works alongside Claude Code's built-in auto-memory.
Two modes available:

1. Collaborative (default, already active)
   CC auto-memory captures facts automatically.
   memory-toolkit organizes them into workstreams, lifecycle, handoffs.
   Both write to MEMORY.md — they complement each other.

2. Exclusive (opt-in)
   Only memory-toolkit manages memory. No auto-writes from CC.
   Full control over format. Requires manual discipline.
   Add to settings.json: { "autoMemoryEnabled": false }

Your MEMORY.md is currently {N} lines (limit: 200).
{If >150: ⚠ Consider trimming — run /memory workstreams to see what's there.}

Stay in Collaborative mode? (press Enter to skip, or type "exclusive" to opt in)
```

Only switch to Exclusive if user explicitly requests it. Warn: "Auto-memory will no longer write to MEMORY.md — memory-toolkit handles everything."

If user wants to trim — identify entries that can be removed (old, superseded, redundant) and propose which to cut. Move to `memory-backup/` rather than deleting.

---

## Rules

- Always backup MEMORY.md before modifying it
- Never overwrite or delete existing files
- Always show proposed changes before applying
- Preserve all existing MEMORY.md content
- If MEMORY.md is already >150 lines, warn about the 200-line limit and suggest trimming
- If user says "just do it" — apply all changes without individual confirmations
- If `--fresh` flag — skip detection, create everything from scratch
