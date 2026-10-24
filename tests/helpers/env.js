// Environment for child processes in tests: only what the scripts need to run,
// nothing inherited from the developer's shell (no credentials or tokens).

'use strict';

function testEnv(extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...extra };
}

module.exports = { testEnv };
