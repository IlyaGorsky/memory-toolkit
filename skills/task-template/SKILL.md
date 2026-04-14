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

When a skill is invoked — manually (`/skill-name`) or via a `skill:` step from another pipeline — check its frontmatter for `metadata.pipeline: true`:

- **marker present** → load the pipeline by filename convention at `${CLAUDE_PLUGIN_ROOT}/skills/task-template/templates/<skill-name>.yaml` and execute it through this orchestrator's rules. The YAML is the contract: no phase skipping, no gate bypass, no ignored `verify`. Prose in SKILL.md provides per-step context but cannot soften the contract.
- **marker absent** → plain prose skill. Follow SKILL.md directly. No structural enforcement.

Filename convention: skill `session-end` ⇄ template `session-end.yaml`. The marker triggers the lookup; the filename resolves the path.

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

Pipeline execution MUST be visible to the user. Two markers, both mandatory:

**1. Plan banner — printed ONCE before any phase runs:**

```
Pipeline: <template-name>

[first]
  1. phase-a — description
  2. phase-b — description

[after 1,2]
  3. phase-c — description ✓ verify: <condition>
```

**2. Phase announce — printed BEFORE each phase starts executing:**

```
→ [phase-id] description
```

If a phase is skipped via `when: false`:

```
⊘ [phase-id] skipped (when: <condition> is false)
```

If a phase loops via `retry_from`:

```
↻ [phase-id] retry → jumping back to <retry_from target>
```

Do NOT ask for confirmation of the plan — the calling skill already confirmed. But DO always print the plan banner and the per-phase announce. Silent execution defeats the purpose of the pipeline.
