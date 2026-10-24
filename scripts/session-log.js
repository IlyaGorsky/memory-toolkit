#!/usr/bin/env node
// Log session start to daily notes.
// Called by SessionStart hook — reads session_id and transcript_path from stdin JSON.

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
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

log.setSessionId(sessionId);

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

// Run health check
const memJs = path.join(__dirname, 'memory.js');
let healthWarnings = '';
try {
  const healthOut = execFileSync(process.execPath, [memJs, `--dir=${memoryDir}`, 'health', '--brief'], {
    encoding: 'utf8', timeout: 5000,
  }).trim();
  if (/^[✗⚠]/m.test(healthOut)) {
    healthWarnings = healthOut;
  }
} catch {}

// Build JSON output for CC hook protocol
const output = {};

// Status line (visible in UI)
const version = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return pkg.version || '';
  } catch { return ''; }
})();
let statusMsg = `[memory-toolkit${version ? ' v' + version : ''}] session logged | branch: ${branch || 'unknown'}`;
if (healthWarnings) {
  statusMsg += ' | ⚠ memory health issues detected';
}
output.systemMessage = statusMsg;

// Context injection: handoff + DOC reminder
let context = '';
const handoffPath = path.join(memoryDir, 'workstreams', 'handoff.md');
if (fs.existsSync(handoffPath)) {
  context += fs.readFileSync(handoffPath, 'utf8') + '\n';
}
// precompact.md newer than handoff → a session compacted without /session-end after it
const snapshotPath = path.join(memoryDir, 'workstreams', 'precompact.md');
if (fs.existsSync(snapshotPath)) {
  const handoffTime = fs.existsSync(handoffPath) ? fs.statSync(handoffPath).mtimeMs : 0;
  if (fs.statSync(snapshotPath).mtimeMs > handoffTime) {
    const body = fs.readFileSync(snapshotPath, 'utf8').replace(/^---[\s\S]*?---\n/, '').trim();
    context += '---\nNewer than handoff (compact without /session-end):\n' + body + '\n';
  }
}
if (healthWarnings) {
  context += '---\nMemory health issues:\n' + healthWarnings + '\n';
}

// Workstream signals (AP-49): drawn from decisions the watcher already logged, so
// they reach sessions that never run /session-start. Silent below the thresholds.
let signals = null;
try {
  signals = JSON.parse(execFileSync(process.execPath, [memJs, `--dir=${memoryDir}`, 'signals'], {
    encoding: 'utf8', timeout: 5000,
  }));
} catch {}
if (signals) {
  const mem = 'memory.js';
  const offers = [];
  const gap = signals.identityGaps[0];
  if (gap) {
    offers.push(`"${gap.workstream}" has ${gap.recent} new decisions and ${gap.legacy ? 'only a legacy card' : 'no identity'}. When the conversation touches it, offer a draft built from ${mem} identity ${gap.workstream} --material, and write it with ${mem} write-identity --workstream=${gap.workstream} --content=<file> once the user agrees.`);
  }
  if (signals.unassigned.suggest) {
    offers.push(`${signals.unassigned.items} decisions over ${signals.unassigned.days} days match no workstream. At a natural pause, read ${mem} unassigned; if a theme recurs, offer to create a workstream (${mem} add-workstream <name> <keywords...>, then an identity as above).`);
  }
  if (offers.length) {
    offers.push(`Offer each at most once, and whatever the answer run ${mem} signals --mark-reviewed. Workstreams are optional — never push.`);
  }
  const lines = signals.identities.length
    ? [`Identities: ${signals.identities.map(i => `${i.workstream} — ${i.description}`).join('; ')}. Card: ${mem} identity <name>`, ...offers]
    : offers;
  if (lines.length) {
    context += `---\nWorkstreams (act only when it fits the conversation; memory.js = node "${memJs}" --dir="${memoryDir}"):\n`
      + lines.map(l => `- ${l}`).join('\n') + '\n';
  }
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
