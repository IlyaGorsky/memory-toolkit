// Structured logger — JSON to stderr, zero dependencies.
// Set MT_LOG=debug for verbose output. Default: info.
// Set MT_LOG_FILE=<path> to also append logs to a file (useful when stderr is swallowed,
// e.g. inside VS Code extension / remote agents). stderr is always additive.

const path = require('path');
const fs = require('fs');
const os = require('os');

const LEVEL = (process.env.MT_LOG || 'info').toLowerCase();
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

// Read version once at require time
let VERSION = '';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  VERSION = pkg.version || '';
} catch {}

function resolveLogFile() {
  const raw = process.env.MT_LOG_FILE;
  if (!raw) return null;
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

const LOG_FILE = resolveLogFile();
let fileSinkBroken = false;

let sessionId = null;
function setSessionId(id) {
  if (typeof id === 'string' && id && id !== 'unknown') sessionId = id;
}

function writeFileSink(line) {
  if (!LOG_FILE || fileSinkBroken) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Never break the caller because logging failed. Disable sink after first error.
    fileSinkBroken = true;
  }
}

function log(level, msg, data) {
  if (LEVELS[level] < (LEVEL in LEVELS ? LEVELS[LEVEL] : 1)) return;
  const entry = { ts: new Date().toISOString(), v: VERSION, level, msg };
  if (sessionId) entry.sessionId = sessionId;
  if (data) Object.assign(entry, data);
  const line = JSON.stringify(entry) + '\n';
  process.stderr.write(line);
  writeFileSink(line);
}

module.exports = {
  debug: (msg, data) => log('debug', msg, data),
  info: (msg, data) => log('info', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data),
  setSessionId,
};
