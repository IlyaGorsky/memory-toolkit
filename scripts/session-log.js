#!/usr/bin/env node
// Log session start to daily notes.
// Called by SessionStart hook — reads session_id and transcript_path from stdin JSON.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { findMemoryDirOrExit } = require('./lib/find-memory-dir');
const log = require('./lib/log');

// Read stdin (hook passes JSON)
let stdin = '';
try {
  stdin = fs.readFileSync(0, 'utf8'); // fd 0 = stdin, cross-platform
} catch {}

let sessionId = 'unknown';
let transcriptPath = '';
try {
  const data = JSON.parse(stdin);
  sessionId = data.session_id || 'unknown';
  transcriptPath = data.transcript_path || '';
} catch {}

const cwd = process.cwd();
const memoryDir = findMemoryDirOrExit();
log.debug('session-log start', { sessionId, transcriptPath, cwd, memoryDir });

// Get git info
let branch = '';
try {
  branch = execSync('git branch --show-current', { cwd, encoding: 'utf8' }).trim();
} catch {}

// Log to daily notes
const notesDir = path.join(memoryDir, 'notes');
fs.mkdirSync(notesDir, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const notePath = path.join(notesDir, `${today}.md`);
const time = new Date().toTimeString().slice(0, 5);
const entry = `- ${time} SESSION_START uuid:${sessionId} branch:${branch}${transcriptPath ? ` transcript:${transcriptPath}` : ''}\n`;

if (fs.existsSync(notePath)) {
  fs.appendFileSync(notePath, entry);
} else {
  fs.writeFileSync(notePath, `---\nname: Notes ${today}\ndescription: Session notes ${today}\ntype: project\n---\n\n# ${today}\n\n${entry}`);
}

// Also write session index for quick lookup (deduplicate by session_id)
const sessionsPath = path.join(memoryDir, 'sessions.jsonl');
const record = JSON.stringify({
  id: sessionId,
  date: new Date().toISOString(),
  branch,
  transcript: transcriptPath,
}) + '\n';
const existing = fs.existsSync(sessionsPath) ? fs.readFileSync(sessionsPath, 'utf8') : '';
if (!existing.includes(`"id":"${sessionId}"`)) {
  fs.appendFileSync(sessionsPath, record);
}

// Update MEMORY.md API block if version is stale (AP-20)
const memoryMdPath = path.join(memoryDir, 'MEMORY.md');
if (fs.existsSync(memoryMdPath)) {
  const currentScriptPath = path.join(__dirname, 'memory.js');
  let memContent = fs.readFileSync(memoryMdPath, 'utf8');
  const updated = memContent.replace(
    /node [^\s`]+\/memory-toolkit\/[^\s`]+\/scripts\/memory\.js/g,
    `node ${currentScriptPath}`
  );
  if (updated !== memContent) {
    fs.writeFileSync(memoryMdPath, updated);
    log.info('AP-20: updated MEMORY.md API path', { memoryMdPath });
  }
}

// Build JSON output for CC hook protocol
const output = {};

// Status line (visible in UI)
const version = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return pkg.version || '';
  } catch { return ''; }
})();
output.systemMessage = `[memory-toolkit${version ? ' v' + version : ''}] session logged | branch: ${branch || 'unknown'}`;

// Context injection: handoff + DOC reminder
let context = '';
const handoffPath = path.join(memoryDir, 'workstreams', 'handoff.md');
if (fs.existsSync(handoffPath)) {
  context += fs.readFileSync(handoffPath, 'utf8') + '\n';
}
context += [
  '---',
  'During this session, mark documentation-worthy findings:',
  '  /memory note "DOC: <domain> — <insight>"',
  'Examples:',
  '  /memory note "DOC: testing — integration tests must hit real DB, not mocks"',
  '  /memory note "DOC: architecture — webhook handlers must be idempotent"',
  'At session end, /docs-reflect will collect DOC: notes and propose repo documentation.',
  '---',
].join('\n');

output.hookSpecificOutput = {
  hookEventName: 'SessionStart',
  additionalContext: context,
};

log.debug('session-log output', { systemMessage: output.systemMessage });
process.stdout.write(JSON.stringify(output) + '\n');
