// Hook safety test helpers for AP-42.
// spawnSync-based so exit codes are captured without throwing.
// HOME isolation is mandatory — see .claude/rules/testing.md.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');
const assert = require('node:assert/strict');

const PLUGIN_ROOT = path.resolve(__dirname, '../..');

function createSandbox({ withPriorSession = false } = {}) {
  const sandboxRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-safety-')));
  const home = path.join(sandboxRoot, 'home');
  const projectDir = path.join(sandboxRoot, 'project');

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  execSync('git init && git commit --allow-empty -m "init"', {
    cwd: projectDir, encoding: 'utf8', stdio: 'pipe',
  });

  const projectKey = projectDir.replace(/[/.]/g, '-').replace(/^-/, '');
  const memoryDir = path.join(home, '.claude', 'projects', `-${projectKey}`, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory\n');

  if (withPriorSession) {
    const transcriptPath = path.join(sandboxRoot, 'transcript.jsonl');
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({
        type: i % 2 === 0 ? 'user' : 'assistant',
        message: { content: [{ type: 'text', text: `Message ${i}` }] },
      }));
    }
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    fs.writeFileSync(path.join(memoryDir, 'sessions.jsonl'), JSON.stringify({
      id: 'prior-session-001',
      date: new Date().toISOString(),
      branch: 'main',
      transcript: transcriptPath,
    }) + '\n');

    fs.writeFileSync(path.join(memoryDir, '.watcher-state.json'), JSON.stringify({
      offset: 0, lastRun: 0, transcriptPath: '',
      findingsCount: 0, docCount: 0,
      suggestedReflect: false, suggestedDocs: false,
      parseErrors: 0, lastParseError: null,
    }));
  }

  function cleanup() {
    try { fs.rmSync(sandboxRoot, { recursive: true, force: true }); } catch {}
  }

  return { home, memoryDir, projectDir, sandboxRoot, cleanup };
}

// Run fn inside a throwaway sandbox; cleanup is guaranteed even on throw.
function withSandbox(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const ctx = createSandbox(opts);
  try { return fn(ctx); } finally { ctx.cleanup(); }
}

function runHook(scriptName, stdin, { env = {}, timeout = 10000, cwd } = {}) {
  const baseEnv = {
    HOME: env.HOME || process.env.HOME,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    ANTHROPIC_API_KEY: '',
    PATH: process.env.PATH,
    MT_LOG: 'silent',
  };

  if ('CLAUDE_PLUGIN_ROOT' in env && env.CLAUDE_PLUGIN_ROOT == null) {
    delete baseEnv.CLAUDE_PLUGIN_ROOT;
  }

  const mergedEnv = { ...baseEnv, ...env };
  for (const k of Object.keys(mergedEnv)) {
    if (mergedEnv[k] === undefined) delete mergedEnv[k];
  }

  const start = Date.now();
  const result = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', scriptName)], {
    input: stdin ?? undefined,
    encoding: 'utf8',
    timeout,
    cwd: cwd || process.cwd(),
    env: mergedEnv,
    maxBuffer: 2 * 1024 * 1024,
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status != null ? result.status : -1,
    durationMs: Date.now() - start,
    signal: result.signal || null,
  };
}

// Empty stdout is valid (silent hook). Non-empty must be one JSON object
// matching the plugin's extended contract (hookSpecificOutput allowed).
function assertValidHookStdout(stdout, { hookEventName } = {}) {
  const trimmed = stdout.trimEnd();
  if (trimmed === '') return;

  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch (e) {
    assert.fail(`stdout not valid JSON: ${JSON.stringify(stdout.slice(0, 200))} — ${e.message}`);
  }

  assert.equal(typeof parsed, 'object');
  assert.ok(parsed && !Array.isArray(parsed), 'stdout must be a JSON object');

  if (hookEventName && parsed.hookSpecificOutput) {
    assert.equal(parsed.hookSpecificOutput.hookEventName, hookEventName);
  }
}

// Rough char/4 token estimate (AP-42 axis 8).
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Recursive file tree snapshot; returns Map<path, {size, mtimeMs, isDir}>.
// Skips .git to ignore churn from `git init` in sandbox setup.
function snapshotFS(root) {
  const out = new Map();
  if (!fs.existsSync(root)) return out;

  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      out.set(full, { size: st.size, mtimeMs: st.mtimeMs, isDir: ent.isDirectory() });
      if (ent.isDirectory()) walk(full);
    }
  })(root);
  return out;
}

function diffFS(before, after) {
  const added = [], modified = [], removed = [];
  for (const [p, aft] of after) {
    const bef = before.get(p);
    if (!bef) { added.push(p); continue; }
    if (aft.isDir) continue;
    if (bef.size !== aft.size || bef.mtimeMs !== aft.mtimeMs) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) removed.push(p);
  return { added, modified, removed };
}

module.exports = {
  createSandbox, withSandbox, runHook,
  assertValidHookStdout, estimateTokens,
  snapshotFS, diffFS, PLUGIN_ROOT,
};
