const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'session-log.js');
const TMP = path.join(__dirname, '.tmp-session-log');

// session-log.js resolves memory dir from cwd via project key
// We'll create a fake memory dir and run with matching cwd
function setup() {
  const cwd = TMP;
  const projectKey = cwd.replace(/[/.]/g, '-').replace(/^-/, '');
  const memoryDir = path.join(
    process.env.HOME, '.claude', 'projects', `-${projectKey}`, 'memory'
  );
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { cwd, memoryDir };
}

function cleanup({ cwd, memoryDir }) {
  fs.rmSync(cwd, { recursive: true, force: true });
  // Clean up notes and sessions.jsonl but keep parent dirs
  const notesDir = path.join(memoryDir, 'notes');
  const sessionsFile = path.join(memoryDir, 'sessions.jsonl');
  const handoffDir = path.join(memoryDir, 'workstreams');
  fs.rmSync(notesDir, { recursive: true, force: true });
  fs.rmSync(handoffDir, { recursive: true, force: true });
  if (fs.existsSync(sessionsFile)) fs.unlinkSync(sessionsFile);
}

function run(stdinJson, cwd) {
  return execSync(`echo '${JSON.stringify(stdinJson)}' | node "${SCRIPT}"`, {
    encoding: 'utf8',
    cwd,
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

    run(input, ctx.cwd);

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

    run(input, ctx.cwd);

    const sessionsPath = path.join(ctx.memoryDir, 'sessions.jsonl');
    assert.ok(fs.existsSync(sessionsPath), 'sessions.jsonl should exist');
    const line = fs.readFileSync(sessionsPath, 'utf8').trim();
    const record = JSON.parse(line);
    assert.equal(record.id, 'sess-002');
    assert.equal(record.transcript, '/tmp/sess-002.jsonl');
  });

  it('accumulates multiple sessions', () => {
    run({ session_id: 'sess-a' }, ctx.cwd);

    run({ session_id: 'sess-b' }, ctx.cwd);

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

    const output = run({ session_id: 'sess-003' }, ctx.cwd);

    assert.ok(output.includes('Last session: did stuff'));
  });

  it('handles missing stdin gracefully', () => {

    const result = execSync(`echo '{}' | node "${SCRIPT}"`, {
      encoding: 'utf8',
      cwd: ctx.cwd,
      timeout: 5000,
    });

    const sessionsPath = path.join(ctx.memoryDir, 'sessions.jsonl');
    assert.ok(fs.existsSync(sessionsPath));
    const record = JSON.parse(fs.readFileSync(sessionsPath, 'utf8').trim());
    assert.equal(record.id, 'unknown');
  });
});
