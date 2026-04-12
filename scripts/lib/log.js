// Structured logger — JSON to stderr, zero dependencies.
// Set MT_LOG=debug for verbose output. Default: info.
// stderr keeps hook stdout (JSON protocol) clean.

const path = require('path');
const fs = require('fs');

const LEVEL = (process.env.MT_LOG || 'info').toLowerCase();
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

// Read version once at require time
let VERSION = '';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  VERSION = pkg.version || '';
} catch {}

function log(level, msg, data) {
  if (LEVELS[level] < (LEVEL in LEVELS ? LEVELS[LEVEL] : 1)) return;
  const entry = { ts: new Date().toISOString(), v: VERSION, level, msg };
  if (data) Object.assign(entry, data);
  process.stderr.write(JSON.stringify(entry) + '\n');
}

module.exports = {
  debug: (msg, data) => log('debug', msg, data),
  info: (msg, data) => log('info', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data),
};
