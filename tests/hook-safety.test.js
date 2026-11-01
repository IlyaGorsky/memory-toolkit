// AP-42 hook safety E2E. 9 axes × 4 hooks. Each test runs in an isolated
// sandbox (throwaway HOME, toy git project). See decisions/ap-42-hook-safety-e2e.md.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { testEnv } = require('./helpers/env');
const { sanitizePath } = require('../scripts/lib/find-memory-dir');

const {
  withSandbox, runHook, assertValidHookStdout, estimateTokens,
  snapshotFS, diffFS,
} = require('./helpers/hook-sandbox');

const CTX_TOKEN_LIMIT = 2000;

const payload = (extra = {}) => JSON.stringify({ session_id: 'test-session-001', ...extra });

function writeTranscript(dir, name, count = 10) {
  const p = path.join(dir, `${name}.jsonl`);
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      message: { content: [{ type: 'text', text: `msg ${i}` }] },
    }));
  }
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('session-log.js', () => {
  describe('axis-1: happy path', () => {
    it('cold start emits SessionStart JSON and writes daily note', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        const r = runHook('session-log.js', payload({ transcript_path: '/tmp/t.jsonl' }),
          { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
        assertValidHookStdout(r.stdout, { hookEventName: 'SessionStart' });
        const today = new Date().toISOString().slice(0, 10);
        assert.ok(fs.existsSync(path.join(memoryDir, 'notes', `${today}.md`)));
      });
    });

    it('appends session record to sessions.jsonl', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        const r = runHook('session-log.js', payload({ session_id: 'cold-001' }),
          { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
        const rec = JSON.parse(fs.readFileSync(path.join(memoryDir, 'sessions.jsonl'), 'utf8').trim());
        assert.equal(rec.id, 'cold-001');
      });
    });

    it('deduplicates repeat session_id (continue)', () => {
      withSandbox({ withPriorSession: true }, ({ home, memoryDir, projectDir }) => {
        runHook('session-log.js', payload({ session_id: 'prior-session-001' }),
          { env: { HOME: home }, cwd: projectDir });
        const lines = fs.readFileSync(path.join(memoryDir, 'sessions.jsonl'), 'utf8')
          .trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 1);
      });
    });
  });

  describe('axis-2: broken state', () => {
    it('no memory dir → silent exit 0 (findMemoryDirOrExit by design)', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        fs.rmSync(memoryDir, { recursive: true, force: true });
        const r = runHook('session-log.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0);
        assert.equal(r.stdout.trim(), '');
      });
    });

    it('MEMORY.md missing → exit 0, note still written', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        fs.unlinkSync(path.join(memoryDir, 'MEMORY.md'));
        const r = runHook('session-log.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
        assertValidHookStdout(r.stdout, { hookEventName: 'SessionStart' });
      });
    });

    it('no CLAUDE_PLUGIN_ROOT → exit 0 (plugin.json read swallowed)', () => {
      withSandbox(({ home, projectDir }) => {
        const r = runHook('session-log.js', payload(),
          { env: { HOME: home, CLAUDE_PLUGIN_ROOT: null }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
      });
    });

    it('missing transcript_path → exit 0, transcript field empty', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        const r = runHook('session-log.js', JSON.stringify({ session_id: 'no-t' }),
          { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
        const rec = JSON.parse(fs.readFileSync(path.join(memoryDir, 'sessions.jsonl'), 'utf8').trim());
        assert.equal(rec.transcript, '');
      });
    });
  });

  describe('axis-3: malformed input', () => {
    const cases = [
      ['non-JSON string', 'not json at all !!!'],
      ['empty stdin', ''],
      ['truncated JSON', '{"session_id": "trunc'],
      ['missing session_id', JSON.stringify({ hook_event_name: 'SessionStart' })],
    ];
    for (const [name, stdin] of cases) {
      it(`${name} → exit 0`, () => {
        withSandbox(({ home, projectDir }) => {
          const r = runHook('session-log.js', stdin, { env: { HOME: home }, cwd: projectDir });
          assert.equal(r.exitCode, 0, r.stderr);
        });
      });
    }
  });

  describe('axis-5: stdout contract', () => {
    it('happy-path stdout is a clean single JSON object', () => {
      withSandbox(({ home, projectDir }) => {
        const r = runHook('session-log.js', payload(), { env: { HOME: home }, cwd: projectDir });
        const t = r.stdout.trim();
        assert.equal(t[0], '{');
        assert.equal(t[t.length - 1], '}');
        assertValidHookStdout(r.stdout, { hookEventName: 'SessionStart' });
      });
    });
  });

  describe('axis-6: timeout budget', () => {
    it('cold start < 500ms', () => {
      withSandbox(({ home, projectDir }) => {
        const r = runHook('session-log.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.ok(r.durationMs < 500, `took ${r.durationMs}ms`);
      });
    });

    it('with handoff injection < 500ms', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        const wsDir = path.join(memoryDir, 'workstreams');
        fs.mkdirSync(wsDir, { recursive: true });
        fs.writeFileSync(path.join(wsDir, 'handoff.md'), '# Handoff\ncontent\n');
        const r = runHook('session-log.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.ok(r.durationMs < 500, `took ${r.durationMs}ms`);
      });
    });
  });

  describe('axis-8: additionalContext budget', () => {
    it('cold start ctx ≤ 2000 tokens', () => {
      withSandbox(({ home, projectDir }) => {
        const r = runHook('session-log.js', payload(), { env: { HOME: home }, cwd: projectDir });
        const ctx = JSON.parse(r.stdout.trim()).hookSpecificOutput?.additionalContext || '';
        assert.ok(estimateTokens(ctx) <= CTX_TOKEN_LIMIT, `${estimateTokens(ctx)} > ${CTX_TOKEN_LIMIT}`);
      });
    });

    it('10 cold starts do not accumulate context', () => {
      withSandbox(({ home, projectDir }) => {
        for (let i = 0; i < 10; i++) {
          const r = runHook('session-log.js', payload({ session_id: `grow-${i}` }),
            { env: { HOME: home }, cwd: projectDir });
          const ctx = JSON.parse(r.stdout.trim()).hookSpecificOutput?.additionalContext || '';
          assert.ok(estimateTokens(ctx) <= CTX_TOKEN_LIMIT,
            `run ${i}: ${estimateTokens(ctx)} > ${CTX_TOKEN_LIMIT}`);
        }
      });
    });
  });
});

describe('session-save.js', () => {
  describe('axis-1: happy path', () => {
    it('writes precompact.md', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        const r = runHook('session-save.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
        assert.ok(fs.existsSync(path.join(memoryDir, 'workstreams', 'precompact.md')));
      });
    });

    it('keeps prior handoff, overwrites prior snapshot', () => {
      withSandbox({ withPriorSession: true }, ({ home, memoryDir, projectDir }) => {
        const wsDir = path.join(memoryDir, 'workstreams');
        fs.mkdirSync(wsDir, { recursive: true });
        fs.writeFileSync(path.join(wsDir, 'handoff.md'), '# Old handoff\n');
        fs.writeFileSync(path.join(wsDir, 'precompact.md'), '# Old snapshot\n');
        runHook('session-save.js', payload({ session_id: 'save-new' }),
          { env: { HOME: home }, cwd: projectDir });
        assert.equal(fs.readFileSync(path.join(wsDir, 'handoff.md'), 'utf8'), '# Old handoff\n');
        const snapshot = fs.readFileSync(path.join(wsDir, 'precompact.md'), 'utf8');
        assert.ok(snapshot.includes('save-new'));
        assert.ok(!snapshot.includes('Old snapshot'));
      });
    });

    it('repeat call with same session_id → exit 0', () => {
      withSandbox(({ home, projectDir }) => {
        runHook('session-save.js', payload({ session_id: 'cont' }),
          { env: { HOME: home }, cwd: projectDir });
        const r = runHook('session-save.js', payload({ session_id: 'cont' }),
          { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
      });
    });
  });

  describe('axis-2: broken state', () => {
    it('no memory dir → silent exit 0', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        fs.rmSync(memoryDir, { recursive: true, force: true });
        const r = runHook('session-save.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0);
        assert.equal(r.stdout.trim(), '');
      });
    });

    it('no CLAUDE_PLUGIN_ROOT → exit 0 (not used by session-save)', () => {
      withSandbox(({ home, projectDir }) => {
        const r = runHook('session-save.js', payload(),
          { env: { HOME: home, CLAUDE_PLUGIN_ROOT: null }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
      });
    });

    // AP-43: surfaced by AP-42, writes are now guarded one by one.
    it('workstreams/ read-only → graceful exit 0, note still written', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        const wsDir = path.join(memoryDir, 'workstreams');
        fs.mkdirSync(wsDir, { recursive: true });
        fs.chmodSync(wsDir, 0o500);
        try {
          const r = runHook('session-save.js', payload(), { env: { HOME: home }, cwd: projectDir });
          assert.equal(r.exitCode, 0, r.stderr);
          assert.ok(!fs.existsSync(path.join(wsDir, 'precompact.md')));
          const today = new Date().toISOString().slice(0, 10);
          assert.ok(fs.readFileSync(path.join(memoryDir, 'notes', `${today}.md`), 'utf8').includes('PRE_COMPACT'));
        } finally { fs.chmodSync(wsDir, 0o755); }
      });
    });
  });

  describe('axis-3: malformed input', () => {
    const cases = [
      ['non-JSON string', 'not valid json', (memoryDir) => {
        const c = fs.readFileSync(path.join(memoryDir, 'workstreams', 'precompact.md'), 'utf8');
        assert.ok(c.includes('unknown'));
      }],
      ['empty stdin', ''],
      ['truncated JSON', '{"session_id": "trunc'],
      ['missing session_id', JSON.stringify({ foo: 'bar' }), (memoryDir) => {
        const c = fs.readFileSync(path.join(memoryDir, 'workstreams', 'precompact.md'), 'utf8');
        assert.ok(c.includes('unknown'));
      }],
    ];
    for (const [name, stdin, extra] of cases) {
      it(`${name} → exit 0`, () => {
        withSandbox(({ home, memoryDir, projectDir }) => {
          const r = runHook('session-save.js', stdin, { env: { HOME: home }, cwd: projectDir });
          assert.equal(r.exitCode, 0, r.stderr);
          if (extra) extra(memoryDir);
        });
      });
    }
  });

  describe('axis-5: stdout contract', () => {
    it('PreCompact hook is silent', () => {
      withSandbox(({ home, projectDir }) => {
        const r = runHook('session-save.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0);
        assert.equal(r.stdout.trim(), '');
      });
    });
  });

  describe('axis-6: timeout budget', () => {
    it('< 500ms', () => {
      withSandbox(({ home, projectDir }) => {
        const r = runHook('session-save.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.ok(r.durationMs < 500, `took ${r.durationMs}ms`);
      });
    });
  });
});

describe('session-watcher.js', () => {
  // The sandbox HOME has no Claude login, so the watcher's `claude -p` fails fast.
  // For tests that specifically want the non-LLM path AND block the CLI
  // fallback (which would mutate $HOME/.claude/**), also set PATH to /nonexistent.

  describe('axis-1: happy path', () => {
    it('no sessions.jsonl → exit 0, stdout {} or empty', () => {
      withSandbox(({ home, projectDir }) => {
        const r = runHook('session-watcher.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
        if (r.stdout.trim()) assert.deepEqual(JSON.parse(r.stdout.trim()), {});
      });
    });

    it('throttled → stdout {}', () => {
      withSandbox({ withPriorSession: true }, ({ home, memoryDir, projectDir }) => {
        fs.writeFileSync(path.join(memoryDir, '.watcher-state.json'),
          JSON.stringify({ offset: 0, lastRun: Date.now(), transcriptPath: '' }));
        const r = runHook('session-watcher.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout.trim() || '{}'), {});
      });
    });

    it('transcript via stdin transcript_path → exit 0', () => {
      withSandbox(({ home, memoryDir, projectDir, sandboxRoot }) => {
        const transcriptPath = writeTranscript(sandboxRoot, 'stdin-test', 10);
        fs.writeFileSync(path.join(memoryDir, '.watcher-state.json'),
          JSON.stringify({ offset: 0, lastRun: 0, transcriptPath: '' }));
        const r = runHook('session-watcher.js', JSON.stringify({
          session_id: 'stdin-test', hook_event_name: 'Stop',
          transcript_path: transcriptPath,
        }), { env: { HOME: home, PATH: '/nonexistent' }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
      });
    });

    it('claims lastRun before analysing, prints nothing (async output would go to the model)', () => {
      withSandbox(({ home, memoryDir, projectDir, sandboxRoot }) => {
        const transcriptPath = writeTranscript(sandboxRoot, 'claim', 10);
        const statePath = path.join(memoryDir, '.watcher-state.json');
        fs.writeFileSync(statePath, JSON.stringify({ lastRun: 0, transcriptPath: '' }));
        const before = Date.now();
        const r = runHook('session-watcher.js', JSON.stringify({ session_id: 'claim', hook_event_name: 'Stop', transcript_path: transcriptPath }),
          { env: { HOME: home, PATH: '/nonexistent' }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
        assert.ok(JSON.parse(fs.readFileSync(statePath, 'utf8')).lastRun >= before);
        assert.deepEqual(JSON.parse(r.stdout.trim() || '{}'), {});
      });
    });
  });

  describe('axis-2: broken state', () => {
    it('no memory dir → silent exit 0', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        fs.rmSync(memoryDir, { recursive: true, force: true });
        const r = runHook('session-watcher.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0);
        assert.equal(r.stdout.trim(), '');
      });
    });

    it('no CLAUDE_PLUGIN_ROOT → exit 0 (sibling memory.js fallback)', () => {
      withSandbox({ withPriorSession: true }, ({ home, memoryDir, projectDir }) => {
        fs.writeFileSync(path.join(memoryDir, '.watcher-state.json'),
          JSON.stringify({ offset: 0, lastRun: Date.now(), transcriptPath: '' }));
        const r = runHook('session-watcher.js', payload(),
          { env: { HOME: home, CLAUDE_PLUGIN_ROOT: null }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
      });
    });

    it('malformed .watcher-state.json → exit 0', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        fs.writeFileSync(path.join(memoryDir, '.watcher-state.json'), '{ not json !!');
        const r = runHook('session-watcher.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
      });
    });

    it('sessions.jsonl absent → exit 0, stdout {}', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        const p = path.join(memoryDir, 'sessions.jsonl');
        if (fs.existsSync(p)) fs.unlinkSync(p);
        const r = runHook('session-watcher.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout.trim() || '{}'), {});
      });
    });

    it('empty transcript → exit 0', () => {
      withSandbox(({ home, memoryDir, projectDir, sandboxRoot }) => {
        const transcriptPath = path.join(sandboxRoot, 'empty.jsonl');
        fs.writeFileSync(transcriptPath, '');
        fs.writeFileSync(path.join(memoryDir, 'sessions.jsonl'),
          JSON.stringify({ id: 'empty-t', transcript: transcriptPath }) + '\n');
        fs.writeFileSync(path.join(memoryDir, '.watcher-state.json'),
          JSON.stringify({ offset: 0, lastRun: 0, transcriptPath: '' }));
        const r = runHook('session-watcher.js', payload(),
          { env: { HOME: home, PATH: '/nonexistent' }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
      });
    });

    it('transcript with mixed JSON + garbage → exit 0', () => {
      withSandbox(({ home, memoryDir, projectDir, sandboxRoot }) => {
        const transcriptPath = path.join(sandboxRoot, 'mixed.jsonl');
        fs.writeFileSync(transcriptPath, [
          'not json',
          JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
          '{ broken',
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
          '',
        ].join('\n'));
        fs.writeFileSync(path.join(memoryDir, 'sessions.jsonl'),
          JSON.stringify({ id: 'mixed-t', transcript: transcriptPath }) + '\n');
        fs.writeFileSync(path.join(memoryDir, '.watcher-state.json'),
          JSON.stringify({ offset: 0, lastRun: 0, transcriptPath: '' }));
        const r = runHook('session-watcher.js', payload(),
          { env: { HOME: home, PATH: '/nonexistent' }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
      });
    });
  });

  describe('axis-3: malformed input', () => {
    const cases = [
      ['non-JSON string', 'not json !!'],
      ['empty stdin', ''],
      ['truncated JSON', '{"session_id": "abc'],
      ['missing keys', JSON.stringify({ foo: 'bar' })],
    ];
    for (const [name, stdin] of cases) {
      it(`${name} → exit 0`, () => {
        withSandbox(({ home, projectDir }) => {
          const r = runHook('session-watcher.js', stdin, { env: { HOME: home }, cwd: projectDir });
          assert.equal(r.exitCode, 0, r.stderr);
        });
      });
    }
  });

  describe('axis-5: stdout contract', () => {
    it('throttled → stdout is exactly {}', () => {
      withSandbox({ withPriorSession: true }, ({ home, memoryDir, projectDir }) => {
        fs.writeFileSync(path.join(memoryDir, '.watcher-state.json'),
          JSON.stringify({ offset: 0, lastRun: Date.now(), transcriptPath: '' }));
        const r = runHook('session-watcher.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.deepEqual(JSON.parse(r.stdout.trim()), {});
      });
    });

    it('no transcript → stdout is exactly {}', () => {
      withSandbox(({ home, projectDir }) => {
        const r = runHook('session-watcher.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.deepEqual(JSON.parse(r.stdout.trim() || '{}'), {});
      });
    });

    it('throttled path emits at most one line', () => {
      withSandbox({ withPriorSession: true }, ({ home, memoryDir, projectDir }) => {
        fs.writeFileSync(path.join(memoryDir, '.watcher-state.json'),
          JSON.stringify({ offset: 0, lastRun: Date.now(), transcriptPath: '' }));
        const r = runHook('session-watcher.js', payload(), { env: { HOME: home }, cwd: projectDir });
        const lines = r.stdout.split('\n').filter(l => l.trim());
        assert.ok(lines.length <= 1, JSON.stringify(r.stdout));
      });
    });
  });

  describe('axis-6: timeout budget', () => {
    it('throttled < 1000ms', () => {
      withSandbox({ withPriorSession: true }, ({ home, memoryDir, projectDir }) => {
        fs.writeFileSync(path.join(memoryDir, '.watcher-state.json'),
          JSON.stringify({ offset: 0, lastRun: Date.now(), transcriptPath: '' }));
        const r = runHook('session-watcher.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.ok(r.durationMs < 1000, `took ${r.durationMs}ms`);
      });
    });

    it('no transcript < 1000ms', () => {
      withSandbox(({ home, projectDir }) => {
        const r = runHook('session-watcher.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.ok(r.durationMs < 1000, `took ${r.durationMs}ms`);
      });
    });

    it('insufficient messages < 1000ms', () => {
      withSandbox(({ home, memoryDir, projectDir, sandboxRoot }) => {
        const transcriptPath = writeTranscript(sandboxRoot, 'few', 3);
        fs.writeFileSync(path.join(memoryDir, 'sessions.jsonl'),
          JSON.stringify({ id: 'few', transcript: transcriptPath }) + '\n');
        fs.writeFileSync(path.join(memoryDir, '.watcher-state.json'),
          JSON.stringify({ offset: 0, lastRun: 0, transcriptPath: '' }));
        const r = runHook('session-watcher.js', payload(),
          { env: { HOME: home, PATH: '/nonexistent' }, cwd: projectDir });
        assert.ok(r.durationMs < 1000, `took ${r.durationMs}ms`);
      });
    });
  });
});
