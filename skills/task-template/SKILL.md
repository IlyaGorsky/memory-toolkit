---
name: task-template
description: Internal orchestrator — runs YAML pipelines with phases, dependencies, and verification gates.
user-invocable: false
---

# Task Template — internal orchestrator

Runs a YAML pipeline. Each phase must complete (and pass `verify` if present) before dependents can start. Phases without dependencies run in parallel.

## Purpose

Pipelines exist as a **guardrail against step-skipping**. Prose in SKILL.md can be skimmed or reinterpreted by the model, leading to missed steps and broken gates. A pipeline makes the structural contract explicit: phases, dependencies, verify gates, conditional skips.

## How to use

Pipeline detection is automatic via the `PreToolUse` hook `scripts/pipeline-hint.js`. When the `Skill` tool is invoked, the hook reads the target skill's frontmatter and — if `metadata.pipeline: true` is set — injects this orchestrator contract into the tool-call context as `additionalContext`.

Filename convention: skill `session-end` ⇄ template `${CLAUDE_PLUGIN_ROOT}/skills/task-template/templates/session-end.yaml`. The hook resolves the template path and passes it in the injected contract.

When you receive a "PIPELINE SKILL DETECTED" notice:

- **do NOT** follow the prose in the target skill's SKILL.md as a script
- **do** load the YAML at the path provided, print the plan banner, announce each phase, and honor `depends` / `when` / `verify` / `retry_from`
- Prose in the target SKILL.md is per-phase reference, not a script — it cannot soften the contract

If the hook did not fire (e.g., skill invoked outside the plugin environment), you can fall back to checking frontmatter yourself: `metadata.pipeline: true` in the invoked SKILL.md means load the matching YAML and run it through this orchestrator.

## Execution rules

1. **Parse** the YAML — extract `phases` list
2. **Build dependency graph** from `depends` fields
3. **Execute phases in order:**
   - Phases with no `depends` → run first (parallel if multiple)
   - Phase with `depends: [X, Y]` → only after X and Y complete
4. **Before each phase** — if `when` exists, evaluate against prior phase outputs and pipeline args
   - If `when` is false → skip phase, mark output as empty/none
   - Skip does NOT propagate. Dependents still run (they see empty output from skipped deps). If a dependent must not run without upstream content, it uses its own `when:` to check.
   - If `when` is true or absent → run the phase
5. **After each phase** — if `verify` exists, check the condition
   - If verify passes → continue to next phase
   - If verify fails with retry intent AND phase has `retry_from: X` → restart from phase X, re-run it and everything downstream
   - If verify fails with abort intent (or no `retry_from`) → stop, report to user, do NOT proceed
6. **Output** — each phase produces `output` that downstream phases can reference

## Pipeline schema

```yaml
name: pipeline-name        # matches template filename
description: what it does
args:                      # optional — pipeline-level inputs
  mode:
    required: false
    default: full
    description: "..."
phases:
  - ...
```

## Phase schema

```yaml
- id: phase-name           # unique identifier
  description: what        # shown to user in plan
  depends: [other-phase]   # optional, default: none
  when: "..."              # optional — skip phase if condition false (dependents still run)
  steps:                   # what to do (free-form instructions or skill calls)
    - description: "..."
  output: "..."            # what this phase produces
  verify: "..."            # optional gate — condition to check before proceeding
  retry_from: phase-id     # optional — loop back here when verify fails with retry intent
```

## Visible markers (MUST)

Pipeline execution MUST be visible to the user. Markers use plain ASCII fences (`=`, `>>>`, `---`) so they survive any renderer — no brackets, arrows, or Unicode symbols that some IDEs strip or interpret as links.

**1. Plan banner — printed ONCE before any phase runs:**

```
==================================================
PIPELINE START: <template-name>  (args: <k=v ...>)
==================================================
Wave 1 (no deps):
  1. phase-a -- description
  2. phase-b -- description

Wave 2 (after 1,2):
  3. phase-c -- description | verify: <condition>
==================================================
END PLAN -- <N> phases, executing now
==================================================
```

**2. Phase announce — printed BEFORE each phase starts executing:**

```
>>> PHASE <n>/<N>: <phase-id> -- <description>
```

If a phase is skipped via `when: false`:

```
--- SKIP <n>/<N>: <phase-id> (when: <condition> is false)
```

If a phase loops via `retry_from`:

```
!!! RETRY <n>/<N>: <phase-id> -- jumping back to <retry_from target>
```

Do NOT ask for confirmation of the plan — the calling skill already confirmed. But DO always print the plan banner and the per-phase announce. Silent execution defeats the purpose of the pipeline.
