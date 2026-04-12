/**
 * E2E smoke tests — run all scripts against an isolated sandbox.
 *
 * Zero API calls, zero credentials. Creates a throwaway HOME with
 * a toy git project and verifies scripts work end-to-end.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync} = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');

// Sandbox: throwaway HOME + toy project
let sandbox, fakeHome, projectDir, memoryDir;

function memRun(args, opts = {}) {
  return execSync(`node "${path.join(PLUGIN_ROOT, 'scripts', 'memory.js')}" --dir="${memoryDir}" ${args}`, {
    encoding: 'utf8',
    timeout: 5000,
    cwd: projectDir,
    ...opts,
  }).trim();
}

function sessionLogRun(stdinJson) {
  return execSync(
    `echo '${JSON.stringify(stdinJson)}' | node "${path.join(PLUGIN_ROOT, 'scripts', 'session-log.js')}"`,
    {
      encoding: 'utf8',
      timeout: 5000,
      cwd: projectDir,
      env: { ...process.env, HOME: fakeHome },
    }
  );
}

describe('e2e: isolated sandbox', () => {
  before(() => {
    // 1. Throwaway HOME
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'mt-e2e-')));
    fakeHome = path.join(sandbox, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });

    // 2. Toy project with git
    projectDir = path.join(sandbox, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    execSync('git init && git commit --allow-empty -m "init"', {
      cwd: projectDir,
      encoding: 'utf8',
    });

    // 3. Memory dir (as CC would create it)
    const projectKey = projectDir.replace(/[/.]/g, '-').replace(/^-/, '');
    memoryDir = path.join(fakeHome, '.claude', 'projects', `-${projectKey}`, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // --- memory.js ---

  describe('memory.js in clean sandbox', () => {
    it('list returns empty without crash', () => {
      const out = memRun('list');
      assert.ok(typeof out === 'string');
    });

    it('workstreams returns without crash', () => {
      const out = memRun('workstreams');
      assert.ok(typeof out === 'string');
    });

    it('note creates a note file', () => {
      memRun('note "E2E test note"');
      const today = new Date().toISOString().slice(0, 10);
      const notePath = path.join(memoryDir, 'notes', `${today}.md`);
      assert.ok(fs.existsSync(notePath), 'daily note should exist');
      const content = fs.readFileSync(notePath, 'utf8');
      assert.ok(content.includes('E2E test note'));
    });

    it('search finds the note', () => {
      const out = memRun('search "E2E test"');
      assert.ok(out.includes('E2E test note'));
    });

    it('add-workstream + workstreams round-trip', () => {
      memRun('add-workstream test-ws e2e,smoke,sandbox');
      const out = memRun('workstreams');
      assert.ok(out.includes('test-ws'), 'new workstream should appear');
    });

    it('reindex does not crash on fresh dir', () => {
      memRun('reindex');
      const memoryMd = path.join(memoryDir, 'MEMORY.md');
      // reindex may or may not create MEMORY.md depending on content
      // but it must not crash
    });
  });

  // --- session-log.js ---

  describe('session-log.js in clean sandbox', () => {
    it('creates daily note and sessions.jsonl', () => {
      sessionLogRun({ session_id: 'e2e-001', transcript_path: '/tmp/e2e.jsonl' });

      const today = new Date().toISOString().slice(0, 10);
      const notePath = path.join(memoryDir, 'notes', `${today}.md`);
      assert.ok(fs.existsSync(notePath), 'daily note should exist');
      const noteContent = fs.readFileSync(notePath, 'utf8');
      assert.ok(noteContent.includes('SESSION_START'));
      assert.ok(noteContent.includes('e2e-001'));

      const sessionsPath = path.join(memoryDir, 'sessions.jsonl');
      assert.ok(fs.existsSync(sessionsPath), 'sessions.jsonl should exist');
      const record = JSON.parse(fs.readFileSync(sessionsPath, 'utf8').trim().split('\n').pop());
      assert.equal(record.id, 'e2e-001');
    });

    it('outputs DOC reminder', () => {
      const out = sessionLogRun({ session_id: 'e2e-002' });
      assert.ok(out.includes('DOC:'));
    });

    it('updates stale MEMORY.md API block (AP-20)', () => {
      // Write MEMORY.md with an old version path
      const memoryMdPath = path.join(memoryDir, 'MEMORY.md');
      fs.writeFileSync(memoryMdPath, [
        '# Test Memory',
        '## API',
        '```bash',
        'node /old/path/memory-toolkit/0.0.1/scripts/memory.js --dir=/some/dir <command>',
        '```',
      ].join('\n'));

      sessionLogRun({ session_id: 'e2e-ap20' });

      const updated = fs.readFileSync(memoryMdPath, 'utf8');
      // Should contain current script path, not old one
      assert.ok(
        !updated.includes('0.0.1'),
        'old version should be replaced'
      );
      assert.ok(
        updated.includes(path.join(PLUGIN_ROOT, 'scripts', 'memory.js')),
        'should contain current memory.js path'
      );
    });
  });

  // --- Path integrity ---

  describe('no hardcoded paths in skills', () => {
    const skillsDir = path.join(PLUGIN_ROOT, 'skills');

    it('SKILL.md files do not contain hardcoded home paths', () => {
      const skills = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(skillsDir, d.name, 'SKILL.md'))
        .filter(f => fs.existsSync(f));

      assert.ok(skills.length > 0, 'should find at least one SKILL.md');

      for (const skillPath of skills) {
        const content = fs.readFileSync(skillPath, 'utf8');
        // Should not contain /Users/ or /home/ hardcoded paths
        const hardcoded = content.match(/(?:\/Users\/\w+|\/home\/\w+)(?!.*\{)/g);
        assert.equal(
          hardcoded,
          null,
          `${path.basename(path.dirname(skillPath))}/SKILL.md has hardcoded path: ${hardcoded}`
        );
      }
    });

    it('SKILL.md files use CLAUDE_PLUGIN_ROOT for script paths', () => {
      const sessionStart = fs.readFileSync(
        path.join(skillsDir, 'session-start', 'SKILL.md'), 'utf8'
      );
      // If it references memory.js, it should use CLAUDE_PLUGIN_ROOT or relative path
      if (sessionStart.includes('memory.js')) {
        const lines = sessionStart.split('\n').filter(l =>
          l.includes('memory.js') && !l.startsWith('#') && !l.startsWith('//')
        );
        for (const line of lines) {
          // Should either use CLAUDE_PLUGIN_ROOT or --dir, not a fixed absolute path to plugins cache
          const hasPluginRoot = line.includes('CLAUDE_PLUGIN_ROOT');
          const isMEMvar = line.includes('$MEM');
          const isComment = line.trim().startsWith('#') || line.trim().startsWith('//');
          assert.ok(
            hasPluginRoot || isMEMvar || isComment,
            `session-start SKILL.md references memory.js without CLAUDE_PLUGIN_ROOT or $MEM: ${line.trim()}`
          );
        }
      }
    });
  });

  // --- Version consistency ---

  describe('version consistency', () => {
    it('plugin.json has a valid semver', () => {
      const pluginJson = JSON.parse(
        fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
      );
      assert.ok(
        /^\d+\.\d+\.\d+$/.test(pluginJson.version),
        `version should be semver: ${pluginJson.version}`
      );
    });
  });
});
