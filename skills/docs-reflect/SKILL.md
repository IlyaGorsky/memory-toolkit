---
name: docs-reflect
description: Collect DOC: notes from session, generalize, and propose repo documentation (.claude/rules/, docs/).
user-invocable: true
argument-hint: "[optional focus area]"
---

# /docs-reflect — Session knowledge → repo documentation

Collect DOC: notes accumulated during the session, generalize them into rules, and propose documentation for the repository.

---

## Step 1: Collect findings

Two sources: DOC: notes from the current session, and recurring feedback from memory.

### 1a: DOC: notes

```bash
node "$MEM" --dir="$MEM_DIR" docs
```

### 1b: Recurring feedback patterns

```bash
node "$MEM" --dir="$MEM_DIR" recurring
```

This scans `feedback/` files for clusters — similar corrections that appeared 2+ times across sessions. Recurring patterns are strong candidates for promotion to `.claude/rules/`.

### Combine

If both sources are empty — tell user "No documentation findings." and stop.

If recurring patterns found — highlight them: "This feedback appeared N times across sessions. Strong candidate for `.claude/rules/`."

---

## Step 2: Generalize

For each DOC: note, extract a generalized rule.

Bad (too specific):
> "The PaymentService bug was on line 42 in processRefund()"

Good (pattern):
> "Refund operations must check transaction state before mutating — stale state causes double-refunds"

Bad (class-level):
> "UserService.getProfile() returns null when user is not found"

Good (convention):
> "Services return null for missing entities instead of throwing — callers must handle null"

If a note can't be generalized — skip it.

---

## Step 3: Detect documentation structure and route

### 3a: Detect existing structure

```bash
ls .claude/rules/ 2>/dev/null
cat CLAUDE.md 2>/dev/null | head -50
ls docs/ 2>/dev/null
```

Check memory for saved preference:
```bash
node "$MEM" --dir="$MEM_DIR" search "docs_target"
```

### 3b: Choose target

If no saved preference and no `.claude/rules/` directory — ask:

```
Where should project rules go?
  1. .claude/rules/ (Claude Code loads these per-directory)
  2. docs/
  3. CLAUDE.md (single file, always loaded — use sparingly)
  4. Other — specify path

Choice? (default: 1)
```

Save preference:
```bash
node "$MEM" --dir="$MEM_DIR" note "CONFIG: docs_target=<chosen path>"
```

### 3c: Route by domain

Route using the chosen target directory (default: `.claude/rules/`):

| Domain | Target |
|--------|--------|
| testing | `<target>/testing.md` |
| api | `<target>/api.md` |
| architecture | `<target>/architecture.md` |
| state | `<target>/state.md` |
| workflow | `<target>/workflow.md` |
| Other domain | `<target>/<domain>.md` |
| Truly universal (rare) | `CLAUDE.md` |

If a matching file exists — add to it. If not — create one.

---

## Step 4: Propose changes

```
## Docs-reflect: <date>

Found N DOC: notes, grouped into M domains:

### <target>/testing.md
- <rule 1>
- <rule 2>

### <target>/api.md
- <rule 3>

### Skipped
- <notes too specific to generalize>

Apply? (all / pick numbers / skip)
```

Wait for user confirmation.

---

## Step 5: Apply

For each approved rule:

1. Read target file (or create with header)
2. Add rule to appropriate section
3. Format:

For rule files (`.claude/rules/`, `docs/`, or custom target):
```markdown
## <Section>

- <Rule>
```

---

## Rules

- **Generalize or skip.** Can't state it as a reusable rule → don't add it.
- **No class/method API docs.** Those belong in code comments.
- **No ticket/branch references.** Docs should not mention specific tasks.
- **Right file matters.** The main value is routing to the correct `.claude/rules/` file.
- **Deduplicate.** Read existing docs before adding.
- **User confirms first.** Never write without showing what will be added.
- **Respect existing structure.** Add to existing files/sections. Don't reorganize.
- **Less is more.** 2 good rules is a great outcome. 0 is fine too.
