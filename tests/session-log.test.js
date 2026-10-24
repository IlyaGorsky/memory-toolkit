const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { sanitizePath } = require('../scripts/lib/find-memory-dir');
const { testEnv } = require('./helpers/env');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'session-log.js');

// session-log.js resolves memory dir from cwd via project key.
// Throwaway HOME + non-git cwd outside the repo (see .claude/rules/testing.md).
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-session-log-')));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const memoryDir = path.join(home, '.claude', 'projects', sanitizePath(cwd), 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { root, home, cwd, memoryDir };
}

function cleanup({ root }) {
  fs.rmSync(root, { recursive: true, force: true });
}

function run(stdinJson, ctx) {
  return execSync(`echo '${JSON.stringify(stdinJson)}' | node "${SCRIPT}"`, {
    encoding: 'utf8',
    cwd: ctx.cwd,
    env: testEnv({ HOME: ctx.home }),
    timeout: 5000,
  });
}

describe('session-log.js', () => {
  let ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    cleanup(ctx);
  });

  it('logs session start to daily notes', () => {
    const input = { session_id: 'sess-001', transcript_path: '/tmp/sess-001.jsonl' };

    run(input, ctx);

    const today = new Date().toISOString().slice(0, 10);
    const notePath = path.join(ctx.memoryDir, 'notes', `${today}.md`);
    assert.ok(fs.existsSync(notePath), 'notes file should exist');
    const content = fs.readFileSync(notePath, 'utf8');
    assert.ok(content.includes('SESSION_START'));
    assert.ok(content.includes('uuid:sess-001'));
    assert.ok(content.includes('transcript:/tmp/sess-001.jsonl'));
  });

  it('appends to sessions.jsonl', () => {
    const input = { session_id: 'sess-002', transcript_path: '/tmp/sess-002.jsonl' };

    run(input, ctx);

    const sessionsPath = path.join(ctx.memoryDir, 'sessions.jsonl');
    assert.ok(fs.existsSync(sessionsPath), 'sessions.jsonl should exist');
    const line = fs.readFileSync(sessionsPath, 'utf8').trim();
    const record = JSON.parse(line);
    assert.equal(record.id, 'sess-002');
    assert.equal(record.transcript, '/tmp/sess-002.jsonl');
  });

  it('accumulates multiple sessions', () => {
    run({ session_id: 'sess-a' }, ctx);

    run({ session_id: 'sess-b' }, ctx);

    const sessionsPath = path.join(ctx.memoryDir, 'sessions.jsonl');
    const lines = fs.readFileSync(sessionsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).id, 'sess-a');
    assert.equal(JSON.parse(lines[1]).id, 'sess-b');
  });

  it('outputs handoff if exists', () => {
    const handoffDir = path.join(ctx.memoryDir, 'workstreams');
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, 'handoff.md'), 'Last session: did stuff');

    const output = run({ session_id: 'sess-003' }, ctx);

    assert.ok(output.includes('Last session: did stuff'));
  });

  it('outputs DOC reminder', () => {
    const output = run({ session_id: 'sess-004' }, ctx);

    assert.ok(output.includes('DOC:'));
    assert.ok(output.includes('/memory note'));
    assert.ok(output.includes('/docs-reflect'));
  });

  it('handles missing stdin gracefully', () => {

    const result = execSync(`echo '{}' | node "${SCRIPT}"`, {
      encoding: 'utf8',
      cwd: ctx.cwd,
      env: testEnv({ HOME: ctx.home }),
      timeout: 5000,
    });

    const sessionsPath = path.join(ctx.memoryDir, 'sessions.jsonl');
    assert.ok(fs.existsSync(sessionsPath));
    const record = JSON.parse(fs.readFileSync(sessionsPath, 'utf8').trim());
    assert.equal(record.id, 'unknown');
  });
});
