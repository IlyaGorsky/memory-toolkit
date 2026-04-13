---
name: task-template
description: Internal orchestrator — runs YAML pipelines with phases, dependencies, and verification gates.
user-invocable: false
---

# Task Template — internal orchestrator

Runs a YAML pipeline. Each phase must complete (and pass `verify` if present) before dependents can start. Phases without dependencies run in parallel.

## How to use

The calling skill provides a template path:

```
Read: ${CLAUDE_PLUGIN_ROOT}/skills/task-template/templates/<name>.yaml
```

## Execution rules

1. **Parse** the YAML — extract `phases` list
2. **Build dependency graph** from `depends` fields
3. **Execute phases in order:**
   - Phases with no `depends` → run first (parallel if multiple)
   - Phase with `depends: [X, Y]` → only after X and Y complete
4. **After each phase** — if `verify` exists, check the condition
   - If verify fails → stop, report to user, do NOT proceed
   - If verify passes → continue to next phase
5. **Output** — each phase produces `output` that downstream phases can reference

## Phase schema

```yaml
- id: phase-name           # unique identifier
  description: what        # shown to user in plan
  depends: [other-phase]   # optional, default: none
  steps:                   # what to do (free-form instructions or skill calls)
    - description: "..."
  output: "..."            # what this phase produces
  verify: "..."            # optional gate — condition to check before proceeding
```

## Format for user

Before executing, show the plan:

```
Pipeline: <template-name>

[parallel]
  1. phase-a — description
  2. phase-b — description

[after 1,2]
  3. phase-c — description ✓ verify: <condition>

[after 3]
  4. phase-d — description
```

Do NOT ask for confirmation — the calling skill already confirmed.
