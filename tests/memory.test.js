const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { testEnv } = require('./helpers/env');
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

    it('starts at the first marker of the session, not the one compact re-logged', () => {
      writeNote([
        '- 09:00 SESSION_START uuid:a branch:main',
        '- 09:10 before compact',
        '- 10:00 SESSION_START uuid:a branch:main',
        '- 10:05 after compact',
      ].join('\n'));

      const out = JSON.parse(run('session-activity'));

      assert.equal(out.session_start, '09:00');
      assert.deepEqual(out.items, ['before compact', 'after compact']);
    });

    it('follows a session past midnight', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      writeFile(`notes/${yesterday}.md`, '- 23:00 SESSION_START uuid:a branch:main\n- 23:30 late decision\n');
      writeNote('- 00:30 SESSION_START uuid:a branch:main\n- 00:40 after resume');

      const out = JSON.parse(run('session-activity'));

      assert.equal(out.session_start_date, yesterday);
      assert.deepEqual(out.items, ['late decision', 'after resume']);
    });

    it('takes the boundary of CLAUDE_CODE_SESSION_ID over a later parallel session', () => {
      writeNote([
        '- 09:00 SESSION_START uuid:mine branch:main',
        '- 09:10 my note',
        '- 09:30 SESSION_START uuid:other branch:main',
      ].join('\n'));
      const runAs = id => JSON.parse(execSync(`node "${SCRIPT}" --dir="${TMP}" session-activity`, {
        encoding: 'utf8', env: testEnv({ CLAUDE_CODE_SESSION_ID: id }),
      }));

      assert.equal(runAs('mine').session_start, '09:00');
      assert.equal(runAs('unknown').session_start, '09:30');
    });

    it('skips the DOCS_REVIEWED marker', () => {
      writeNote([
        '- 10:00 SESSION_START uuid:x branch:main',
        '- 10:05 DOCS_REVIEWED',
        '- 10:10 current note',
      ].join('\n'));

      const out = JSON.parse(run('session-activity'));

      assert.deepEqual(out.items, ['current note']);
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

    it('stamps modified and the current branch, also under metadata:', () => {
      const repo = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mt-handoff-branch-'));
      execSync('git init -q -b feature-x', { cwd: repo });
      const contentPath = writeContent('---\nname: x\nmetadata:\n  type: project\n  modified: 2020-01-01T00:00:00.000Z\n---\nbody');

      execSync(`node "${SCRIPT}" --dir="${TMP}" write-handoff --workstream=viewer --content=${contentPath}`, { cwd: repo, env: testEnv() });
      fs.rmSync(repo, { recursive: true, force: true });

      const written = fs.readFileSync(path.join(TMP, 'workstreams', 'viewer', 'handoff.md'), 'utf8');
      assert.ok(written.includes('branch: feature-x'));
      assert.ok(/^ {2}modified: \d{4}-/m.test(written), written);
      assert.ok(!written.includes('2020-01-01'));
    });

    it('--global writes workstreams/handoff.md', () => {
      const out = run(`write-handoff --global --content=${writeContent('## Last session\n')}`);

      assert.ok(out.includes('workstreams/handoff.md'));
      const written = fs.readFileSync(path.join(TMP, 'workstreams', 'handoff.md'), 'utf8');
      assert.ok(written.includes('name: Session handoff'));
      assert.ok(written.includes('modified:'));
    });

    it('shows usage when flags missing', () => {
      const result = run('write-handoff');
      assert.ok(result.includes('Usage'));
    });
  });

  describe('workstream cards', () => {
    const day = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const NOTE_HEAD = '---\nname: Notes\ntype: project\n---\n\n';

    function workstreams(obj) {
      fs.writeFileSync(path.join(TMP, 'workstreams.json'), JSON.stringify(obj));
    }
    function writeContent(content) {
      const p = path.join(TMP, 'card-content.md');
      fs.writeFileSync(p, content);
      return p;
    }
    // n decision lines about `topic`, one per day, starting `fromDay` days ago
    function decisions(topic, n, fromDay) {
      for (let i = 0; i < n; i++) {
        const file = path.join(TMP, 'notes', `${day(fromDay + i)}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) fs.writeFileSync(file, NOTE_HEAD);
        fs.appendFileSync(file, `- 10:0${i % 10} WATCH:DECISION: ${topic} decision ${i}\n`);
      }
    }
    function card(ws, { updated, body = 'body', description = `${ws} card` }) {
      writeFile(`workstreams/${ws}.md`, `---\nname: ${ws}\ndescription: ${description}\nmetadata:\n  modified: ${updated}T12:00:00.000Z\n---\n${body}`);
    }
    const signals = () => JSON.parse(run('signals'));

    it('prints NO_CARD when there is no card', () => {
      assert.equal(run('card viewer'), 'NO_CARD');
    });

    it('write-card writes workstreams/<name>.md with frontmatter, card prints it', () => {
      const out = run(`write-card --workstream=viewer --content=${writeContent('## What is this\nRead-only viewer\n')}`);

      assert.ok(out.includes('workstreams/viewer.md'));
      const printed = run('card viewer');
      assert.ok(printed.includes('category: workstream'));
      assert.ok(printed.includes('modified:'));
      assert.ok(printed.includes('Read-only viewer'));
    });

    it('--material lists the routed decisions newest first and marks the card update', () => {
      workstreams({ viewer: ['viewer'], docs: ['docs-reflect'] });
      card('viewer', { updated: day(2), body: 'stays read-only' });
      writeFile(`notes/${day(3)}.md`, `${NOTE_HEAD}- 10:00 WATCH:DECISION: viewer old decision\n- 10:05 WATCH:DECISION: docs-reflect keeps a marker\n`);
      writeFile(`notes/${day(1)}.md`, `${NOTE_HEAD}- 09:00 REFLECT: viewer exposed a bug\n- 09:05 WATCH:PLAN: viewer plan is not a decision\n`);

      const out = run('card viewer --material');

      assert.ok(out.includes(`Current card (updated ${day(2)})`));
      assert.ok(out.includes('Decisions, corrections, reflections (2'));
      const marker = out.indexOf(`— card updated ${day(2)} —`);
      assert.ok(out.indexOf('viewer exposed a bug') < marker && marker < out.indexOf('viewer old decision'));
      assert.ok(!out.includes('docs-reflect keeps a marker'));
      assert.ok(!out.includes('plan is not a decision'));
    });

    it('unassigned lists decisions that match no workstream within the window', () => {
      workstreams({ viewer: ['viewer'] });
      writeFile(`notes/${day(1)}.md`, `${NOTE_HEAD}- 10:00 WATCH:DECISION: viewer stays read-only\n- 10:05 WATCH:CORRECTION: search filters go left\n`);
      writeFile(`notes/${day(40)}.md`, `${NOTE_HEAD}- 10:00 WATCH:DECISION: an old unrelated decision\n`);

      const out = run('unassigned');

      assert.ok(out.includes('search filters go left'));
      assert.ok(!out.includes('viewer stays read-only'));
      assert.ok(!out.includes('old unrelated'));
      assert.ok(run('unassigned --days=60').includes('old unrelated'));
    });

    it('signals a gap for an active workstream without a card', () => {
      workstreams({ viewer: ['viewer'], quiet: ['quiet'] });
      decisions('viewer', 8, 1);
      decisions('quiet', 8, 40); // as many decisions, none in the last 30 days

      const s = signals();

      assert.deepEqual(s.cardGaps.map(g => [g.workstream, g.card]), [['viewer', false]]);
      assert.equal(s.cardGaps[0].recent, 8);
      assert.deepEqual(s.cardGaps[0].related, []);
    });

    it('names files that may be the card under another name', () => {
      workstreams({ avito: ['avito'] });
      decisions('avito', 8, 1);
      writeFile('workstreams/avito-prototype.md', '---\nname: Avito prototype\n---\nbody');
      writeFile('workstreams/avitoish.md', '---\nname: other\n---\nbody');

      assert.deepEqual(signals().cardGaps[0].related, ['avito-prototype.md']);
    });

    it('a current card closes the gap and joins the index; an outrun card is flagged', () => {
      workstreams({ viewer: ['viewer'], search: ['search'] });
      decisions('viewer', 8, 1);
      decisions('search', 8, 1);
      card('viewer', { updated: day(0), description: 'Read-only viewer' });
      card('search', { updated: day(20) });

      const s = signals();

      assert.deepEqual(s.cardGaps.map(g => [g.workstream, g.card, g.sinceCard]), [['search', true, 8]]);
      assert.deepEqual(s.cards.map(c => c.workstream).sort(), ['search', 'viewer']);
      assert.ok(s.cards.some(c => c.description === 'Read-only viewer'));
    });

    it('suggests a new workstream only for decisions spread over several days', () => {
      decisions('search filters', 10, 1);
      assert.equal(signals().unassigned.suggest, true);

      fs.rmSync(path.join(TMP, 'notes'), { recursive: true, force: true });
      const burst = Array.from({ length: 12 }, (_, i) => `- 10:${String(i).padStart(2, '0')} WATCH:DECISION: one-off ${i}`).join('\n');
      writeFile(`notes/${day(1)}.md`, `${NOTE_HEAD}${burst}\n`);
      const s = signals();
      assert.equal(s.unassigned.items, 12);
      assert.equal(s.unassigned.suggest, false);
    });

    it('signals --mark-reviewed resets the counts until new decisions pile up', () => {
      workstreams({ viewer: ['viewer'] });
      decisions('viewer', 8, 1);
      decisions('search filters', 10, 1);

      run('signals --mark-reviewed');
      const s = signals();

      assert.deepEqual(s.cardGaps, []);
      assert.equal(s.unassigned.items, 0);
    });

    it('workstreams shows when each card was updated', () => {
      workstreams({ viewer: ['viewer'], docs: ['docs'] });
      card('viewer', { updated: '2026-10-20' });

      const out = run('workstreams');

      assert.ok(/viewer .*card: 2026-10-20/.test(out));
      assert.ok(/docs .*no card/.test(out));
    });

    it('health warns when a card outgrows a read', () => {
      workstreams({ viewer: ['viewer'] });
      run(`write-card --workstream=viewer --content=${writeContent(Array(160).fill('- line').join('\n'))}`);

      assert.ok(run('health').includes('workstreams/viewer.md is'));
    });
  });

  describe('receipt', () => {
    const today = new Date().toISOString().slice(0, 10);
    const receipt = () => JSON.parse(execSync(`node "${SCRIPT}" --dir="${TMP}" receipt --json`, {
      encoding: 'utf8', env: testEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    }));

    it('lists what the session left and which cards kept up', () => {
      fs.writeFileSync(path.join(TMP, 'workstreams.json'), JSON.stringify({ viewer: ['viewer'], search: ['search'] }));
      writeFile(`notes/${today}.md`, [
        '- 09:00 SESSION_START uuid:s1 branch:main',
        '- 09:10 WATCH:DECISION: viewer stays read-only',
        '- 09:20 WATCH:CORRECTION: search filters go left',
        '- 09:30 DOC: testing — use a fake HOME',
        '- 09:40 COMMIT: abc123 viewer: fix',
        '- 09:50 just a note',
      ].join('\n'));
      writeFile('feedback/fake-home.md', '---\nname: fake home\nmetadata:\n  originSessionId: s1\n---\nbody');
      writeFile('feedback/older.md', '---\nname: older\noriginSessionId: s0\n---\nbody');
      writeFile('workstreams/viewer.md', '---\nname: viewer\noriginSessionId: s1\n---\ncard');
      writeFile('workstreams/search.md', '---\nname: search\noriginSessionId: s0\n---\ncard');

      const r = receipt();

      assert.deepEqual(r.files, ['feedback/fake-home.md', 'workstreams/viewer.md']);
      assert.deepEqual([r.logged.decision, r.logged.correction, r.logged.doc, r.logged.commit], [1, 1, 1, 1]);
      assert.deepEqual(r.workstreams.map(w => [w.workstream, w.card]).sort(), [['search', 'not updated'], ['viewer', 'updated']]);
    });

    it('memory.js writes carry the session id, so the receipt sees them', () => {
      const content = path.join(TMP, 'card.md');
      fs.writeFileSync(content, 'card body');
      execSync(`node "${SCRIPT}" --dir="${TMP}" write-card --workstream=viewer --content=${content}`, {
        env: testEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
      });

      assert.ok(receipt().files.includes('workstreams/viewer.md'));
    });
  });

  describe('parking', () => {
    const day = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    function writeContent(content) {
      const p = path.join(TMP, 'park-content.md');
      fs.writeFileSync(p, content);
      return p;
    }

    it('parks into the workstream folder, one file per item, stamped as parked', () => {
      const out = run(`park --title="Auto-approve memory.js calls" --kind=task --workstream=lifecycle --content=${writeContent('## What\ninvestigate allowed-tools\n')}`);

      assert.ok(out.includes('workstreams/lifecycle/auto-approve-memory-js-calls.md'));
      const written = fs.readFileSync(path.join(TMP, 'workstreams', 'lifecycle', 'auto-approve-memory-js-calls.md'), 'utf8');
      assert.ok(written.includes('category: parked'));
      assert.ok(written.includes('kind: task'));
      assert.ok(written.includes(`parked: ${day(0)}`));
      assert.ok(written.includes('investigate allowed-tools'));
    });

    it('parks without a workstream into parked/, and never overwrites', () => {
      run(`park --title="Shared memory across CLIs" --content=${writeContent('one')}`);
      const out = run(`park --title="Shared memory across CLIs" --content=${writeContent('two')}`);

      assert.ok(out.includes('parked/shared-memory-across-clis-2.md'));
      assert.ok(fs.existsSync(path.join(TMP, 'parked', 'shared-memory-across-clis.md')));
    });

    it('parked lists files, flags old ones, keeps /park files without the category, and recent PARKED notes', () => {
      writeFile('parked/old.md', `---\nname: Old one\ndescription: waits\ncategory: parked\nparked: ${day(45)}\n---\nbody`);
      writeFile('workstreams/scaffold/tools-poc.md', '---\nname: Tools PoC\ntype: project\n---\n## What\nx\n## Next step\ny');
      writeFile('workstreams/scaffold/handoff.md', '---\nname: handoff\n---\n## Next step\nnot parked');
      writeFile(`notes/${day(2)}.md`, '- 10:00 PARKED: agnostic multi-agent support\n');

      const out = run('parked');

      assert.ok(out.includes('Old one — waits'));
      assert.ok(out.includes('⚠ over 30 days'));
      assert.ok(out.includes('workstreams/scaffold/tools-poc.md'));
      assert.ok(!out.includes('workstreams/scaffold/handoff.md'));
      assert.ok(out.includes('agnostic multi-agent support'));
      assert.ok(!run('parked scaffold').includes('Old one'));
    });

    it('unpark removes the item and notes where it went', () => {
      run(`park --title="Try Stop hook" --content=${writeContent('x')}`);

      run('unpark parked/try-stop-hook.md --to=backlog');

      assert.ok(!fs.existsSync(path.join(TMP, 'parked', 'try-stop-hook.md')));
      const notes = fs.readFileSync(path.join(TMP, 'notes', `${day(0)}.md`), 'utf8');
      assert.ok(notes.includes('UNPARKED: Try Stop hook → backlog'));
      assert.throws(() => run('unpark notes/whatever.md --to=drop'));
    });

    it('signals count parked items per card and offer sorting old ones at most every two weeks', () => {
      fs.writeFileSync(path.join(TMP, 'workstreams.json'), JSON.stringify({ scaffold: ['scaffold'] }));
      writeFile('workstreams/scaffold.md', '---\nname: scaffold\ndescription: Scaffold\n---\nbody');
      writeFile('workstreams/scaffold/old.md', `---\nname: Old\ncategory: parked\nparked: ${day(40)}\n---\nbody`);

      let s = JSON.parse(run('signals'));
      assert.equal(s.cards[0].parked, 1);
      assert.deepEqual(s.parked, { total: 1, stale: 1, offer: true });

      run('signals --mark-reviewed');
      s = JSON.parse(run('signals'));
      assert.equal(s.parked.offer, false);
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

  describe('findings', () => {
    it('collects WATCH: entries from daily notes', () => {
      writeFile('notes/2026-04-09.md', '---\nname: Notes\ntype: project\n---\n\n- 14:22 WATCH:DECISION: Hybrid Opus+Sonnet for AP-42\n- 14:22 WATCH:PLAN: 4-phase execution\n- 14:22 WATCH:CORRECTION: Rejected Sonnet-generated test code\n');

      const result = run('findings');

      assert.ok(result.includes('Hybrid Opus+Sonnet'));
      assert.ok(result.includes('4-phase execution'));
      assert.ok(result.includes('Rejected Sonnet-generated'));
    });

    it('groups by lowercase type', () => {
      writeFile('notes/2026-04-09.md', '---\nname: Notes\ntype: project\n---\n\n- 10:00 WATCH:DECISION: one\n- 11:00 WATCH:DECISION: two\n- 12:00 WATCH:PLAN: three\n- 13:00 WATCH:PHASE implementation\n');

      const result = run('findings');

      assert.ok(result.includes('decision (2)'));
      assert.ok(result.includes('plan (1)'));
      assert.ok(result.includes('phase (1)'));
    });

    it('handles WATCH:PHASE without colon', () => {
      writeFile('notes/2026-04-09.md', '---\nname: Notes\ntype: project\n---\n\n- 10:00 WATCH:PHASE planning (was: null)\n');

      const result = run('findings');

      assert.ok(result.includes('planning'));
    });

    it('returns message when no WATCH: entries', () => {
      writeFile('notes/2026-04-09.md', '---\nname: Notes\ntype: project\n---\n\n- 10:00 DOC: unrelated\n');

      const result = run('findings');

      assert.ok(result.includes('No watcher findings'));
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

    it('keeps a sentence with a dash whole under general', () => {
      writeFile('notes/2026-04-09.md', '---\nname: Notes\ntype: project\n---\n\n- 10:00 DOC: Ad-hoc hook runs write to real memory — use a fake HOME\n');

      const result = run('docs');

      assert.ok(result.includes('general (1)'));
      assert.ok(result.includes('Ad-hoc hook runs write to real memory — use a fake HOME'));
    });

    it('lists only DOC: notes after the last DOCS_REVIEWED', () => {
      writeFile('notes/2026-04-08.md', '---\nname: Notes\ntype: project\n---\n\n- 10:00 DOC: testing — reviewed rule\n- 18:00 DOCS_REVIEWED\n- 18:05 DOC: testing — same-day new rule\n');
      writeFile('notes/2026-04-09.md', '---\nname: Notes\ntype: project\n---\n\n- 10:00 DOC: api — next-day new rule\n');

      const result = run('docs');

      assert.ok(!result.includes('reviewed rule'));
      assert.ok(result.includes('same-day new rule'));
      assert.ok(result.includes('next-day new rule'));
      assert.ok(result.includes('since the last review (2026-04-08 18:00)'));
    });

    it('--all ignores the review marker', () => {
      writeFile('notes/2026-04-08.md', '---\nname: Notes\ntype: project\n---\n\n- 10:00 DOC: testing — reviewed rule\n- 18:00 DOCS_REVIEWED\n');

      const result = run('docs --all');

      assert.ok(result.includes('reviewed rule'));
      assert.ok(!result.includes('since the last review'));
    });

    it('--mark-reviewed closes the current list', () => {
      const today = new Date().toISOString().slice(0, 10);
      writeFile(`notes/${today}.md`, '---\nname: Notes\ntype: project\n---\n\n- 00:00 DOC: testing — rule one\n');

      run('docs --mark-reviewed');
      const result = run('docs');

      assert.ok(result.includes('No DOC: notes since the last review'));
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

    it('warns when watcher parse errors dominate findings', () => {
      writeFile('MEMORY.md', '# Memory\n');
      writeFile('.watcher-state.json', JSON.stringify({
        parseErrors: 10,
        cliErrors: 0,
        findingsCount: 2,
        lastParseError: '2026-04-16T05:00:00.000Z',
      }));

      const result = run('health');
      assert.ok(result.includes('session-watcher'));
      assert.ok(result.includes('10 parse errors'));
      assert.ok(result.includes('83%'));
    });

    it('legacy state (lifetime parseErrors, no cliErrors) → no warning', () => {
      writeFile('MEMORY.md', '# Memory\n');
      writeFile('.watcher-state.json', JSON.stringify({ parseErrors: 258, findingsCount: 0 }));

      const result = run('health');
      assert.ok(!result.includes('session-watcher'));
    });

    it('no watcher warning when parseErrors below threshold', () => {
      writeFile('MEMORY.md', '# Memory\n');
      writeFile('.watcher-state.json', JSON.stringify({
        parseErrors: 3,
        findingsCount: 1,
      }));

      const result = run('health');
      assert.ok(!result.includes('session-watcher'));
    });

    it('no watcher warning when findings dominate errors', () => {
      writeFile('MEMORY.md', '# Memory\n');
      writeFile('.watcher-state.json', JSON.stringify({
        parseErrors: 6,
        findingsCount: 50,
      }));

      const result = run('health');
      assert.ok(!result.includes('session-watcher'));
    });
  });

  describe('memory dir without --dir', () => {
    const PLUGIN_NOTES = path.join(__dirname, '..', 'scripts', 'notes');

    it('symlink memory/memory.js → writes to the symlink dir, not the plugin', () => {
      writeFile('MEMORY.md', '# Memory\n');
      const link = path.join(TMP, 'memory.js');
      fs.symlinkSync(SCRIPT, link);
      const before = fs.existsSync(PLUGIN_NOTES) ? fs.readdirSync(PLUGIN_NOTES).length : 0;

      execSync(`node "${link}" note "via-symlink"`, { encoding: 'utf8', timeout: 5000 });

      const today = new Date().toISOString().slice(0, 10);
      const note = fs.readFileSync(path.join(TMP, 'notes', `${today}.md`), 'utf8');
      assert.ok(note.includes('via-symlink'));
      const after = fs.existsSync(PLUGIN_NOTES) ? fs.readdirSync(PLUGIN_NOTES).length : 0;
      assert.equal(after, before);
    });

    it('empty --dir= is rejected, nothing written to cwd', () => {
      const cwd = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mt-empty-dir-'));
      const r = require('child_process').spawnSync(process.execPath, [SCRIPT, '--dir=', 'note', 'x'], { cwd, encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.ok(!fs.existsSync(path.join(cwd, 'notes')));
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it('dir prints a path and exits 1 when memory does not exist; other commands refuse', () => {
      const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mt-home-'));
      const cwd = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mt-nomem-'));
      const env = testEnv({ HOME: home });
      const dir = require('child_process').spawnSync(process.execPath, [SCRIPT, 'dir'], { cwd, env, encoding: 'utf8' });
      assert.equal(dir.status, 1);
      assert.ok(dir.stdout.trim().endsWith(path.join('memory')));
      const note = require('child_process').spawnSync(process.execPath, [SCRIPT, 'note', 'x'], { cwd, env, encoding: 'utf8' });
      assert.equal(note.status, 1);
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it('note text with backticks and $() is stored literally', () => {
      const text = 'run `echo pwned` and $(echo pwned)';
      require('child_process').execFileSync(process.execPath, [SCRIPT, `--dir=${TMP}`, 'note', text]);
      const today = new Date().toISOString().slice(0, 10);
      const note = fs.readFileSync(path.join(TMP, 'notes', `${today}.md`), 'utf8');
      assert.ok(note.includes(text));
    });
  });
});
