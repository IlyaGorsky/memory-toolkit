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

// Context injection: handoff + DOC reminder.
// The handoff comes from /session-end, which most sessions never run: an old one, or
// one from another branch, is shown as such — not as the last session.
const HANDOFF_FRESH_DAYS = 7;
const HANDOFF_FULL_TEXT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// `key:` in the frontmatter, top-level or under CC's metadata:
function frontmatterField(content, key) {
  const fm = (content.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  const m = fm.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^"(.*)"$/, '$1') : '';
}

// `modified` (set by memory.js and CC's stamper), else mtime — which reading the
// file through memory.js bumps along with hits.
function writtenAt(file, content) {
  const modified = Date.parse(frontmatterField(content, 'modified'));
  return Number.isNaN(modified) ? fs.statSync(file).mtimeMs : modified;
}

let context = '';
const handoffPath = path.join(memoryDir, 'workstreams', 'handoff.md');
let handoffTime = 0;
if (fs.existsSync(handoffPath)) {
  const handoff = fs.readFileSync(handoffPath, 'utf8');
  handoffTime = writtenAt(handoffPath, handoff);
  const ageDays = Math.floor((Date.now() - handoffTime) / DAY_MS);
  const handoffBranch = frontmatterField(handoff, 'branch');
  const otherBranch = Boolean(handoffBranch && branch && handoffBranch !== branch);
  if (!otherBranch && ageDays <= HANDOFF_FRESH_DAYS) {
    context += handoff + '\n';
  } else {
    const date = new Date(handoffTime).toISOString().slice(0, 10);
    const label = `Older handoff — ${date}, ${ageDays} days ago${handoffBranch ? `, branch ${handoffBranch}` : ''}`
      + `${otherBranch ? ` (now on ${branch})` : ''}. It may not match the current work.`;
    context += otherBranch || ageDays > HANDOFF_FULL_TEXT_DAYS
      ? `${label}\nSummary: ${frontmatterField(handoff, 'description') || '—'}\nFull text: node "${memJs}" --dir="${memoryDir}" handoff\n`
      : `${label}\n${handoff}\n`;
  }
}
// precompact.md newer than handoff → a session compacted without /session-end after it
const snapshotPath = path.join(memoryDir, 'workstreams', 'precompact.md');
if (fs.existsSync(snapshotPath)) {
  if (fs.statSync(snapshotPath).mtimeMs > handoffTime) {
    const body = fs.readFileSync(snapshotPath, 'utf8').replace(/^---[\s\S]*?---\n/, '').trim();
    context += '---\nNewer than handoff (compact without /session-end):\n' + body + '\n';
  }
}
if (healthWarnings) {
  context += '---\nMemory health issues:\n' + healthWarnings + '\n';
}

// Workstream cards (decisions/value-in-the-moment): drawn from decisions the watcher
// already logged, so they reach sessions that never run /session-start. The offers
// stay silent below the thresholds.
let signals = null;
try {
  signals = JSON.parse(execFileSync(process.execPath, [memJs, `--dir=${memoryDir}`, 'signals', `--branch=${branch}`], {
    encoding: 'utf8', timeout: 5000,
  }));
} catch {}
if (signals) {
  const mem = 'memory.js';
  const offers = [];
  const gap = signals.cardGaps[0];
  if (gap && gap.card) {
    offers.push(`The "${gap.workstream}" card is behind: ${gap.sinceCard} decisions since it was updated. When the conversation touches it, offer to update it from ${mem} card ${gap.workstream} --material.`);
  } else if (gap) {
    const related = gap.related.length ? ` (workstreams/ has ${gap.related.join(', ')} — maybe its card under another name)` : '';
    offers.push(`"${gap.workstream}" has ${gap.recent} new decisions and no card${related}. When the conversation touches it, offer a card drafted from ${mem} card ${gap.workstream} --material — what it is, why, what it doesn't do, where results live, what's open.`);
  }
  if (signals.parked.offer) {
    offers.push(`${signals.parked.stale} parked items have waited over 30 days (${mem} parked). At a natural pause, offer to sort them: pick up, move to the backlog or an ideas catalog, or drop — then ${mem} unpark <file> --to=<where>.`);
  }
  if (signals.unassigned.suggest) {
    offers.push(`${signals.unassigned.items} decisions over ${signals.unassigned.days} days match no workstream. At a natural pause, read ${mem} unassigned; if a theme recurs, offer to start a workstream (${mem} add-workstream <name> <keywords...>, then a card as above).`);
  }
  if (offers.length) {
    offers.push(`Write only once the user agrees (${mem} write-card --workstream=<name> --content=<file>). Offer each at most once, and whatever the answer run ${mem} signals --mark-reviewed. Workstreams are optional — never push.`);
  }
  const info = [];
  if (signals.cards.length) {
    info.push(`Cards: ${signals.cards.map(c => `${c.workstream} — ${c.description}${c.parked ? ` (${c.parked} parked)` : ''}`).join('; ')}. Read: ${mem} card <name>, ${mem} parked <name>. When a decision, an iteration result or an open question about one of them comes up, offer to update its card.`);
  }
  // An invitation to the ritual, not its content (decisions/hooks-capture-rituals-author)
  const match = signals.branchWorkstreams[0];
  if (match) {
    const has = [match.card && 'card', match.handoff && 'handoff', match.parked && `${match.parked} parked`].filter(Boolean).join(' + ');
    info.push(`Branch "${branch}" looks like workstream "${match.workstream}" (${has}). If the user picks that work up without context, suggest /session-continue ${match.workstream}.`);
  }
  const lines = [...info, ...offers];
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
