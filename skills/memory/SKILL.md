---
name: memory
description: Project memory — search, workstreams, notes, decisions. Auto-initializes on first use.
user-invocable: true
argument-hint: "<command> [args] [--brief] — search <query> | workstream <name> | workstreams | add-workstream <name> <kw...> | recent [n] | decisions [topic] | list | note <text> | handoff [<ws>] | card <ws> [--material] | unassigned"
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" write-handoff --global --content=<path>   # workstreams/handoff.md
```
Frontmatter auto-added; `modified` and `branch` are stamped so the SessionStart hook can flag an old or other-branch handoff.

### card <workstream> [--material]
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" card <workstream>             # the card, or NO_CARD
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" card <workstream> --material  # + decisions to draft or update it from
```
A workstream — a task, an experiment, an area — lives in a card, `workstreams/<name>.md`, kept current during work: what it is, why, what it doesn't do, where results live, what's open — sections as the workstream needs, status in free words. When a decision, an iteration result or an open question about it comes up, offer to update the card; draft from `--material` (decisions, corrections and reflections the watcher logged, newest first, with a marker where the card was last updated). Show the change, write only after the user agrees. Past ~150 lines move finished iterations out.

### write-card --workstream=<name> --content=<file>
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" write-card --workstream=<name> --content=<path>
```
Writes `workstreams/<name>.md` (not the Write tool: CC's stamper would reshuffle the frontmatter); adds `type: project`, `category: workstream` if missing and stamps `modified`.

### receipt [--json]
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" receipt
```
What this session left: memory files it wrote (by `originSessionId`), decisions / corrections / DOC / commits logged since its start, the workstreams it moved and whether their cards were updated. Writes nothing.

### park / parked / unpark
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" park --title="<title>" --content=<path> [--workstream=<name>] [--kind=idea|task|question]
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" parked [<workstream>]          # parked items, oldest flagged, plus recent PARKED: notes
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" unpark <file> --to=<where>     # the exit: picked-up | backlog | decision | ideas | drop
```
Parked is a state with an exit, not an ideas catalog: one file per item (`workstreams/<name>/<slug>.md`, or `parked/<slug>.md`), so recall can surface it. Use `/park` to draft and confirm.

### unassigned [--days=30]
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" unassigned
```
Decisions that match no workstream's keywords, by day — material for proposing a new workstream when a theme recurs.

### signals [--mark-reviewed]
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.js" signals                  # JSON: cards, card gaps (none or behind), new-workstream signal
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
