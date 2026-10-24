---
name: memory
description: Project memory — search, workstreams, notes, decisions. Auto-initializes on first use.
user-invocable: true
argument-hint: "<command> [args] [--brief] — search <query> | workstream <name> | workstreams | add-workstream <name> <kw...> | recent [n] | decisions [topic] | list | note <text> | handoff [<ws>] | identity <ws> [--material] | unassigned"
---

# /memory — Project Memory

---

## Step 0: Resolve memory directory

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" dir   # same folder as CC auto-memory (git root); prints the path, exits 1 if no memory yet
```

`memory.js` resolves the memory dir from cwd itself — no `--dir` needed. Each bash block runs in a fresh shell, so do not rely on variables set in another block.

---

## If not initialized (no memory.js and no plugin found)

Bootstrap for this project:

1. Create memory dir: `mkdir -p "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" dir)"` (prints the path even when it does not exist yet)
2. Do NOT copy `memory.js` if the plugin is installed — use `${CLAUDE_PLUGIN_ROOT}/scripts/memory.js`. Only copy if the plugin is not installed.
3. Ask: "What workstreams does the project have?" → create `workstreams.json`
4. Ask: "Describe your role in 1-2 sentences" → Profile
5. Ask: "Key links?" → Reference
6. Create MEMORY.md:

```markdown
# {Project} — Memory

## API
\```bash
node {absolute path to memory.js} <command>
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

7. Verify: `node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" list`
8. "Memory ready. You can start working — `/memory` for lookup."

---

## Commands (when initialized)

All commands resolve the memory dir from cwd (or from the symlink location when called as `memory/memory.js`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" <command> [args]
```

### No arguments
Show workstreams + quick actions:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" workstreams
```

### search <query>
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" search "<query>"
```
Summarize — don't dump raw. Highlight relevant to current task.

### workstream <name>
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" workstream "<name>"
```

### workstreams
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" workstreams
```

### add-workstream <name> <keywords...>
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" add-workstream "<name>" <keywords...>
```

### recent [n]
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" recent <n>
```

### decisions [topic]
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" decisions "<topic>"
```

### list [type]
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" list <type>
```

### note <text>
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" note "<text>"
```

### handoff [<workstream>]
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" handoff              # global handoff
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" handoff <workstream> # per-ws (falls back to global)
```
Prints `NO_HANDOFF` when neither per-workstream nor global file exists.

### write-handoff --workstream=<name> --content=<file>
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" write-handoff --workstream=<name> --content=<path>
```
Atomic write to `workstreams/<name>/handoff.md`. Frontmatter auto-added.

### identity <workstream> [--material]
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" identity <workstream>             # the card, or NO_IDENTITY
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" identity <workstream> --material  # + decisions to draft it from
```
Identity (`workstreams/<name>/workstream.md`) says what the workstream is, why, and what it doesn't do: What is this / Why / Principles / Not doing / Scope / Status. Draft it from `--material` (decisions, corrections and reflections the watcher already logged), show the draft, write only after the user agrees. Keep it under ~40 lines — history goes to handoff. A flat `workstreams/<name>.md` is read as a legacy card.

### write-identity --workstream=<name> --content=<file>
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" write-identity --workstream=<name> --content=<path>
```
Writes `workstreams/<name>/workstream.md`; adds `type: project`, `category: identity` frontmatter if missing.

### unassigned [--days=30]
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" unassigned
```
Decisions that match no workstream's keywords, by day — material for proposing a new workstream when a theme recurs.

### signals [--mark-reviewed]
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" signals                  # JSON: identity gaps, new-workstream signal
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" signals --mark-reviewed  # after offering, whatever the answer
```
The SessionStart hook turns these into an offer. Workstreams are optional: offer once, then mark reviewed.

### classify --items=<json>
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" classify --items=<path-to-json>
```
Keyword-routes items by `workstreams.json`. Multi-label, case-insensitive. Unmatched → `_unassigned`.

### session-activity
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" session-activity
```
Current session's items (and DOC: subset) since last `SESSION_START` marker in today's notes. JSON output.

### session-changes
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" session-changes
```
Git commits + files union since session start. JSON output. Pipe with `session-activity` into `classify` for routing analysis (see `/session-end` Phase 1b).

### docs
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" docs
```
`DOC:` notes since the last review (`DOCS_REVIEWED` marker) for `/docs-reflect`. `--all` lists every one; `--mark-reviewed` closes a review.

### recurring
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" recurring
```
Find recurring feedback patterns.

### reindex
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" reindex
```
Rebuild MEMORY.md index sorted by weight.

### health
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" health
```
Check for dead links, stale entries, size overflow, duplicates.

---

## Rules

- Don't dump raw output — summarize and highlight relevant
- If not initialized → bootstrap automatically, don't error
- MEMORY.md = index. Detailed content in separate .md files
