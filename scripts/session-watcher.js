#!/usr/bin/env node

/**
 * Session Watcher — proactive context detector.
 *
 * Reads the active transcript, sends new messages to Haiku for analysis,
 * and saves findings (corrections, decisions, plans) to memory.
 *
 * Called by PostToolUse hook. Self-throttles to avoid running too often.
 *
 * State stored in: <memoryDir>/.watcher-state.json
 * Findings saved via: memory.js note "WATCH: ..."
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { findMemoryDirOrExit } = require('./lib/find-memory-dir');
const log = require('./lib/log');

// --- Config ---
const THROTTLE_MS = 3 * 60 * 1000; // run at most every 3 minutes
const MIN_NEW_MESSAGES = 6;          // need at least 6 new messages to analyze
const MODEL = 'claude-haiku-5-5';
const SUGGEST_REFLECT_THRESHOLD = 8;  // suggest /reflect after N accumulated findings
const SUGGEST_DOCS_THRESHOLD = 3;     // suggest /docs-reflect after N DOC findings
const TAIL_BYTES = 4 * 1024 * 1024;   // read at most the transcript's last 4 MB per run
const MAX_MESSAGES = 40;              // analyze only the newest messages

// --- Runtime state (initialized only when run as main) ---
let stdinPayload = {};
let memoryDir = '';
let statePath = '';

function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch { return { byteOffset: null, lastRun: 0, transcriptPath: '', findingsCount: 0, docCount: 0, suggestedReflect: false, suggestedDocs: false, parseErrors: 0, cliErrors: 0, lastParseError: null }; }
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// --- Find transcript path ---
// Primary: from PostToolUse stdin payload (public hook contract).
// Fallback: from sessions.jsonl (for backwards compat / manual runs).
function findTranscript() {
  if (stdinPayload.transcript_path) return stdinPayload.transcript_path;
  const sessionsPath = path.join(memoryDir, 'sessions.jsonl');
  if (!fs.existsSync(sessionsPath)) return null;
  const lines = fs.readFileSync(sessionsPath, 'utf8').trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  const last = JSON.parse(lines[lines.length - 1]);
  return last.transcript || null;
}

// --- Parse transcript ---
// Reads complete lines appended since byte `offset` (null: start from the tail).
// Transcripts reach hundreds of MB (2.1.300+ log every request), and reading a
// whole one throws past Node's string limit. A line still being written is left
// for the next run; an offset past the end (file rewritten) starts over.
function readNewMessages(transcriptPath, offset) {
  let fd;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch { return { messages: [], newOffset: offset ?? 0 }; }

  let buf, start;
  try {
    const size = fs.fstatSync(fd).size;
    const wanted = offset != null && offset <= size ? offset : 0;
    start = Math.max(wanted, size - TAIL_BYTES);
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }

  const begin = start > 0 && start !== offset ? buf.indexOf(0x0a) + 1 : 0;
  const end = buf.lastIndexOf(0x0a) + 1;
  const lines = end > begin ? buf.subarray(begin, end).toString('utf8').split('\n').filter(Boolean) : [];
  const messages = [];

  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.type === 'user' || d.role === 'user') {
        const text = extractText(d.message || d);
        if (text && !text.startsWith('<command')) {
          messages.push({ role: 'user', text: text.slice(0, 1000) });
        }
      } else if (d.type === 'assistant') {
        const text = extractText(d.message);
        if (text) {
          messages.push({ role: 'assistant', text: text.slice(0, 1000) });
        }
      }
    } catch {}
  }

  return { messages: messages.slice(-MAX_MESSAGES), newOffset: end > 0 ? start + end : start };
}

function extractText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return '';
}

// --- LLM analysis ---
const ANALYSIS_PROMPT = `You are a session watcher. Analyze the conversation fragment below and extract ONLY genuinely important items. Be very selective — most conversations have nothing worth saving.

Extract findings:
- **correction**: when the user corrects the assistant's approach or understanding (not just minor clarifications)
- **decision**: explicit choices made during discussion that affect future work (not routine confirmations)
- **plan**: execution strategies or multi-step approaches that were agreed upon
- **documentation**: surprising platform behaviors, non-obvious constraints, or architectural insights that a future contributor wouldn't find without digging

Also detect the current work phase:
- **planning**: discussing approach, architecture, design, reading code to understand
- **implementation**: writing code, creating files, making changes
- **review**: testing, reviewing diffs, fixing lint/types, running CI
- **debug**: investigating errors, reading logs, diagnosing issues

Return JSON (no markdown, no explanation):
{
  "findings": [
    {"type": "correction|decision|plan|documentation", "summary": "one sentence, concise"}
  ],
  "phase": "planning|implementation|review|debug|null"
}

If nothing important — return {"findings": [], "phase": null}.
Set phase to null if unclear. Be strict: routine tool calls, file reads, standard operations are NOT findings.`;

function buildConversationText(messages) {
  return messages.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    return `${role}: ${m.text}`;
  }).join('\n\n');
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['correction', 'decision', 'plan', 'documentation'] },
          summary: { type: 'string' },
        },
        required: ['type', 'summary'],
      },
    },
    phase: { type: ['string', 'null'], enum: ['planning', 'implementation', 'review', 'debug', null] },
  },
  required: ['findings', 'phase'],
};

function extractStructuredOutput(stdout) {
  try {
    const envelope = JSON.parse(stdout);
    const out = envelope.structured_output;
    if (out && typeof out === 'object' && Array.isArray(out.findings)) {
      return { findings: out.findings, phase: out.phase || null, parseError: false };
    }
  } catch {}
  return { findings: [], phase: null, parseError: true };
}

// Always the user's own `claude` CLI: it brings its own login (subscription or
// API key), so the plugin never reads or forwards credentials. The nested call
// stays a plain completion: --safe-mode turns off hooks, plugins, CLAUDE.md and
// MCP inside it (Claude Code >= 2.1.169) while keeping the login; --tools ""
// keeps it from wandering the codebase; no transcript is written.
// --bare is not usable: it drops OAuth.
const CLI_ARGS = [
  '-p', '--safe-mode',
  '--model', MODEL,
  '--output-format', 'json',
  '--json-schema', JSON.stringify(FINDINGS_SCHEMA),
  '--disable-slash-commands',
  '--no-session-persistence',
  '--strict-mcp-config',
  '--tools', '',
];

// On Windows `claude` is a `claude.cmd` shim that Node starts only through a
// shell (issue #4), so there the command line is quoted for cmd.exe: wrap and
// backslash-escape inner quotes (survives the CLI's argv parser too, see #5).
// Every argument is an internal constant — the transcript goes through stdin.
function quoteArg(arg) {
  return arg === '' || /[\s"]/.test(arg) ? '"' + arg.replace(/"/g, '\\"') + '"' : arg;
}

// Returns { findings: [...], phase: string|null }
function callCLI(conversationText) {
  try {
    const prompt = `${ANALYSIS_PROMPT}\n\n---\n\n${conversationText}`;
    const cwd = path.join(os.tmpdir(), 'memory-toolkit-watcher');
    fs.mkdirSync(cwd, { recursive: true });
    const options = { input: prompt, timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024, cwd };
    const stdout = process.platform === 'win32'
      ? execSync(['claude', ...CLI_ARGS.map(quoteArg)].join(' '), options)
      : execFileSync('claude', CLI_ARGS, options);
    return extractStructuredOutput(stdout);
  } catch {
    return { findings: [], phase: null, parseError: false, cliError: true };
  }
}

// --- Save findings ---
function saveFindings(findings) {
  if (!findings.length) return;

  const memJs = findMemoryJs();

  if (!memJs) {
    // Fallback: write directly to notes
    const today = new Date().toISOString().slice(0, 10);
    const notesDir = path.join(memoryDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    const notePath = path.join(notesDir, `${today}.md`);
    const time = new Date().toTimeString().slice(0, 5);

    const entries = findings.map(f =>
      `- ${time} WATCH:${f.type} ${f.summary}`.slice(0, 200)
    ).join('\n');

    if (fs.existsSync(notePath)) {
      fs.appendFileSync(notePath, '\n' + entries + '\n');
    } else {
      fs.writeFileSync(notePath, `---\nname: Notes ${today}\ndescription: Session notes ${today}\ntype: project\n---\n\n# ${today}\n\n${entries}\n`);
    }
    return;
  }

  for (const f of findings) {
    const summary = (f.summary || '').slice(0, 400);
    // documentation findings use DOC: prefix so /docs-reflect can collect them
    const label = f.type === 'documentation' ? 'DOC' : `WATCH:${f.type.toUpperCase()}`;
    writeNote(memJs, `${label}: ${summary}`);
  }
}

// No shell: summaries come from the transcript and may contain `…` or $(…)
function writeNote(memJs, text) {
  try {
    execFileSync(process.execPath, [memJs, `--dir=${memoryDir}`, 'note', text], { timeout: 5000, stdio: 'ignore' });
  } catch {}
}

function findMemoryJs() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    const p = path.join(pluginRoot, 'scripts', 'memory.js');
    if (fs.existsSync(p)) return p;
  }
  const sibling = path.join(__dirname, 'memory.js');
  if (fs.existsSync(sibling)) return sibling;
  const local = path.join(memoryDir, 'memory.js');
  if (fs.existsSync(local)) return local;
  return null;
}

// --- JSON output helpers ---
function exitJson(obj = {}) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(0);
}

// --- Main ---
async function main() {
  const state = loadState();
  const now = Date.now();

  // Throttle
  if (now - state.lastRun < THROTTLE_MS) {
    log.debug('watcher throttled', { elapsed: now - state.lastRun, threshold: THROTTLE_MS });
    exitJson();
  }

  // Find transcript
  const transcriptPath = findTranscript();
  if (!transcriptPath) exitJson();

  // Reset offset and counters if transcript changed (new session).
  // State without byteOffset counted lines (<= 1.9.15): start from the tail.
  const newSession = transcriptPath !== state.transcriptPath;
  const offset = newSession || state.byteOffset == null ? null : state.byteOffset;

  // Read new messages
  const { messages, newOffset } = readNewMessages(transcriptPath, offset);

  // Carry over counters (reset on new session)
  let findingsCount = newSession ? 0 : (state.findingsCount || 0);
  let docCount = newSession ? 0 : (state.docCount || 0);
  let suggestedReflect = newSession ? false : (state.suggestedReflect || false);
  let suggestedDocs = newSession ? false : (state.suggestedDocs || false);

  // Current phase (updated after LLM call)
  let currentPhase = newSession ? null : (state.phase || null);

  // Per session, same base as findingsCount; cliErrors = timeout/exit/network, not bad JSON
  // State without cliErrors predates per-session counting: its parseErrors is a lifetime total
  const legacyState = !('cliErrors' in state);
  let parseErrors = newSession || legacyState ? 0 : (state.parseErrors || 0);
  let cliErrors = newSession ? 0 : (state.cliErrors || 0);
  let lastParseError = newSession ? null : (state.lastParseError || null);

  // Save state (counters updated after analysis below)
  const persistState = () => saveState({
    byteOffset: newOffset,
    lastRun: now,
    transcriptPath,
    findingsCount,
    docCount,
    suggestedReflect,
    suggestedDocs,
    phase: currentPhase,
    parseErrors,
    cliErrors,
    lastParseError,
  });

  // Need minimum messages to analyze
  if (messages.length < MIN_NEW_MESSAGES) {
    log.debug('watcher: not enough messages', { count: messages.length, min: MIN_NEW_MESSAGES });
    persistState();
    exitJson();
  }

  // Analyze with LLM
  const conversationText = buildConversationText(messages);
  const llmResult = callCLI(conversationText);
  const { findings, phase } = llmResult;
  if (llmResult.parseError) {
    parseErrors += 1;
    lastParseError = new Date().toISOString();
    log.info('watcher parse error', { total: parseErrors, last: lastParseError });
  }
  if (llmResult.cliError) {
    cliErrors += 1;
    log.info('watcher cli error', { total: cliErrors });
  }

  // Track phase transitions
  if (phase) currentPhase = phase;
  const prevPhase = newSession ? null : (state.phase || null);
  if (phase && phase !== prevPhase) {
    log.info('phase change', { from: prevPhase, to: phase });
    // Save phase transition as a note
    const memJs = findMemoryJs();
    if (memJs) {
      writeNote(memJs, `WATCH:PHASE ${phase}` + (prevPhase ? ` (was: ${prevPhase})` : ''));
    }
  }

  if (findings && findings.length) {
    saveFindings(findings);
    findingsCount += findings.length;
    docCount += findings.filter(f => f.type === 'documentation').length;

    const summary = findings.map(f => `${f.type}: ${f.summary}`).join('; ');
    log.info('watcher findings', { count: findings.length, total: findingsCount, docTotal: docCount, summary });

    // Build output message
    let msg = `[memory-toolkit watcher] ${findings.length} finding(s) saved`;

    // Suggest /docs-reflect when DOC findings accumulate
    if (docCount >= SUGGEST_DOCS_THRESHOLD && !suggestedDocs) {
      msg += ` | 💡 ${docCount} documentation findings this session — consider /docs-reflect`;
      suggestedDocs = true;
    }
    // Suggest /reflect when total findings accumulate
    else if (findingsCount >= SUGGEST_REFLECT_THRESHOLD && !suggestedReflect) {
      msg += ` | 💡 ${findingsCount} findings this session — consider /reflect`;
      suggestedReflect = true;
    }

    persistState();
    exitJson({ systemMessage: msg });
  } else {
    persistState();
    exitJson();
  }
}

// --- Exports for testing ---
if (require.main === module) {
  // Initialize runtime state only when run as main
  try { stdinPayload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
  log.setSessionId(stdinPayload.session_id);
  memoryDir = findMemoryDirOrExit();
  statePath = path.join(memoryDir, '.watcher-state.json');
  main().catch(() => exitJson());
} else {
  module.exports = { extractText, readNewMessages, buildConversationText, ANALYSIS_PROMPT, extractStructuredOutput, FINDINGS_SCHEMA, CLI_ARGS, quoteArg };
}
