const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'session-save.js');
const TMP = path.join(__dirname, '.tmp-session-save');

function setup() {
  const cwd = TMP;
  const projectKey = cwd.replace(/[/.]/g, '-').replace(/^-/, '');
  const memoryDir = path.join(
    process.env.HOME, '.claude', 'projects', `-${projectKey}`, 'memory'
  );
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  // Init git so session-save can read branch/commit
  execSync('git init && git commit --allow-empty -m "init"', { cwd, encoding: 'utf8' });
  return { cwd, memoryDir };
}

function cleanup({ cwd, memoryDir }) {
  fs.rmSync(cwd, { recursive: true, force: true });
  const notesDir = path.join(memoryDir, 'notes');
  const handoffDir = path.join(memoryDir, 'workstreams');
  fs.rmSync(notesDir, { recursive: true, force: true });
  fs.rmSync(handoffDir, { recursive: true, force: true });
}

function run(stdinJson, cwd) {
  return execSync(`echo '${JSON.stringify(stdinJson)}' | node "${SCRIPT}"`, {
    encoding: 'utf8',
    cwd,
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('session-save.js', () => {
  let ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    cleanup(ctx);
  });

  it('creates handoff with session id', () => {
    const input = { session_id: 'save-001' };

    run(input, ctx.cwd);

    const handoffPath = path.join(ctx.memoryDir, 'workstreams', 'handoff.md');
    assert.ok(fs.existsSync(handoffPath), 'handoff.md should exist');
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('Session:** save-001'));
    assert.ok(content.includes('Pre-compact snapshot'));
  });

  it('includes git info in handoff', () => {
    const input = { session_id: 'save-002' };

    run(input, ctx.cwd);

    const handoffPath = path.join(ctx.memoryDir, 'workstreams', 'handoff.md');
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('Branch:'));
    assert.ok(content.includes('Last commit:'));
    assert.ok(content.includes('init'));
  });

  it('logs pre-compact to daily notes with uuid', () => {
    const input = { session_id: 'save-003' };

    run(input, ctx.cwd);

    const today = new Date().toISOString().slice(0, 10);
    const notePath = path.join(ctx.memoryDir, 'notes', `${today}.md`);
    assert.ok(fs.existsSync(notePath), 'notes file should exist');
    const content = fs.readFileSync(notePath, 'utf8');
    assert.ok(content.includes('PRE_COMPACT'));
    assert.ok(content.includes('uuid:save-003'));
  });

  it('handles unknown session id', () => {

    run({}, ctx.cwd);

    const handoffPath = path.join(ctx.memoryDir, 'workstreams', 'handoff.md');
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('Session:** unknown'));
  });
});
