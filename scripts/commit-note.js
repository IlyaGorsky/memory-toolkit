#!/usr/bin/env node
// PostToolUse(Bash) hook: log the commit just made as a COMMIT note.
// hooks.json filters with `if: Bash(git commit*)`, but `if` is best-effort and
// older Claude Code ignores it — so the command is checked here as well.

const fs = require('fs');
const { execFileSync } = require('child_process');
const { findMemoryDirOrExit } = require('./lib/find-memory-dir');

let payload = {};
try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}

const command = (payload.tool_input && payload.tool_input.command) || '';
if (!/\bgit\b(?:\s+-\S+(?:\s+\S+)?)*\s+commit\b(?!-)/.test(command)) process.exit(0);

// A rejected commit (pre-commit failed) must not log the previous commit as new.
// Bash tool_response has no exit code, so the commit itself is checked below:
// one this command made was committed moments ago.
const FRESH_SECONDS = 120;
const response = payload.tool_response || {};
if (response.interrupted || (typeof response.exit_code === 'number' && response.exit_code !== 0)) process.exit(0);

const cwd = payload.cwd || process.cwd();
try { process.chdir(cwd); } catch { process.exit(0); }
const memoryDir = findMemoryDirOrExit();

let subject = '';
let committedAt = 0;
try {
  const out = execFileSync('git', ['log', '-1', '--format=%ct %h %s'], { cwd, encoding: 'utf8', timeout: 3000 }).trim();
  const space = out.indexOf(' ');
  committedAt = Number(out.slice(0, space));
  subject = out.slice(space + 1);
} catch { process.exit(0); }
if (!subject || Date.now() / 1000 - committedAt > FRESH_SECONDS) process.exit(0);

try {
  execFileSync(process.execPath, [require.resolve('./memory.js'), `--dir=${memoryDir}`, 'note', `COMMIT: ${subject}`], {
    stdio: 'ignore', timeout: 5000,
  });
} catch {}
