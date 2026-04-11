# Installation

## Quick start

Two commands — Claude Code clones the repo, registers it as a marketplace, and installs the plugin:

```bash
claude plugin marketplace add IlyaGorsky/memory-toolkit
claude plugin install memory-toolkit
```

The plugin loads automatically in every session afterwards. To update later:

```bash
claude plugin update memory-toolkit
```

## Local clone (for contributors)

If you want to hack on the plugin and have your edits picked up live, register a directory marketplace pointing at your checkout:

```bash
git clone https://github.com/IlyaGorsky/memory-toolkit.git
cd memory-toolkit
claude plugin marketplace add .
claude plugin install memory-toolkit
```

Edits to skills, hooks, and scripts in this checkout become visible to Claude Code on the next session start (no reinstall needed).

> **Heads-up:** if you previously installed the plugin from the github source, you'll need to `claude plugin marketplace remove memory-toolkit` first — marketplace names are global and a registration with the same name cannot coexist.

## Per-session (no install)

Load for a single session without installing globally:

```bash
claude --plugin-dir /path/to/memory-toolkit
```

## Manual copy

Copy skills and hooks into your Claude Code config manually:

```bash
# Skills
cp -r skills/* ~/.claude/skills/

# Hooks — merge into your existing settings
# Add the contents of hooks/hooks.json to ~/.claude/settings.json under "hooks"
# Replace ${CLAUDE_PLUGIN_ROOT} with the actual path to the repo:
#   node /path/to/memory-toolkit/scripts/session-save.js
#   node /path/to/memory-toolkit/scripts/memory.js ...
```

With manual copy, `${CLAUDE_PLUGIN_ROOT}` is not available — you must use absolute paths in hook commands.

## Existing auto-memory users

If you already have Claude Code's auto-memory (`~/.claude/projects/*/memory/MEMORY.md`), the plugin works with your existing files — nothing is lost or overwritten.

### What the plugin adds

The plugin provides skills (`/session-start`, `/memory`, `/reflect`, etc.) and hooks that use `memory.js` — a CLI tool for searching, filtering, and managing memory files. Your existing `.md` files and `MEMORY.md` index remain the source of truth.

### Setup for an existing project

1. **Run `/memory`** in your project — the skill auto-detects the memory directory and bootstraps `memory.js` if missing.

   Or copy manually:
   ```bash
   # Find your project's memory dir
   PROJ_KEY=$(git rev-parse --show-toplevel | tr '/.' '-' | sed 's/^-//')
   MEM_DIR="$HOME/.claude/projects/-${PROJ_KEY}/memory"

   # Copy memory.js
   cp /path/to/memory-toolkit/scripts/memory.js "$MEM_DIR/"
   ```

2. **Add the API block** to the top of your MEMORY.md (after the heading):
   ```markdown
   ## API
   ```bash
   node ~/.claude/projects/-Your-Project-Key/memory/memory.js <command>
   ```
   ```
   This tells Claude how to call the memory API in future sessions.

3. **(Optional) Create workstreams.json** if you want workstream support:
   ```bash
   cd "$MEM_DIR"
   node memory.js add-workstream my-feature keyword1 keyword2
   ```

4. **(Optional) Organize files into subdirectories** for better filtering:
   ```
   memory/
   ├── MEMORY.md
   ├── memory.js
   ├── workstreams.json
   ├── feedback/
   ├── decisions/
   ├── profile/
   ├── reference/
   ├── notes/
   └── workstreams/
   ```
   Existing flat `.md` files continue to work — subdirectories are optional but improve `memory.js list <type>` filtering.

### What stays the same

- Auto-memory still writes to the same directory
- MEMORY.md is still loaded into every conversation
- Your existing frontmatter format (`name`, `description`, `type`) is compatible
- Nothing is migrated or moved automatically

### Protecting your MEMORY.md

Claude Code truncates MEMORY.md after 200 lines / 25KB. Auto-memory extraction adds entries over time, which can silently push your rules and commands past the limit.

**Option 1: Structural protection (default)**
`/memory-setup` places API and Rules blocks at the top of MEMORY.md. Even if auto-memory fills up the index below — your rules survive truncation.

**Option 2: Disable auto-memory**
If you want full control, disable the built-in auto-memory extraction:
```json
// In ~/.claude/settings.json or .claude/settings.json
{ "autoMemoryEnabled": false }
```
The plugin's hooks and skills will still work — they write to separate files (`notes/`, `workstreams/handoff.md`, `sessions.jsonl`), not to MEMORY.md directly.

**Option 3: Keep both**
Leave auto-memory enabled and let `/memory-setup` manage the structure. Run `/memory-setup` periodically to check MEMORY.md size and trim if needed.

## Verify

After installation, start a new Claude Code session and check:

```bash
# Skills should appear in /help
/memory search test

# Plugin should be listed
claude plugin list
```
