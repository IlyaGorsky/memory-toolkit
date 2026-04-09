const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'memory.js');
const TMP = path.join(__dirname, '.tmp-memory');

function run(args) {
  return execSync(`node "${SCRIPT}" --dir="${TMP}" ${args}`, {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
}

function writeFile(relativePath, content) {
  const full = path.join(TMP, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('memory.js', () => {
  beforeEach(() => {
    fs.mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  describe('search', () => {
    it('finds text in memory files', () => {
      writeFile('feedback/test.md', '---\nname: test\ntype: feedback\n---\nDon\'t use mocks in integration tests');

      const result = run('search "mocks"');

      assert.ok(result.includes('feedback/test.md'));
      assert.ok(result.includes('mocks'));
    });

    it('returns nothing for no matches', () => {
      writeFile('feedback/test.md', '---\nname: test\ntype: feedback\n---\nSome content');

      const result = run('search "nonexistent"');

      assert.ok(result.includes('Nothing found'));
    });

    it('shows usage when no query', () => {

      const result = run('search');

      assert.ok(result.includes('Usage'));
    });
  });

  describe('note', () => {
    it('creates daily note file', () => {
      const today = new Date().toISOString().slice(0, 10);

      const result = run('note "test note content"');

      assert.ok(result.includes(`notes/${today}.md`));
      const content = fs.readFileSync(path.join(TMP, 'notes', `${today}.md`), 'utf8');
      assert.ok(content.includes('test note content'));
    });

    it('appends to existing daily note', () => {
      const today = new Date().toISOString().slice(0, 10);
      run('note "first note"');

      run('note "second note"');

      const content = fs.readFileSync(path.join(TMP, 'notes', `${today}.md`), 'utf8');
      assert.ok(content.includes('first note'));
      assert.ok(content.includes('second note'));
    });
  });

  describe('list', () => {
    it('lists all memory files', () => {
      writeFile('feedback/a.md', '---\nname: a\ntype: feedback\n---\nContent A');
      writeFile('decisions/b.md', '---\nname: b\ntype: project\n---\nContent B');

      const result = run('list');

      assert.ok(result.includes('feedback/a.md'));
      assert.ok(result.includes('decisions/b.md'));
    });

    it('filters by type directory', () => {
      writeFile('feedback/a.md', '---\nname: a\ntype: feedback\n---\nContent');
      writeFile('decisions/b.md', '---\nname: b\ntype: project\n---\nContent');

      const result = run('list feedback');

      assert.ok(result.includes('feedback/a.md'));
      assert.ok(!result.includes('decisions/b.md'));
    });
  });

  describe('decisions', () => {
    it('finds files with Why/How to apply blocks', () => {
      writeFile('decisions/auth.md', '---\nname: auth\ndescription: Auth approach\ntype: project\n---\nUse JWT.\n\n**Why:** Stateless.\n**How to apply:** All new endpoints.');
      writeFile('feedback/other.md', '---\nname: other\ntype: feedback\n---\nJust a note');

      const result = run('decisions');

      assert.ok(result.includes('auth'));
      assert.ok(!result.includes('other'));
    });

    it('filters by topic', () => {
      writeFile('decisions/auth.md', '---\nname: auth\ndescription: Auth\ntype: project\n---\nJWT tokens.\n**Why:** Stateless.\n**How to apply:** Endpoints.');
      writeFile('decisions/db.md', '---\nname: db\ndescription: Database\ntype: project\n---\nPostgreSQL.\n**Why:** ACID.\n**How to apply:** All services.');

      const result = run('decisions "JWT"');

      assert.ok(result.includes('auth'));
      assert.ok(!result.includes('db'));
    });
  });

  describe('workstreams', () => {
    it('creates and lists workstream', () => {

      run('add-workstream auth login session token');
      const result = run('workstreams');

      assert.ok(result.includes('auth'));
      assert.ok(result.includes('login'));
    });

    it('removes workstream', () => {
      run('add-workstream temp keyword1');

      run('remove-workstream temp');
      const result = run('workstreams');

      assert.ok(!result.includes('temp'));
    });

    it('merges keywords on duplicate add', () => {
      run('add-workstream auth login');

      run('add-workstream auth session token');

      const ws = JSON.parse(fs.readFileSync(path.join(TMP, 'workstreams.json'), 'utf8'));
      assert.deepEqual(ws.auth.sort(), ['login', 'session', 'token']);
    });
  });

  describe('workstream query', () => {
    it('finds files by workstream keywords', () => {
      run('add-workstream auth login session');
      writeFile('feedback/login-flow.md', '---\nname: login\ntype: feedback\n---\nLogin must use OAuth');
      writeFile('feedback/other.md', '---\nname: other\ntype: feedback\n---\nUnrelated content');

      const result = run('workstream auth');

      assert.ok(result.includes('login-flow.md'));
      assert.ok(!result.includes('other.md'));
    });
  });

  describe('dir', () => {
    it('prints memory directory', () => {

      const result = run('dir');

      assert.equal(result, TMP);
    });
  });

  describe('recent', () => {
    it('shows recent feedback files', () => {
      writeFile('feedback/old.md', '---\nname: old\ntype: feedback\n---\nOld feedback');
      writeFile('feedback/new.md', '---\nname: new\ntype: feedback\n---\nNew feedback');

      const result = run('recent 1');

      assert.ok(result.includes('.md'));
    });
  });

  describe('docs', () => {
    it('collects DOC: notes from daily notes', () => {
      writeFile('notes/2026-04-09.md', '---\nname: Notes\ntype: project\n---\n\n# 2026-04-09\n\n- 14:30 DOC: testing — integration tests must hit real DB\n- 14:35 some other note\n- 15:00 DOC: api — webhook handlers must be idempotent\n');

      const result = run('docs');

      assert.ok(result.includes('testing'));
      assert.ok(result.includes('integration tests must hit real DB'));
      assert.ok(result.includes('api'));
      assert.ok(result.includes('webhook handlers must be idempotent'));
    });

    it('groups by domain', () => {
      writeFile('notes/2026-04-09.md', '---\nname: Notes\ntype: project\n---\n\n- 10:00 DOC: testing — rule one\n- 11:00 DOC: testing — rule two\n- 12:00 DOC: api — rule three\n');

      const result = run('docs');

      assert.ok(result.includes('testing (2)'));
      assert.ok(result.includes('api (1)'));
    });

    it('returns message when no DOC: notes', () => {
      writeFile('notes/2026-04-09.md', '---\nname: Notes\ntype: project\n---\n\n- 10:00 regular note\n');

      const result = run('docs');

      assert.ok(result.includes('No DOC:'));
    });

    it('collects from multiple days', () => {
      writeFile('notes/2026-04-08.md', '---\nname: Notes\ntype: project\n---\n\n- 10:00 DOC: architecture — decision from yesterday\n');
      writeFile('notes/2026-04-09.md', '---\nname: Notes\ntype: project\n---\n\n- 14:00 DOC: architecture — decision from today\n');

      const result = run('docs');

      assert.ok(result.includes('decision from yesterday'));
      assert.ok(result.includes('decision from today'));
    });

    it('handles DOC: without domain separator', () => {
      writeFile('notes/2026-04-09.md', '---\nname: Notes\ntype: project\n---\n\n- 10:00 DOC: some general insight\n');

      const result = run('docs');

      assert.ok(result.includes('general'));
      assert.ok(result.includes('some general insight'));
    });
  });
});
