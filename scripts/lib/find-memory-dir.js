// Resolve the memory dir for the current project.
//
// Strategy:
//   1. Search-first: walk cwd up to root; for each ancestor, compute the
//      sanitized project key and check if `~/.claude/projects/<key>/memory`
//      exists. Returns the deepest existing match.
//   2. Fallback: if nothing exists, return the formula path at cwd. Caller
//      decides whether that's acceptable (fresh setup) or a no-op (hooks).
//
// Why search-first: protects against drift if Claude Code changes its
// path-sanitization rules. If a memory dir already exists for an ancestor,
// we use it instead of recomputing a (possibly diverging) name from scratch.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// Sanitize a path the way Claude Code does for project dir names.
// Reverse-engineered: collapse '/' and '.' to '-', strip leading '-'.
function sanitize(absPath) {
  return absPath.replace(/[/.]/g, '-').replace(/^-/, '');
}

function memoryDirFor(absPath) {
  return path.join(PROJECTS_ROOT, `-${sanitize(absPath)}`, 'memory');
}

// Returns { dir, exists }.
// `dir` is always set (may be the fallback). Caller checks `exists`.
function findMemoryDir(cwd = process.cwd()) {
  const parts = cwd.split('/').filter(Boolean);
  for (let i = parts.length; i >= 1; i--) {
    const ancestor = '/' + parts.slice(0, i).join('/');
    const dir = memoryDirFor(ancestor);
    if (fs.existsSync(dir)) {
      return { dir, exists: true };
    }
  }
  return { dir: memoryDirFor(cwd), exists: false };
}

// For hook scripts: return the dir if it exists, else exit(0) silently.
// Hooks must not crash if memory isn't set up yet.
function findMemoryDirOrExit() {
  const { dir, exists } = findMemoryDir();
  if (!exists) process.exit(0);
  return dir;
}

module.exports = { findMemoryDir, findMemoryDirOrExit, memoryDirFor };
