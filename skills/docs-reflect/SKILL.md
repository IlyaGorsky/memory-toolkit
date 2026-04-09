---
name: docs-reflect
description: Collect DOC: notes from session, generalize, and propose repo documentation (.claude/rules/, docs/).
user-invocable: true
argument-hint: "[optional focus area]"
---

# /docs-reflect — Session knowledge → repo documentation

Collect DOC: notes accumulated during the session, generalize them into rules, and propose documentation for the repository.

---

## Step 1: Collect DOC: notes

```bash
node "$MEM" --dir="$MEM_DIR" docs
```

If no DOC: notes found — tell user "No DOC: notes this session." and stop.

Also check memory for recurring patterns that haven't been promoted to docs yet:

```bash
node "$MEM" --dir="$MEM_DIR" search "DOC:"
```

If memory has similar feedback from past sessions — mention it: "This pattern came up before. Worth promoting to repo docs."

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

## Step 3: Route to target files

Scan existing documentation:

```bash
ls .claude/rules/ 2>/dev/null
cat CLAUDE.md 2>/dev/null | head -50
ls docs/ 2>/dev/null
```

Route by domain (from DOC: note prefix):

| Domain | Target |
|--------|--------|
| testing | `.claude/rules/testing.md` |
| api | `.claude/rules/api.md` |
| architecture | `.claude/rules/architecture.md` |
| state | `.claude/rules/state.md` |
| workflow | `.claude/rules/workflow.md` |
| Other domain | `.claude/rules/<domain>.md` |
| Feature docs | `docs/<feature>.md` |
| Truly universal (rare) | `CLAUDE.md` |

Prefer `.claude/rules/` — loaded selectively. CLAUDE.md is loaded every request.

If a matching file exists — add to it. If not — create one.

---

## Step 4: Propose changes

```
## Docs-reflect: <date>

Found N DOC: notes, grouped into M domains:

### .claude/rules/testing.md
- <rule 1>
- <rule 2>

### .claude/rules/api.md
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

For `.claude/rules/`:
```markdown
## <Section>

- <Rule>
```

For `docs/`:
```markdown
## <Title>

<2-5 sentences explaining the decision/pattern and why>
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
