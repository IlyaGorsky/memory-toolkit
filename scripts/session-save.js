#!/usr/bin/env node
// Auto-save session state before compact.
// Called by PreCompact hook — saves handoff to memory.
// Lightweight version of /session-end (no LLM, no interaction).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Read stdin (hook passes JSON with session_id)
let sessionId = 'unknown';
try {
  const stdin = fs.readFileSync('/dev/stdin', 'utf8');
  const data = JSON.parse(stdin);
  sessionId = data.session_id || 'unknown';
} catch {}

// Find memory dir for current project
const cwd = process.cwd();
const projectKey = cwd.replace(/[/.]/g, '-').replace(/^-/, '');
const memoryDir = path.join(
  process.env.HOME, '.claude', 'projects', `-${projectKey}`, 'memory'
);

if (!fs.existsSync(memoryDir)) {
  // Try parent dirs
  const parts = cwd.split('/');
  let found = null;
  for (let i = parts.length; i > 2; i--) {
    const key = parts.slice(1, i).join('-');
    const dir = path.join(process.env.HOME, '.claude', 'projects', `-${key}`, 'memory');
    if (fs.existsSync(dir)) { found = dir; break; }
  }
  if (!found) process.exit(0); // no memory dir, skip silently
}

const handoffDir = path.join(memoryDir, 'workstreams');
const handoffPath = path.join(handoffDir, 'handoff.md');

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

// Write handoff
fs.mkdirSync(handoffDir, { recursive: true });

const handoff = `---
name: Session handoff (auto-saved before compact)
description: Auto-saved at ${now}
type: project
---

## Pre-compact snapshot: ${now}

**Session:** ${sessionId}
**Branch:** ${branch}
**Last commit:** ${lastCommit}
**Uncommitted files:** ${uncommitted}

_This handoff was auto-saved by PreCompact hook. Use /session-continue to resume._
`;

fs.writeFileSync(handoffPath, handoff, 'utf8');

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

process.stderr.write(`[session-save] Handoff saved to ${handoffPath}\n`);
