const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LOG_MODULE = path.join(__dirname, '..', 'scripts', 'lib', 'log.js');

function runChild(code, env) {
  const res = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { stderr: res.stderr, stdout: res.stdout, status: res.status };
}

describe('log.js — sessionId propagation', () => {
  let tmpFile;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `mt-log-test-${Date.now()}-${Math.random()}.log`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('omits sessionId when setSessionId was not called', () => {
    const { stderr } = runChild(
      `const log = require(${JSON.stringify(LOG_MODULE)}); log.info('hello');`,
      { MT_LOG: 'info' }
    );
    const line = JSON.parse(stderr.trim());
    assert.equal(line.msg, 'hello');
    assert.equal(line.sessionId, undefined);
  });

  it('attaches sessionId to every subsequent log line', () => {
    const { stderr } = runChild(
      `const log = require(${JSON.stringify(LOG_MODULE)});
       log.setSessionId('sess-abc');
       log.info('first');
       log.debug('second');
       log.warn('third');`,
      { MT_LOG: 'debug' }
    );
    const lines = stderr.trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 3);
    for (const l of lines) assert.equal(l.sessionId, 'sess-abc');
    assert.deepEqual(lines.map(l => l.msg), ['first', 'second', 'third']);
  });

  it('ignores unknown / empty session ids', () => {
    const { stderr } = runChild(
      `const log = require(${JSON.stringify(LOG_MODULE)});
       log.setSessionId('unknown');
       log.setSessionId('');
       log.setSessionId(undefined);
       log.info('no-session');`,
      { MT_LOG: 'info' }
    );
    const line = JSON.parse(stderr.trim());
    assert.equal(line.sessionId, undefined);
  });

  it('data argument can override sessionId', () => {
    const { stderr } = runChild(
      `const log = require(${JSON.stringify(LOG_MODULE)});
       log.setSessionId('sess-default');
       log.info('overridden', { sessionId: 'sess-specific' });`,
      { MT_LOG: 'info' }
    );
    const line = JSON.parse(stderr.trim());
    assert.equal(line.sessionId, 'sess-specific');
  });

  it('writes sessionId to MT_LOG_FILE sink', () => {
    runChild(
      `const log = require(${JSON.stringify(LOG_MODULE)});
       log.setSessionId('sess-file');
       log.info('to-file');`,
      { MT_LOG: 'info', MT_LOG_FILE: tmpFile }
    );
    const contents = fs.readFileSync(tmpFile, 'utf8').trim();
    const line = JSON.parse(contents);
    assert.equal(line.sessionId, 'sess-file');
    assert.equal(line.msg, 'to-file');
  });
});
