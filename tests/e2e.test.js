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

    it('outputs valid JSON with systemMessage and additionalContext', () => {
      const out = sessionLogRun({ session_id: 'e2e-002' });
      const json = JSON.parse(out.trim());
      assert.ok(json.systemMessage, 'should have systemMessage');
      assert.ok(json.systemMessage.includes('memory-toolkit'), 'systemMessage should mention plugin');
      assert.ok(json.hookSpecificOutput, 'should have hookSpecificOutput');
      assert.equal(json.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.ok(json.hookSpecificOutput.additionalContext.includes('DOC:'), 'context should include DOC reminder');
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

  // --- session-watcher.js plumbing ---

  describe('session-watcher.js plumbing (no LLM)', () => {
    it('finds transcript from sessions.jsonl and parses messages', () => {
      // Ensure sessions.jsonl has an entry with transcript path
      const sessionsPath = path.join(memoryDir, 'sessions.jsonl');
      const transcriptPath = path.join(sandbox, 'transcript.jsonl');

      // Write a fake transcript with enough messages
      const messages = [];
      for (let i = 0; i < 8; i++) {
        messages.push(JSON.stringify({
          type: i % 2 === 0 ? 'user' : 'assistant',
          message: { content: [{ type: 'text', text: `Message ${i}` }] },
        }));
      }
      fs.writeFileSync(transcriptPath, messages.join('\n') + '\n');

      // Write sessions.jsonl entry pointing to transcript
      fs.writeFileSync(sessionsPath,
        JSON.stringify({ id: 'watcher-test', transcript: transcriptPath }) + '\n'
      );

      // Reset watcher state so it doesn't throttle
      const statePath = path.join(memoryDir, '.watcher-state.json');
      fs.writeFileSync(statePath, JSON.stringify({ offset: 0, lastRun: 0, transcriptPath: '' }));

      // Run watcher — will fail at LLM call (no API key, no claude CLI in sandbox)
      // but should NOT crash before reaching the LLM call
      try {
        execSync(
          `node "${path.join(PLUGIN_ROOT, 'scripts', 'session-watcher.js')}"`,
          {
            encoding: 'utf8',
            timeout: 10000,
            cwd: projectDir,
            env: { ...process.env, HOME: fakeHome, ANTHROPIC_API_KEY: '' },
          }
        );
      } catch {
        // Expected: LLM call fails, but plumbing worked
      }

      // Verify: watcher state was updated (means it got past transcript parsing)
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.ok(state.lastRun > 0, 'lastRun should be updated');
      assert.equal(state.transcriptPath, transcriptPath, 'should track current transcript');
      assert.ok(state.offset >= 8, 'offset should advance past messages');
    });

    it('respects throttle — skips if ran recently', () => {
      const statePath = path.join(memoryDir, '.watcher-state.json');
      fs.writeFileSync(statePath, JSON.stringify({
        offset: 0,
        lastRun: Date.now(), // just now
        transcriptPath: '',
      }));

      // Should exit silently (throttled)
      const result = execSync(
        `node "${path.join(PLUGIN_ROOT, 'scripts', 'session-watcher.js')}"`,
        {
          encoding: 'utf8',
          timeout: 5000,
          cwd: projectDir,
          env: { ...process.env, HOME: fakeHome },
        }
      );
      // Throttled — should output empty JSON
      const json = JSON.parse(result.trim());
      assert.deepEqual(json, {});
    });

    it('prompt includes documentation type', () => {
      const watcherSource = fs.readFileSync(
        path.join(PLUGIN_ROOT, 'scripts', 'session-watcher.js'), 'utf8'
      );
      assert.ok(
        watcherSource.includes('documentation'),
        'ANALYSIS_PROMPT should include documentation type'
      );
    });

    it('documentation findings use DOC: prefix', () => {
      const watcherSource = fs.readFileSync(
        path.join(PLUGIN_ROOT, 'scripts', 'session-watcher.js'), 'utf8'
      );
      assert.ok(
        watcherSource.includes("'DOC'") || watcherSource.includes('"DOC"'),
        'saveFindings should use DOC: prefix for documentation type'
      );
    });
  });

  // --- Path sanitization ---

  describe('PROJ_KEY sanitization matches CC', () => {
    it('SKILL.md tr command matches find-memory-dir sanitize()', () => {
      const { memoryDirFor } = require('../scripts/lib/find-memory-dir');
      // Test with paths containing dots (e.g., username "i.gorskiy")
      const testPaths = [
        '/Users/i.gorskiy/Desktop/projects/my-app',
        '/home/user.name/code/project',
        '/tmp/test.dir/sub.dir/project',
      ];
      for (const testPath of testPaths) {
        const jsKey = memoryDirFor(testPath);
        // Simulate what SKILL.md bash does: tr '/.' '-' | sed 's/^-//'
        const bashKey = testPath.replace(/[/.]/g, '-').replace(/^-/, '');
        const bashDir = path.join(
          process.env.HOME, '.claude', 'projects', `-${bashKey}`, 'memory'
        );
        assert.equal(jsKey, bashDir,
          `sanitization mismatch for ${testPath}: JS=${jsKey} vs bash=${bashDir}`
        );
      }
    });
  });

  // --- Configurable targets (no hardcoded destinations) ---

  describe('skills ask before writing to project files', () => {
    it('reflect does not hardcode backlog.md as only option', () => {
      const content = fs.readFileSync(
        path.join(PLUGIN_ROOT, 'skills', 'reflect', 'SKILL.md'), 'utf8'
      );
      // Should mention detection/asking, not just "Read: backlog.md"
      assert.ok(
        content.includes('backlog_target') || content.includes('Where do you track'),
        'reflect should detect or ask for backlog location'
      );
    });

    it('docs-reflect does not hardcode .claude/rules/ as only option', () => {
      const content = fs.readFileSync(
        path.join(PLUGIN_ROOT, 'skills', 'docs-reflect', 'SKILL.md'), 'utf8'
      );
      assert.ok(
        content.includes('docs_target') || content.includes('Where should'),
        'docs-reflect should detect or ask for rules location'
      );
    });
  });

  // --- find-memory-dir resilience ---

  describe('find-memory-dir glob fallback', () => {
    it('finds memory dir when sanitization drifts', () => {
      // Simulate: CC used a different sanitization formula, so the ancestor walk
      // won't find it. But the dir exists and contains MEMORY.md with the
      // project leaf name in the dir name.
      const altKey = 'WEIRD-SANITIZATION-' + path.basename(projectDir);
      const altDir = path.join(fakeHome, '.claude', 'projects', altKey, 'memory');
      fs.mkdirSync(altDir, { recursive: true });
      fs.writeFileSync(path.join(altDir, 'MEMORY.md'), '# Test');

      // Use a cwd that won't match ancestor walk (since altKey uses wrong formula)
      // but whose basename matches the altKey
      const { findMemoryDir } = require('../scripts/lib/find-memory-dir');
      // Temporarily point to fakeHome by patching PROJECTS_ROOT
      // Instead, we test the exported globFallback indirectly:
      // The ancestor walk will find the real dir first (since projectDir exists),
      // so we test with a subdirectory that has no matching ancestor dir
      const subDir = path.join(sandbox, 'orphan', path.basename(projectDir));
      fs.mkdirSync(subDir, { recursive: true });

      // For the orphan dir, ancestor walk will fail (no memory dir exists for
      // /tmp/mt-e2e-.../orphan/project via formula). Glob fallback should find
      // the altKey dir because it contains the leaf name "project".
      const result = findMemoryDir(subDir);
      // Should find either the formula-based dir or the alt dir via glob
      assert.ok(result.exists, 'glob fallback should find an existing memory dir');
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

  // --- Structured logger ---

  describe('lib/log.js', () => {
    it('outputs JSON with version to stderr at info level', () => {
      const r = execSync(
        `node -e "require('${path.join(PLUGIN_ROOT, 'scripts', 'lib', 'log')}').info('e2e-log-test')" 2>&1`,
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
      const entry = JSON.parse(r);
      assert.ok(entry.ts, 'should have timestamp');
      assert.ok(entry.v, 'should have version');
      assert.equal(entry.level, 'info');
      assert.equal(entry.msg, 'e2e-log-test');
    });

    it('respects MT_LOG=silent', () => {
      const r = execSync(
        `MT_LOG=silent node -e "require('${path.join(PLUGIN_ROOT, 'scripts', 'lib', 'log')}').error('should-not-appear')" 2>&1`,
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
      assert.equal(r, '', 'silent should suppress all output');
    });

    it('shows debug when MT_LOG=debug', () => {
      const r = execSync(
        `MT_LOG=debug node -e "require('${path.join(PLUGIN_ROOT, 'scripts', 'lib', 'log')}').debug('dbg-test')" 2>&1`,
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
      const entry = JSON.parse(r);
      assert.equal(entry.level, 'debug');
      assert.equal(entry.msg, 'dbg-test');
    });
  });

  // --- commandsMetadata: allowedTools ---

  describe('all skills have allowedTools in commandsMetadata', () => {
    it('every skill directory has a matching commandsMetadata entry', () => {
      const pluginJson = JSON.parse(
        fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
      );
      const metadata = pluginJson.commandsMetadata || {};
      const skillsDir = path.join(PLUGIN_ROOT, 'skills');
      const skillNames = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
        .map(d => d.name);

      for (const name of skillNames) {
        assert.ok(
          metadata[name],
          `skill "${name}" missing from commandsMetadata`
        );
        assert.ok(
          Array.isArray(metadata[name].allowedTools) && metadata[name].allowedTools.length > 0,
          `skill "${name}" has no allowedTools`
        );
        assert.ok(
          metadata[name].allowedTools.includes('Bash'),
          `skill "${name}" should have Bash in allowedTools`
        );
      }
    });
  });
});
