// find-memory-dir must resolve the same folder Claude Code's auto-memory uses.
// Every case runs against a throwaway HOME (see .claude/rules/testing.md).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { findMemoryDir, sanitizePath } = require('../scripts/lib/find-memory-dir');

const ENV_KEYS = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME',
  'CLAUDE_CODE_REMOTE_MEMORY_DIR', 'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
];

let root, home, savedEnv;

function projectsDir() {
  return path.join(home, '.claude', 'projects');
}

function memoryFor(key) {
  const dir = path.join(projectsDir(), key, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mkdir(...parts) {
  const dir = path.join(root, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function gitInit(dir) {
  execSync('git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-find-dir-')));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = home;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sanitizePath matches Claude Code', () => {
  it('replaces every non-alphanumeric character', () => {
    assert.equal(sanitizePath('/Users/i.gorskiy/my_app'), '-Users-i-gorskiy-my-app');
    assert.equal(sanitizePath('/Users/me/Obsidian Vault'), '-Users-me-Obsidian-Vault');
    assert.equal(sanitizePath('/Users/me/Проект'), '-Users-me-------');
  });

  it('truncates long keys to 200 chars plus a djb2 suffix', () => {
    // Expected value computed with CC 2.1.310's own sanitize/hash code
    const long = '/work/' + 'deeply_nested/'.repeat(16) + 'project';
    const key = sanitizePath(long);
    assert.equal(key.length, 200 + '-pih60a'.length);
    assert.ok(key.endsWith('neste-pih60a'), key);
  });
});

describe('findMemoryDir', () => {
  it('uses the git root from a subdirectory', () => {
    const repo = gitInit(mkdir('repo'));
    const sub = mkdir('repo', 'packages', 'web');
    const dir = memoryFor(sanitizePath(repo));
    assert.deepEqual(findMemoryDir(sub), { dir, exists: true });
  });

  it('does not climb into a parent folder memory outside git', () => {
    memoryFor(sanitizePath(root));
    const child = mkdir('notes vault');
    const result = findMemoryDir(child);
    assert.equal(result.exists, false);
    assert.equal(result.dir, path.join(projectsDir(), sanitizePath(child), 'memory'));
  });

  it('does not climb above a git repo that has no memory', () => {
    memoryFor(sanitizePath(root));
    const repo = gitInit(mkdir('repo'));
    assert.equal(findMemoryDir(repo).exists, false);
  });

  it('keys a worktree by its main repo', () => {
    const repo = gitInit(mkdir('repo'));
    const wt = path.join(root, 'wt');
    execSync(`git worktree add -q "${wt}"`, { cwd: repo });
    const dir = memoryFor(sanitizePath(repo));
    assert.deepEqual(findMemoryDir(fs.realpathSync(wt)), { dir, exists: true });
  });

  it('honors CLAUDE_CONFIG_DIR', () => {
    const config = mkdir('config');
    process.env.CLAUDE_CONFIG_DIR = config;
    const project = mkdir('project');
    const dir = path.join(config, 'projects', sanitizePath(project), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    assert.deepEqual(findMemoryDir(project), { dir, exists: true });
  });

  it('uses CLAUDE_CODE_PROJECT_DIR_NAME only together with CLAUDE_CONFIG_DIR', () => {
    const project = mkdir('project');
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'named';
    assert.ok(findMemoryDir(project).dir.includes(sanitizePath(project)));
    process.env.CLAUDE_CONFIG_DIR = mkdir('config');
    assert.equal(findMemoryDir(project).dir, path.join(root, 'config', 'projects', 'named', 'memory'));
  });

  it('prefers CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', () => {
    const override = mkdir('override');
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = override;
    assert.deepEqual(findMemoryDir(mkdir('project')), { dir: override, exists: true });
  });

  it('reads autoMemoryDirectory from user settings with ~/ expansion', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/mem' }));
    assert.equal(findMemoryDir(mkdir('project')).dir, path.join(home, 'mem'));
  });

  it('local settings win, and an invalid local value does not fall through to user', () => {
    const project = mkdir('project');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/user-mem' }));
    fs.mkdirSync(path.join(project, '.claude'));
    const local = path.join(project, '.claude', 'settings.local.json');

    fs.writeFileSync(local, JSON.stringify({ autoMemoryDirectory: '~/local-mem' }));
    assert.equal(findMemoryDir(project).dir, path.join(home, 'local-mem'));

    fs.writeFileSync(local, JSON.stringify({ autoMemoryDirectory: '~/' }));
    assert.equal(findMemoryDir(project).dir, path.join(projectsDir(), sanitizePath(project), 'memory'));
  });

  it('ignores autoMemoryDirectory in committed project settings', () => {
    const project = mkdir('project');
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '/tmp/evil' }));
    assert.equal(findMemoryDir(project).dir, path.join(projectsDir(), sanitizePath(project), 'memory'));
  });

  it('finds a memory dir keyed by the legacy MT formula', () => {
    const project = mkdir('my_project');
    const legacy = memoryFor(project.replace(/[/.]/g, '-'));
    assert.deepEqual(findMemoryDir(project), { dir: legacy, exists: true });
  });

  it('finds a long-path memory dir with a different hash suffix', () => {
    const project = mkdir(...Array(16).fill('deeply_nested'), 'project');
    const prefix = project.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
    const other = memoryFor(`${prefix}-otherhash`);
    assert.deepEqual(findMemoryDir(project), { dir: other, exists: true });
  });
});
