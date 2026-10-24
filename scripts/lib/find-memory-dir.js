// Resolve the memory dir for the current project the way Claude Code does
// (memdir/paths.ts), so MT reads and writes the folder CC's auto-memory uses.
//
// Order:
//   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE — full path
//   2. autoMemoryDirectory from local, else user settings. Project settings are
//      skipped: CC honors them only in a trusted workspace, which a hook can't see.
//   3. <base>/projects/<key>/memory
//        base = CLAUDE_CODE_REMOTE_MEMORY_DIR or the config home
//        key  = CLAUDE_CODE_PROJECT_DIR_NAME (only with CLAUDE_CONFIG_DIR),
//               else sanitizePath(canonical git root, else cwd)
//
// Never walks above the git root: a project without memory of its own must not
// land in a parent folder's memory (~, ~/projects). Dirs keyed by MT <= 1.9.15
// (only '/' and '.' replaced) and long-path keys hashed differently are still found.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_SANITIZED_LENGTH = 200;

function configHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsRoot() {
  return path.join(process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR || configHome(), 'projects');
}

// CC's djb2Hash (utils/hash.ts), used for keys over 200 chars.
function djb2(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  return hash;
}

// CC's sanitizePath (utils/sessionStoragePortable.ts).
function sanitizePath(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2(name)).toString(36)}`;
}

// `.git` may be a dir or a file (worktree, submodule).
function findGitRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir.normalize('NFC');
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// CC keys every worktree by its main repo: <wt>/.git → gitdir → commondir.
// Anything unexpected keeps the worktree root, as CC's resolveCanonicalRoot does.
function canonicalRoot(gitRoot) {
  try {
    const content = fs.readFileSync(path.join(gitRoot, '.git'), 'utf8').trim();
    if (!content.startsWith('gitdir:')) return gitRoot;
    const worktreeGitDir = path.resolve(gitRoot, content.slice('gitdir:'.length).trim());
    const commonDir = path.resolve(worktreeGitDir,
      fs.readFileSync(path.join(worktreeGitDir, 'commondir'), 'utf8').trim());
    if (path.dirname(worktreeGitDir) !== path.join(commonDir, 'worktrees')) return gitRoot;
    const backlink = fs.realpathSync(fs.readFileSync(path.join(worktreeGitDir, 'gitdir'), 'utf8').trim());
    if (backlink !== path.join(fs.realpathSync(gitRoot), '.git')) return gitRoot;
    const root = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
    return root.normalize('NFC');
  } catch {
    return gitRoot;
  }
}

function projectRoot(cwd) {
  const gitRoot = findGitRoot(cwd);
  return gitRoot ? canonicalRoot(gitRoot) : path.resolve(cwd).normalize('NFC');
}

// CC's validateMemoryPath: absolute, not a drive or UNC root, `~/` only from settings.
function validateMemoryPath(raw, expandTilde) {
  if (typeof raw !== 'string' || !raw) return null;
  let candidate = raw;
  if (expandTilde && (candidate.startsWith('~/') || candidate.startsWith('~\\'))) {
    const rest = path.normalize(candidate.slice(2) || '.');
    if (rest === '.' || rest === '..') return null;
    candidate = path.join(os.homedir(), candidate.slice(2));
  }
  const normalized = path.normalize(candidate).replace(/[/\\]+$/, '');
  if (!path.isAbsolute(normalized) || normalized.length < 3 || /^[A-Za-z]:$/.test(normalized)
    || normalized.startsWith('\\\\') || normalized.startsWith('//') || normalized.includes('\0')) {
    return null;
  }
  return normalized.normalize('NFC');
}

function readAutoMemoryDirectory(settingsFile) {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).autoMemoryDirectory;
  } catch {
    return undefined;
  }
}

// First setting that is present wins, valid or not — CC's `local ?? user`.
function overrideDir(cwd) {
  const fromEnv = validateMemoryPath(process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE, false);
  if (fromEnv) return fromEnv;
  const raw = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(configHome(), 'settings.json'),
  ].map(readAutoMemoryDirectory).find(v => v != null);
  return validateMemoryPath(raw, true);
}

function projectKey(root) {
  const named = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  if (named && !/[/\\]/.test(named) && named !== '.' && named !== '..') return named;
  return sanitizePath(root);
}

function memoryDirFor(root) {
  return path.join(projectsRoot(), projectKey(root), 'memory');
}

// A memory dir for the same root under a key CC no longer computes: MT's legacy
// formula, or a long path whose hash suffix differs (older CC under Bun).
function existingVariant(root) {
  const projects = projectsRoot();
  const legacy = path.join(projects, root.replace(/[/.]/g, '-'), 'memory');
  if (fs.existsSync(legacy)) return legacy;
  const sanitized = root.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return null;
  const prefix = `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-`;
  try {
    const entry = fs.readdirSync(projects)
      .find(e => e.startsWith(prefix) && fs.existsSync(path.join(projects, e, 'memory')));
    return entry ? path.join(projects, entry, 'memory') : null;
  } catch {
    return null;
  }
}

// Returns { dir, exists }.
// `dir` is always set (where CC would put it). Caller checks `exists`.
function findMemoryDir(cwd = process.cwd()) {
  const override = overrideDir(cwd);
  if (override) return { dir: override, exists: fs.existsSync(override) };
  const root = projectRoot(cwd);
  const dir = memoryDirFor(root);
  if (fs.existsSync(dir)) return { dir, exists: true };
  const variant = existingVariant(root);
  if (variant) return { dir: variant, exists: true };
  return { dir, exists: false };
}

// For hook scripts: return the dir if it exists, else exit(0) silently.
// Hooks must not crash if memory isn't set up yet.
function findMemoryDirOrExit() {
  const { dir, exists } = findMemoryDir();
  if (!exists) process.exit(0);
  return dir;
}

module.exports = { findMemoryDir, findMemoryDirOrExit, memoryDirFor, sanitizePath };
