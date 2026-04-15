---
name: session-start
description: Cold session start — context, status, focus. Use at the beginning of each new session.
user-invocable: true
argument-hint: "[workstream]"
metadata:
  pipeline: true
---

# /session-start — Cold session start

Quick context entry. Gather state, propose focus.

---

## Step 1: Gather context

**Do NOT re-read MEMORY.md** — already in system prompt via claudeMd loader.

If a workstream argument is provided — skip to Step 3.

```bash
MEM="${CLAUDE_PLUGIN_ROOT}/scripts/memory.js"
PROJ_KEY=$(pwd | tr '/.' '-' | sed 's/^-//')
MEM_DIR="$HOME/.claude/projects/-${PROJ_KEY}/memory"

# Latest handoff (overwritten each session-end)
[ -f "$MEM_DIR/workstreams/handoff.md" ] && cat "$MEM_DIR/workstreams/handoff.md"

# Latest dated note
ls -t "$MEM_DIR/notes/"*.md 2>/dev/null | head -1 | xargs -I{} head -30 {}

# Workstreams sorted by aggregate weight
node "$MEM" --dir="$MEM_DIR" workstreams

# Top-3 brief inline
for WS in <top-3 from sorted list>; do
  node "$MEM" --dir="$MEM_DIR" workstream "$WS" --brief | head -15
done
```

**Decision tree:**

| Handoff state | Action |
|---|---|
| ≤7 days old, has "What's next" | Skip menu, use handoff as primary candidates |
| >7 days old | Show as stale context, present menu |
| Missing/empty/only `SESSION_START` markers | Say "no usable context", suggest `/session-restore`, fall through to menu |
| No handoff, no notes | Show menu only |

---

## Step 1b: Workstream menu (fallback)

Render as table. Top-3 rows show synthesized "What's in" from `--brief`; rest show keywords. ➕ row is mandatory.

```
**Workstreams** (sorted by aggregate weight)

| # | Workstream | Last touched | What's in / Keywords |
|---|---|---|---|
| 1 | <name> | <date> | <synthesized 1-line for top-3> |
| ... | | | <keywords for rest> |
| N | ➕ Create new | | |
```

If user picks ➕ — ask name + keywords, then:
```bash
node "$MEM" --dir="$MEM_DIR" add-workstream <name> <keyword1> <keyword2> ...
```

---

## Step 2: Git status

```bash
git status; git log --oneline -5; git branch --show-current
```

- Uncommitted changes → ask: "Commit or continue on top?"
- Last commit >5 days ago → note it
- **Commits:** synthesize last 2-3 into 1 line about the theme. Don't list verbatim.

**Branch ↔ workstream check:** does branch name contain any keyword from `workstreams.json`?

- Match → skip "Current branch" block in Step 4
- No match → run `git log <branch> --oneline -10` + `git diff $(git merge-base HEAD origin/main)...HEAD --stat`. Synthesize phase (review iteration / new feature / hotfix). Grep `notes/` for branch name. Surface in Step 4 as branch block + extra focus candidate.

If handoff has `lastCommit` ref: show `git log <ref>..HEAD --oneline` (changes since session-end).

---

## Step 3: Workstream brief

```bash
node "$MEM" --dir="$MEM_DIR" workstream <name> --brief
```

Show: open/done task counts, blockers, pickable now. **Do NOT read full files** — full context loads only after task pick in Step 4.

---

## Step 4: Render & propose

**Use the user's preferred language** (from `profile/language.md` if present, else English). Translate labels and prose; keep markdown structure, identifiers, code refs as-is.

**Required format** — clean bold headers, no emoji, `---` between every block, blank line after each header before content.

```text
## Session YYYY-MM-DD

**Git:** branch `<branch>` / <N> uncommitted / last commit <days> days ago
**Commits:** <1-line synthesis>

---

**Workstreams**

[table from Step 1b]

---

**Task plan ({active workstream})**

{1-line context}
- [ ] {open task} ({SP})
- [ ] {open task} — {blocker}

---

**Current branch `{branch}`** _(only if no workstream match)_

{1-2 sentences: theme, phase, side task vs portfolio}

---

**Focus candidates**

1. **{task}** — {why now} → **{Model}** ({reason})
2. **{task}** — {why now} → **{Model}** ({reason})
3. **{task}** — {why now} → **{Model}** ({reason})

---

My hypothesis: focus on **{candidate #1}** because {reasoning grounded in handoff/git/recency}. Recommendation: **{Model}**.

Agree, pick another candidate, or **start a new workstream**?
```

**Close with a hypothesis, not a menu.** Users iterate on a proposal faster than they pick from a list. Candidates 2-3 stay visible for quick override.

**MANDATORY:** the closing line must keep "start a new workstream" as an explicit option. Never omit it — the hypothesis frame hides existing workstreams, so the escape hatch to create a new one has to be surfaced every time. If the user picks it, run Step 1b (workstream creation).

**Model selection:** Opus = planning/architecture/exploration. Sonnet = execution by plan, refactoring, review. Haiku = routine/translation/pattern copy.

---

## Step 5: Session label

```bash
node "$MEM" --dir="$MEM_DIR" note "SESSION_START branch:$(git branch --show-current) workstream:<chosen> focus:<task>"
```

(Auto-routed to `sessions.log`, not notes.)

---

## Rules

- Max 3 focus candidates
- Skip blocked tasks (waiting on mockups/backend) from candidates — note them separately
- Workstream argument → go straight to Step 3
- Previous session ended with compact → check via `/session-restore`
