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

  describe('handoff', () => {
    const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    function handoff({ age, branch = '' }) {
      fs.mkdirSync(path.join(ctx.memoryDir, 'workstreams'), { recursive: true });
      fs.writeFileSync(path.join(ctx.memoryDir, 'workstreams', 'handoff.md'),
        `---\nname: Session handoff\ndescription: "skills refresh, next: replay"\nmetadata:\n  modified: ${daysAgo(age)}\n${branch ? `  branch: ${branch}\n` : ''}---\n\n## Last session\nBODY-TEXT\n`);
    }

    it('passes a fresh handoff through as is', () => {
      handoff({ age: 2 });

      const output = run({ session_id: 's' }, ctx);

      assert.ok(output.includes('BODY-TEXT'));
      assert.ok(!output.includes('Older handoff'));
    });

    it('labels a week-old handoff with its age, by modified rather than mtime', () => {
      handoff({ age: 10 });

      const output = run({ session_id: 's' }, ctx);

      assert.ok(output.includes('Older handoff'));
      assert.ok(output.includes('10 days ago'));
      assert.ok(output.includes('BODY-TEXT'));
    });

    it('shows only the summary of a handoff from another branch', () => {
      execSync('git init -q -b harness', { cwd: ctx.cwd });
      handoff({ age: 1, branch: 'skills-refresh' });

      const output = run({ session_id: 's' }, ctx);

      assert.ok(output.includes('branch skills-refresh (now on harness)'));
      assert.ok(output.includes('Summary: skills refresh, next: replay'));
      assert.ok(!output.includes('BODY-TEXT'));
    });
  });

  it('invites /session-continue when the branch looks like a workstream', () => {
    execSync('git init -q -b viewer-fixes', { cwd: ctx.cwd });
    fs.writeFileSync(path.join(ctx.memoryDir, 'workstreams.json'), JSON.stringify({ viewer: ['viewer'] }));
    fs.mkdirSync(path.join(ctx.memoryDir, 'workstreams', 'viewer'), { recursive: true });
    fs.writeFileSync(path.join(ctx.memoryDir, 'workstreams', 'viewer', 'handoff.md'), '---\nname: viewer handoff\n---\nnext');

    const context = JSON.parse(run({ session_id: 's' }, ctx)).hookSpecificOutput.additionalContext;

    assert.ok(context.includes('looks like workstream "viewer"'), context);
    assert.ok(context.includes('/session-continue viewer'));
  });

  describe('workstream signals', () => {
    const day = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    function decisions(topic, n) {
      const notesDir = path.join(ctx.memoryDir, 'notes');
      fs.mkdirSync(notesDir, { recursive: true });
      for (let i = 0; i < n; i++) {
        fs.writeFileSync(path.join(notesDir, `${day(i + 1)}.md`), `# notes\n\n- 10:00 WATCH:DECISION: ${topic} decision ${i}\n`);
      }
    }

    it('stays silent below the thresholds', () => {
      decisions('search filters', 3);

      assert.ok(!run({ session_id: 's' }, ctx).includes('Workstreams (act only'));
    });

    it('asks the model to offer a workstream when decisions recur over several days', () => {
      decisions('search filters', 10);

      const output = run({ session_id: 's' }, ctx);

      assert.ok(output.includes('10 decisions over 10 days match no workstream'));
      assert.ok(output.includes('signals --mark-reviewed'));
    });

    it('lists identities without asking for anything', () => {
      fs.writeFileSync(path.join(ctx.memoryDir, 'workstreams.json'), JSON.stringify({ viewer: ['viewer'] }));
      fs.mkdirSync(path.join(ctx.memoryDir, 'workstreams', 'viewer'), { recursive: true });
      fs.writeFileSync(path.join(ctx.memoryDir, 'workstreams', 'viewer', 'workstream.md'),
        '---\nname: viewer\ndescription: Read-only viewer over memory\ntype: project\n---\nbody');

      const output = run({ session_id: 's' }, ctx);

      assert.ok(output.includes('Identities: viewer — Read-only viewer over memory'));
      assert.ok(!output.includes('--mark-reviewed'));
    });
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
