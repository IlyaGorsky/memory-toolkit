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

  describe('session-activity', () => {
    const today = new Date().toISOString().slice(0, 10);

    function writeNote(content) {
      writeFile(`notes/${today}.md`, content);
    }

    it('returns empty result when no notes file', () => {
      const out = JSON.parse(run('session-activity'));
      assert.equal(out.session_start, null);
      assert.deepEqual(out.items, []);
      assert.deepEqual(out.docs, []);
    });

    it('collects items after last SESSION_START', () => {
      writeNote([
        '- 09:00 SESSION_START uuid:old branch:main',
        '- 09:15 old session note',
        '- 10:00 SESSION_START uuid:new branch:main',
        '- 10:05 current note one',
        '- 10:10 current note two',
      ].join('\n'));

      const out = JSON.parse(run('session-activity'));

      assert.equal(out.session_start, '10:00');
      assert.deepEqual(out.items, ['current note one', 'current note two']);
    });

    it('separates DOC: items into docs field', () => {
      writeNote([
        '- 10:00 SESSION_START uuid:x branch:main',
        '- 10:05 regular note',
        '- 10:10 DOC: testing — hit real DB',
      ].join('\n'));

      const out = JSON.parse(run('session-activity'));

      assert.deepEqual(out.items, ['regular note', 'DOC: testing — hit real DB']);
      assert.deepEqual(out.docs, ['DOC: testing — hit real DB']);
    });

    it('skips SESSION_END and NEW_WORKSTREAM markers within session', () => {
      writeNote([
        '- 10:00 SESSION_START uuid:x branch:main',
        '- 10:05 real note',
        '- 10:06 NEW_WORKSTREAM foo',
        '- 10:10 another note',
        '- 10:15 SESSION_END',
      ].join('\n'));

      const out = JSON.parse(run('session-activity'));

      assert.deepEqual(out.items, ['real note', 'another note']);
    });

    it('returns empty items when SESSION_START is last line', () => {
      writeNote('- 10:00 SESSION_START uuid:x branch:main');

      const out = JSON.parse(run('session-activity'));

      assert.equal(out.session_start, '10:00');
      assert.deepEqual(out.items, []);
    });

    it('collects everything when no SESSION_START present', () => {
      writeNote([
        '# 2026-04-15',
        '',
        '- 10:05 orphan note one',
        '- 10:10 orphan note two',
      ].join('\n'));

      const out = JSON.parse(run('session-activity'));

      assert.equal(out.session_start, null);
      assert.deepEqual(out.items, ['orphan note one', 'orphan note two']);
    });
  });

  describe('handoff (read)', () => {
    it('prints per-workstream handoff when it exists', () => {
      writeFile('workstreams/auth/handoff.md', '---\nname: auth\ntype: project\n---\nauth-specific');
      writeFile('workstreams/handoff.md', '---\nname: g\ntype: project\n---\nglobal');

      const result = run('handoff auth');

      assert.ok(result.includes('auth-specific'));
      assert.ok(!result.includes('global'));
    });

    it('falls back to global when per-workstream missing', () => {
      writeFile('workstreams/handoff.md', '---\nname: g\ntype: project\n---\nglobal content');

      const result = run('handoff unknown');

      assert.ok(result.includes('global content'));
    });

    it('prints global when no workstream argument', () => {
      writeFile('workstreams/handoff.md', '---\nname: g\ntype: project\n---\nglobal only');

      const result = run('handoff');

      assert.ok(result.includes('global only'));
    });

    it('prints NO_HANDOFF when nothing exists', () => {
      const result = run('handoff missing');
      assert.ok(result.includes('NO_HANDOFF'));
    });

    it('rejects path-traversal in workstream name', () => {
      assert.throws(() => run('handoff ../../../etc'));
    });
  });

  describe('write-handoff', () => {
    function writeContent(content) {
      const p = path.join(TMP, 'handoff-content.md');
      fs.writeFileSync(p, content);
      return p;
    }

    it('writes workstreams/<name>/handoff.md with frontmatter auto-added', () => {
      const contentPath = writeContent('## Last session\n- did X\n');

      const out = run(`write-handoff --workstream=lifecycle --content=${contentPath}`);

      assert.ok(out.includes('workstreams/lifecycle/handoff.md'));
      const written = fs.readFileSync(path.join(TMP, 'workstreams', 'lifecycle', 'handoff.md'), 'utf8');
      assert.ok(written.startsWith('---\n'));
      assert.ok(written.includes('type: project'));
      assert.ok(written.includes('## Last session'));
    });

    it('preserves user-provided frontmatter', () => {
      const contentPath = writeContent('---\nname: custom\ntype: project\n---\n\nbody');

      run(`write-handoff --workstream=research --content=${contentPath}`);

      const written = fs.readFileSync(path.join(TMP, 'workstreams', 'research', 'handoff.md'), 'utf8');
      assert.ok(written.includes('name: custom'));
      assert.ok(!written.match(/---[\s\S]*---[\s\S]*---/)); // only one frontmatter block
    });

    it('overwrites existing handoff', () => {
      const first = writeContent('first');
      const second = writeContent('second');
      run(`write-handoff --workstream=infra --content=${first}`);
      run(`write-handoff --workstream=infra --content=${second}`);

      const written = fs.readFileSync(path.join(TMP, 'workstreams', 'infra', 'handoff.md'), 'utf8');
      assert.ok(written.includes('second'));
      assert.ok(!written.includes('first'));
    });

    it('rejects invalid workstream names', () => {
      const contentPath = writeContent('x');
      assert.throws(() => run(`write-handoff --workstream=../evil --content=${contentPath}`));
    });

    it('shows usage when flags missing', () => {
      const result = run('write-handoff');
      assert.ok(result.includes('Usage'));
    });
  });

  describe('session-changes', () => {
    const today = new Date().toISOString().slice(0, 10);
    const REPO = path.join(__dirname, '.tmp-repo');

    function gitInRepo(cmd) {
      return execSync(`git ${cmd}`, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    }
    function runInRepo(args) {
      return execSync(`node "${SCRIPT}" --dir="${TMP}" ${args}`, {
        cwd: REPO, encoding: 'utf8', timeout: 5000,
      }).trim();
    }
    function writeNote(content) {
      writeFile(`notes/${today}.md`, content);
    }

    beforeEach(() => {
      fs.mkdirSync(REPO, { recursive: true });
      gitInRepo('init -q -b main');
      gitInRepo('config user.email test@test');
      gitInRepo('config user.name Test');
      fs.writeFileSync(path.join(REPO, 'seed.txt'), 'seed\n');
      gitInRepo('add .');
      gitInRepo('commit -q -m "seed"');
    });

    afterEach(() => {
      fs.rmSync(REPO, { recursive: true, force: true });
    });

    it('returns uncommitted files when no SESSION_START', () => {
      fs.writeFileSync(path.join(REPO, 'dirty.txt'), 'x');

      const out = JSON.parse(runInRepo('session-changes'));

      assert.equal(out.since, null);
      assert.ok(out.files.includes('dirty.txt'));
      assert.deepEqual(out.commits, []);
    });

    it('collects commits and files since SESSION_START', () => {
      const now = new Date();
      const hhmm = `${String(Math.max(0, now.getHours() - 1)).padStart(2, '0')}:00`;
      writeNote(`- ${hhmm} SESSION_START uuid:x branch:main`);

      fs.writeFileSync(path.join(REPO, 'a.txt'), 'a');
      gitInRepo('add .');
      gitInRepo('commit -q -m "add a"');
      fs.writeFileSync(path.join(REPO, 'b.txt'), 'b');

      const out = JSON.parse(runInRepo('session-changes'));

      assert.equal(out.since, hhmm);
      assert.ok(out.commits.some(c => c.includes('add a')));
      assert.ok(out.files.includes('a.txt'));
      assert.ok(out.files.includes('b.txt'));
    });

    it('deduplicates files appearing in both commits and uncommitted', () => {
      const now = new Date();
      const hhmm = `${String(Math.max(0, now.getHours() - 1)).padStart(2, '0')}:00`;
      writeNote(`- ${hhmm} SESSION_START uuid:x branch:main`);

      fs.writeFileSync(path.join(REPO, 'shared.txt'), 'v1');
      gitInRepo('add .');
      gitInRepo('commit -q -m "add shared"');
      fs.writeFileSync(path.join(REPO, 'shared.txt'), 'v2');

      const out = JSON.parse(runInRepo('session-changes'));

      const shared = out.files.filter(f => f === 'shared.txt');
      assert.equal(shared.length, 1);
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

    it('prefers per-workstream handoff date over global', () => {
      run('add-workstream auth login');
      writeFile('workstreams/handoff.md', '---\nname: g\ntype: project\n---\nglobal');
      writeFile('workstreams/auth/handoff.md', '---\nname: auth\ntype: project\n---\nper-ws');

      const result = run('workstreams');

      assert.ok(result.includes('auth'));
      assert.ok(result.includes('handoff:'));
      assert.ok(!result.includes('(global)'));
    });

    it('marks handoff as global when no per-workstream handoff exists', () => {
      run('add-workstream auth login');
      writeFile('workstreams/handoff.md', '---\nname: g\ntype: project\n---\nglobal only');

      const result = run('workstreams');

      assert.ok(result.includes('(global)'));
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
