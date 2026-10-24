# Privacy

memory-toolkit runs locally inside Claude Code. It has no server, no telemetry and no account of its own.

## What it stores

Everything stays on your machine:

- **Memory files** in Claude Code's own memory folder — `~/.claude/projects/<project>/memory/`, or wherever Claude Code keeps auto-memory (`CLAUDE_CONFIG_DIR`, `autoMemoryDirectory`): markdown notes, handoffs, workstream files, a session index (`sessions.jsonl`: session id, date, git branch, transcript path) and a small watcher state file.
- **Repository docs**, only when you run `/docs-reflect` and approve the changes: rules in `.claude/rules/`, `docs/` or `CLAUDE.md`.
- **Logs**, only if you set `MT_LOG_FILE`.

## What it sends

- **The optional background watcher** runs your own `claude` CLI (`claude -p --safe-mode`, Haiku) on recent conversation text to pick out decisions, corrections and documentation findings. Each run sends at most the 40 newest user and assistant messages since the previous run, text only (no tool output or file contents), each cut to 1,000 characters.
- That request goes to the model provider your Claude Code is configured for (Anthropic by default), under the login Claude Code already has — subscription or API key — exactly like your own session. The provider's terms and privacy policy apply.
- memory-toolkit never reads, stores or forwards credentials, and sends nothing anywhere else: no analytics, no third-party services.

## Turning things off

- **Watcher only:** remove its entries from `hooks/hooks.json`. Everything else keeps working offline.
- **Stored data:** delete the project's memory folder.
- **The plugin:** `claude plugin uninstall memory-toolkit`. Your memory files stay until you delete them.

## Questions

Open an issue: https://github.com/IlyaGorsky/memory-toolkit/issues
