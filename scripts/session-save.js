#!/usr/bin/env node
// Auto-save session state before compact.
// Called by PreCompact hook — saves a snapshot next to handoff.md.
// Never overwrites handoff.md: that file is written by /session-end and
// carries the real context; a git-only stub in its place loses it.
// Lightweight version of /session-end (no LLM, no interaction).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { findMemoryDirOrExit } = require('./lib/find-memory-dir');
const log = require('./lib/log');

// Read stdin (hook passes JSON with session_id)
let sessionId = 'unknown';
try {
  const stdin = fs.readFileSync(0, 'utf8'); // fd 0 = stdin, cross-platform
  const data = JSON.parse(stdin);
  sessionId = data.session_id || 'unknown';
} catch {}

log.setSessionId(sessionId);

const cwd = process.cwd();
const memoryDir = findMemoryDirOrExit();

const handoffDir = path.join(memoryDir, 'workstreams');
const snapshotPath = path.join(handoffDir, 'precompact.md');

// Gather state
let branch = 'unknown';
let lastCommit = 'unknown';
let uncommitted = 0;
try {
  branch = execSync('git branch --show-current', { cwd, encoding: 'utf8' }).trim();
  lastCommit = execSync('git log --oneline -1', { cwd, encoding: 'utf8' }).trim();
  uncommitted = execSync('git status --short', { cwd, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
} catch {}

const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

// Write snapshot
fs.mkdirSync(handoffDir, { recursive: true });

const snapshot = `---
name: Pre-compact snapshot
description: Auto-saved at ${now}
type: project
---

## Pre-compact snapshot: ${now}

**Session:** ${sessionId}
**Branch:** ${branch}
**Last commit:** ${lastCommit}
**Uncommitted files:** ${uncommitted}

_Auto-saved by PreCompact hook. Context lives in handoff.md (written by /session-end)._
`;

const snapshotTmp = snapshotPath + '.tmp';
fs.writeFileSync(snapshotTmp, snapshot, 'utf8');
fs.renameSync(snapshotTmp, snapshotPath); // atomic on POSIX

// Also log to daily notes
const notesDir = path.join(memoryDir, 'notes');
fs.mkdirSync(notesDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const notePath = path.join(notesDir, `${today}.md`);
const time = new Date().toTimeString().slice(0, 5);
const entry = `- ${time} PRE_COMPACT uuid:${sessionId} branch:${branch} commit:${lastCommit} uncommitted:${uncommitted}\n`;

if (fs.existsSync(notePath)) {
  fs.appendFileSync(notePath, entry);
} else {
  fs.writeFileSync(notePath, `---\nname: Notes ${today}\ndescription: Session notes ${today}\ntype: project\n---\n\n# ${today}\n\n${entry}`);
}

log.info('pre-compact snapshot saved', { path: snapshotPath, sessionId, branch, uncommitted });
