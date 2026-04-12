// Structured logger — JSON to stderr, zero dependencies.
// Set MT_LOG=debug for verbose output. Default: info.
// stderr keeps hook stdout (JSON protocol) clean.

const LEVEL = (process.env.MT_LOG || 'info').toLowerCase();
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

function log(level, msg, data) {
  if (LEVELS[level] < (LEVEL in LEVELS ? LEVELS[LEVEL] : 1)) return;
  const entry = { ts: new Date().toISOString(), level, msg };
  if (data) Object.assign(entry, data);
  process.stderr.write(JSON.stringify(entry) + '\n');
}

module.exports = {
  debug: (msg, data) => log('debug', msg, data),
  info: (msg, data) => log('info', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data),
};
