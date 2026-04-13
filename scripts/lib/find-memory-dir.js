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

// Glob fallback: scan all project dirs for an existing memory dir whose
// project key contains the cwd leaf name. Catches cases where CC changed
// its sanitization formula after the memory dir was created.
function globFallback(cwd) {
  if (!fs.existsSync(PROJECTS_ROOT)) return null;
  const leaf = path.basename(cwd).toLowerCase();
  if (!leaf) return null;
  try {
    const entries = fs.readdirSync(PROJECTS_ROOT);
    for (const entry of entries) {
      if (!entry.toLowerCase().includes(leaf)) continue;
      const candidate = path.join(PROJECTS_ROOT, entry, 'memory');
      if (fs.existsSync(path.join(candidate, 'MEMORY.md'))) {
        return candidate;
      }
    }
  } catch { /* ignore read errors */ }
  return null;
}

// Returns { dir, exists }.
// `dir` is always set (may be the fallback). Caller checks `exists`.
//
// Resolution order:
//   1. Ancestor walk — compute sanitized key for cwd and ancestors, check exists
//   2. Glob fallback — scan project dirs for leaf-name match (resilient to sanitization drift)
//   3. Formula fallback — compute path from cwd (for fresh setup)
function findMemoryDir(cwd = process.cwd()) {
  // 1. Ancestor walk
  const parts = cwd.split('/').filter(Boolean);
  for (let i = parts.length; i >= 1; i--) {
    const ancestor = '/' + parts.slice(0, i).join('/');
    const dir = memoryDirFor(ancestor);
    if (fs.existsSync(dir)) {
      return { dir, exists: true };
    }
  }
  // 2. Glob fallback
  const globDir = globFallback(cwd);
  if (globDir) return { dir: globDir, exists: true };
  // 3. Formula fallback
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
