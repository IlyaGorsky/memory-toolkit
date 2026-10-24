const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { sanitizePath } = require('../scripts/lib/find-memory-dir');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'session-save.js');

// Throwaway HOME + project outside the repo (see .claude/rules/testing.md).
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-session-save-')));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const memoryDir = path.join(home, '.claude', 'projects', sanitizePath(cwd), 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  // Init git so session-save can read branch/commit
  execSync('git init && git commit --allow-empty -m "init"', { cwd, encoding: 'utf8' });
  return { root, home, cwd, memoryDir };
}

function cleanup({ root }) {
  fs.rmSync(root, { recursive: true, force: true });
}

function run(stdinJson, ctx) {
  return execSync(`echo '${JSON.stringify(stdinJson)}' | node "${SCRIPT}"`, {
    encoding: 'utf8',
    cwd: ctx.cwd,
    env: { ...process.env, HOME: ctx.home },
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

  it('creates pre-compact snapshot with session id', () => {
    const input = { session_id: 'save-001' };

    run(input, ctx);

    const handoffPath = path.join(ctx.memoryDir, 'workstreams', 'precompact.md');
    assert.ok(fs.existsSync(handoffPath), 'precompact.md should exist');
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('Session:** save-001'));
    assert.ok(content.includes('Pre-compact snapshot'));
  });

  it('includes git info in snapshot', () => {
    const input = { session_id: 'save-002' };

    run(input, ctx);

    const handoffPath = path.join(ctx.memoryDir, 'workstreams', 'precompact.md');
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('Branch:'));
    assert.ok(content.includes('Last commit:'));
    assert.ok(content.includes('init'));
  });

  it('logs pre-compact to daily notes with uuid', () => {
    const input = { session_id: 'save-003' };

    run(input, ctx);

    const today = new Date().toISOString().slice(0, 10);
    const notePath = path.join(ctx.memoryDir, 'notes', `${today}.md`);
    assert.ok(fs.existsSync(notePath), 'notes file should exist');
    const content = fs.readFileSync(notePath, 'utf8');
    assert.ok(content.includes('PRE_COMPACT'));
    assert.ok(content.includes('uuid:save-003'));
  });

  it('does not touch existing handoff.md', () => {
    const handoffPath = path.join(ctx.memoryDir, 'workstreams', 'handoff.md');
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, 'real handoff');

    run({ session_id: 'save-004' }, ctx);

    assert.strictEqual(fs.readFileSync(handoffPath, 'utf8'), 'real handoff');
  });

  it('handles unknown session id', () => {

    run({}, ctx);

    const handoffPath = path.join(ctx.memoryDir, 'workstreams', 'precompact.md');
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('Session:** unknown'));
  });
});
