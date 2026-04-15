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

  describe('classify', () => {
    function writeWorkstreams(obj) {
      fs.writeFileSync(path.join(TMP, 'workstreams.json'), JSON.stringify(obj));
    }
    function writeItems(items) {
      const p = path.join(TMP, 'items.json');
      fs.writeFileSync(p, JSON.stringify(items));
      return p;
    }

    it('routes items to single workstream by keyword match', () => {
      writeWorkstreams({ lifecycle: ['session-end', 'session-start'], infra: ['memory.js'] });
      const items = writeItems(['refactor session-end phase 1', 'tweak memory.js router']);

      const out = JSON.parse(run(`classify --items=${items}`));

      assert.deepEqual(out.lifecycle, ['refactor session-end phase 1']);
      assert.deepEqual(out.infra, ['tweak memory.js router']);
      assert.deepEqual(out._unassigned, []);
    });

    it('assigns item to multiple workstreams (multi-label)', () => {
      writeWorkstreams({ lifecycle: ['session-end'], docs: ['handoff'] });
      const items = writeItems(['session-end writes handoff per workstream']);

      const out = JSON.parse(run(`classify --items=${items}`));

      assert.deepEqual(out.lifecycle, ['session-end writes handoff per workstream']);
      assert.deepEqual(out.docs, ['session-end writes handoff per workstream']);
      assert.deepEqual(out._unassigned, []);
    });

    it('puts unmatched items in _unassigned', () => {
      writeWorkstreams({ lifecycle: ['session-end'] });
      const items = writeItems(['totally unrelated thought']);

      const out = JSON.parse(run(`classify --items=${items}`));

      assert.deepEqual(out._unassigned, ['totally unrelated thought']);
      assert.ok(!out.lifecycle);
    });

    it('is case-insensitive', () => {
      writeWorkstreams({ infra: ['Memory.js'] });
      const items = writeItems(['update MEMORY.JS router']);

      const out = JSON.parse(run(`classify --items=${items}`));

      assert.deepEqual(out.infra, ['update MEMORY.JS router']);
    });

    it('handles empty items array', () => {
      writeWorkstreams({ lifecycle: ['session-end'] });
      const items = writeItems([]);

      const out = JSON.parse(run(`classify --items=${items}`));

      assert.deepEqual(out, { _unassigned: [] });
    });

    it('treats all items as unassigned when workstreams.json missing', () => {
      const items = writeItems(['anything goes here']);

      const out = JSON.parse(run(`classify --items=${items}`));

      assert.deepEqual(out._unassigned, ['anything goes here']);
    });

    it('shows usage when --items flag missing', () => {
      const result = run('classify');
      assert.ok(result.includes('Usage'));
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

  describe('recurring', () => {
    it('finds recurring feedback patterns', () => {
      writeFile('feedback/no-mocks-1.md', '---\nname: no mocks\ndescription: Do not mock database in integration tests\ntype: feedback\n---\nDo not mock database in integration tests');
      writeFile('feedback/no-mocks-2.md', '---\nname: no mocks again\ndescription: Stop mocking database in integration tests\ntype: feedback\n---\nStop mocking database in integration tests');

      const result = run('recurring');

      assert.ok(result.includes('mock'));
      assert.ok(result.includes('×2'));
      assert.ok(result.includes('.claude/rules/'));
    });

    it('returns message when no recurring patterns', () => {
      writeFile('feedback/unique-1.md', '---\nname: one\ndescription: Completely unique topic alpha\ntype: feedback\n---\nalpha beta gamma');
      writeFile('feedback/unique-2.md', '---\nname: two\ndescription: Totally different subject omega\ntype: feedback\n---\nomega delta epsilon');

      const result = run('recurring');

      assert.ok(result.includes('No recurring'));
    });

    it('ignores clusters smaller than 2', () => {
      writeFile('feedback/single.md', '---\nname: single\ndescription: Only one feedback about testing\ntype: feedback\n---\nTesting something');

      const result = run('recurring');

      assert.ok(result.includes('No recurring'));
    });
  });

  // --- health ---

  describe('health', () => {
    it('reports healthy on clean memory', () => {
      writeFile('feedback/ok.md', '---\nname: ok\ndescription: test\ntype: feedback\n---\nContent');
      writeFile('MEMORY.md', '# Memory\n- [ok](feedback/ok.md) — test\n');

      const result = run('health');
      assert.ok(result.includes('healthy'));
    });

    it('detects dead links in MEMORY.md', () => {
      writeFile('MEMORY.md', '# Memory\n- [gone](feedback/deleted.md) — was here\n');

      const result = run('health');
      assert.ok(result.includes('Dead link'));
      assert.ok(result.includes('feedback/deleted.md'));
    });

    it('warns when MEMORY.md exceeds 150 lines', () => {
      const lines = ['# Memory'];
      for (let i = 0; i < 160; i++) {
        lines.push(`- Line ${i}`);
      }
      writeFile('MEMORY.md', lines.join('\n'));

      const result = run('health');
      assert.ok(result.includes('warning'));
    });

    it('errors when MEMORY.md exceeds 200 lines', () => {
      const lines = ['# Memory'];
      for (let i = 0; i < 210; i++) {
        lines.push(`- Line ${i}`);
      }
      writeFile('MEMORY.md', lines.join('\n'));

      const result = run('health');
      assert.ok(result.includes('error'));
      assert.ok(result.includes('reindex'));
    });

    it('detects stale files (>30 days)', () => {
      const filePath = path.join(TMP, 'feedback', 'old.md');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '---\nname: old\ndescription: ancient\ntype: feedback\n---\nOld content');
      // Set mtime to 60 days ago
      const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      fs.utimesSync(filePath, oldTime, oldTime);

      const result = run('health');
      assert.ok(result.includes('older than 30 days'));
    });

    it('detects duplicate descriptions', () => {
      writeFile('feedback/one.md', '---\nname: one\ndescription: Same exact description\ntype: feedback\n---\nFirst');
      writeFile('feedback/two.md', '---\nname: two\ndescription: Same exact description\ntype: feedback\n---\nSecond');

      const result = run('health');
      assert.ok(result.includes('Duplicate'));
    });

    it('reports no issues on empty memory dir', () => {
      // TMP exists but is empty (no MEMORY.md)
      const result = run('health');
      assert.ok(result.includes('No MEMORY.md'));
    });
  });
});
