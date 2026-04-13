# Philosophy

**Memory for the developer, context for the agent.**
The source of truth is the developer, not the agent. The agent receives a slice from developer memory as context for the current task. A derivative, not an owner.

**Memory is personal, not shared.**
Stylistics, rejected alternatives, edit patterns — individual experience. Averaging = creating noise. If a decision is valuable for everyone — it gets promoted to project context.

**Memory is rules + API, not storage.**
MEMORY.md describes what exists (capabilities) and how to work with you (rules). Not instructions on "what to do". Data lives in files, API lives in MEMORY.md. They don't compete for space.

**Flat markdown, not vector DB.**
Vector search pulls "similar", not "needed". Cosine similarity doesn't know the intent of the current task. Structured naming + an LLM that picks the file itself — more precise. Human-readable, human-editable, version-controllable.

**Hooks instead of discipline.**
Every piece of feedback that has to be repeated — is a candidate for a hook. The agent forgets prompts, hooks always execute. The vendor can reconfigure the model without warning — hooks don't depend on the vendor.

**Memory evolves with the developer.**
Not static. Every decision (accepted/rejected/corrected) feeds back into memory and improves accuracy of the next cycle. Compound effect.

**Workstreams instead of worktrees.**
Switching context, not files. Same files, same branch, a different slice from developer memory. `memory.js init --ask` — workstream selection at session start.

**Session → memory pipeline.**
A session is raw material. Automatic extraction of decisions, rejected suggestions, preferences, diff between agent output and git commits. Haiku as a background summarizer — cheap, asynchronous.

**Archiving, not deletion.**
Hot data — in context. Cold data — on disk, accessible via CLI. Knowledge is never lost, it just doesn't occupy the context window.

**What can't be verified by code — can't be guaranteed.**
Deterministic steps (hooks, validators, CLI) > probabilistic review. Memory management is not an expectation from the model, but infrastructure around it.

**Skills as specs, not as automation.**
A skill describes *how the agent should behave*, not code that gets executed. The deterministic part — in hooks and CLI. The probabilistic part — in specs for the agent. The boundary is intentional: only automate what you can guarantee.

---

> Personal, structured, flat, automatically maintained through hooks, vendor-independent, and evolving with the developer.

**Memory is the last source of truth, not the first.**
CLAUDE.md → `.claude/rules/` → skills → memory. Memory holds what hasn't been promoted yet. If a rule lives in memory for months — it should have been in `rules/` or CLAUDE.md long ago.

**Healthy memory shrinks.**
Memory should decrease as a project matures. Decisions get promoted to ADRs, feedback becomes rules, handoffs get shorter as conventions stabilize. The metric is not "how much was written" but "how much was promoted to documentation and removed from memory."

**Hooks deliver data, skills deliver dialog.**
A hook silently injects context — handoff, health status, reminders. A skill stops and asks — which workstream, which focus, confirm before writing. Moving a decision into a hook means hiding it from the user. Explicit is better than implicit.

---

## Intersections with Karpathy's ["LLM Knowledge Bases"](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

Karpathy (April 2026) described an approach to personal knowledge bases on LLMs. Several ideas overlap and reinforce our model:

**Index-based retrieval instead of vector search.**
At a scale of up to ~500 articles, an LLM reading a structured index.md is more precise than cosine similarity. The LLM understands the intent of the query, a vector DB — only lexical similarity. In our case: `MEMORY.md` as index → the LLM itself chooses which files to read.

**Three-layer architecture: Raw → Wiki → Index.**
Raw — immutable sources (sessions, git). Wiki — compiled markdown articles (decisions/, feedback/). Index — a compact pointer (MEMORY.md). Our memory.js operates on exactly these layers.

**Write-back: knowledge compounds through usage.**
A good answer gets returned to the knowledge base as a new page. The base grows not only through ingestion, but also through queries. In our case: `/reflect`, `/park`, auto-save hooks — every session enriches memory.

**LLM as compiler, not just as query engine.**
The LLM doesn't just answer questions — it compiles raw material into structured articles. In our case: session → memory pipeline, where the agent extracts decisions and feedback from raw sessions.

### Where we diverge

Karpathy builds a **knowledge base for reading** — a researcher asks, the wiki answers. We build **infrastructure for workflow** — hooks, lifecycle, workstreams. Not "what do I know", but "how do I work".
