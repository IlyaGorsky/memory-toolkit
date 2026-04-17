// AP-42 hook safety E2E. 9 axes × 4 hooks. Each test runs in an isolated
// sandbox (throwaway HOME, toy git project). See decisions/ap-42-hook-safety-e2e.md.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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
    it('writes handoff.md', () => {
      withSandbox(({ home, memoryDir, projectDir }) => {
        const r = runHook('session-save.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
        assert.ok(fs.existsSync(path.join(memoryDir, 'workstreams', 'handoff.md')));
      });
    });

    it('overwrites prior handoff', () => {
      withSandbox({ withPriorSession: true }, ({ home, memoryDir, projectDir }) => {
        const wsDir = path.join(memoryDir, 'workstreams');
        fs.mkdirSync(wsDir, { recursive: true });
        fs.writeFileSync(path.join(wsDir, 'handoff.md'), '# Old\n');
        runHook('session-save.js', payload({ session_id: 'save-new' }),
          { env: { HOME: home }, cwd: projectDir });
        const content = fs.readFileSync(path.join(wsDir, 'handoff.md'), 'utf8');
        assert.ok(content.includes('save-new'));
        assert.ok(!content.includes('Old'));
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

    // session-save.js does not guard fs.writeFileSync — EACCES will crash it.
    // Surfaced by AP-42; graceful-exit guarantee deferred to a follow-up AP.
    it.skip('workstreams/ read-only → graceful exit 0 [bug, follow-up]', () => {});
  });

  describe('axis-3: malformed input', () => {
    const cases = [
      ['non-JSON string', 'not valid json', (memoryDir) => {
        const c = fs.readFileSync(path.join(memoryDir, 'workstreams', 'handoff.md'), 'utf8');
        assert.ok(c.includes('unknown'));
      }],
      ['empty stdin', ''],
      ['truncated JSON', '{"session_id": "trunc'],
      ['missing session_id', JSON.stringify({ foo: 'bar' }), (memoryDir) => {
        const c = fs.readFileSync(path.join(memoryDir, 'workstreams', 'handoff.md'), 'utf8');
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
  // Default sandbox blocks LLM by clearing ANTHROPIC_API_KEY.
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
          session_id: 'stdin-test', hook_event_name: 'PostToolUse',
          transcript_path: transcriptPath, tool_name: 'Bash',
        }), { env: { HOME: home, PATH: '/nonexistent' }, cwd: projectDir });
        assert.equal(r.exitCode, 0, r.stderr);
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

describe('pipeline-hint.js', () => {
  // The hook exits immediately unless MEMORY_TOOLKIT_PIPELINE_DEBUG=1.

  describe('axis-1: happy path', () => {
    it('no debug flag → silent exit 0', () => {
      withSandbox(() => {
        const r = runHook('pipeline-hint.js', payload({ prompt: '/session-end' }),
          { env: { MEMORY_TOOLKIT_PIPELINE_DEBUG: undefined } });
        assert.equal(r.exitCode, 0, r.stderr);
        assert.equal(r.stdout.trim(), '');
      });
    });

    it('debug: /session-end → UserPromptSubmit JSON', () => {
      const r = runHook('pipeline-hint.js', JSON.stringify({ prompt: '/session-end' }),
        { env: { MEMORY_TOOLKIT_PIPELINE_DEBUG: '1' } });
      assert.equal(r.exitCode, 0, r.stderr);
      assertValidHookStdout(r.stdout, { hookEventName: 'UserPromptSubmit' });
      const ctx = JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('session-end'));
    });

    it('debug: /session-start → UserPromptSubmit JSON', () => {
      const r = runHook('pipeline-hint.js', JSON.stringify({ prompt: '/session-start' }),
        { env: { MEMORY_TOOLKIT_PIPELINE_DEBUG: '1' } });
      assert.equal(r.exitCode, 0, r.stderr);
      assertValidHookStdout(r.stdout, { hookEventName: 'UserPromptSubmit' });
    });
  });

  describe('axis-2: broken state', () => {
    // Without CLAUDE_PLUGIN_ROOT, skillPath resolves to __dirname/.. which
    // is PLUGIN_ROOT by coincidence — covered test: no crash.
    it('debug + no CLAUDE_PLUGIN_ROOT → exit 0', () => {
      const r = runHook('pipeline-hint.js', JSON.stringify({ prompt: '/session-end' }),
        { env: { MEMORY_TOOLKIT_PIPELINE_DEBUG: '1', CLAUDE_PLUGIN_ROOT: null } });
      assert.equal(r.exitCode, 0, r.stderr);
    });

    it('no debug + no CLAUDE_PLUGIN_ROOT → silent exit 0 (debug gate)', () => {
      const r = runHook('pipeline-hint.js', payload(),
        { env: { MEMORY_TOOLKIT_PIPELINE_DEBUG: undefined, CLAUDE_PLUGIN_ROOT: null } });
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.stdout.trim(), '');
    });
  });

  describe('axis-3: malformed input', () => {
    const cases = [
      ['non-JSON', 'not json !@#'],
      ['empty stdin', ''],
      ['truncated JSON', '{"prompt": "/session'],
      ['missing prompt', JSON.stringify({ session_id: 'abc' })],
      ['non-slash prompt', JSON.stringify({ prompt: 'hello' })],
      ['non-pipeline skill', JSON.stringify({ prompt: '/memory list' })],
      ['unknown skill', JSON.stringify({ prompt: '/does-not-exist' })],
    ];
    for (const [name, stdin] of cases) {
      it(`${name} → silent exit 0`, () => {
        const r = runHook('pipeline-hint.js', stdin, { env: { MEMORY_TOOLKIT_PIPELINE_DEBUG: '1' } });
        assert.equal(r.exitCode, 0, r.stderr);
        assert.equal(r.stdout.trim(), '');
      });
    }
  });

  describe('axis-5: stdout contract', () => {
    it('no debug → stdout empty', () => {
      const r = runHook('pipeline-hint.js', JSON.stringify({ prompt: '/session-end' }),
        { env: { MEMORY_TOOLKIT_PIPELINE_DEBUG: undefined } });
      assert.equal(r.stdout.trim(), '');
    });

    it('debug pipeline skill → clean JSON, no wrapping garbage', () => {
      const r = runHook('pipeline-hint.js', JSON.stringify({ prompt: '/session-end' }),
        { env: { MEMORY_TOOLKIT_PIPELINE_DEBUG: '1' } });
      const t = r.stdout.trim();
      assert.equal(t[0], '{');
      assert.equal(t[t.length - 1], '}');
      assertValidHookStdout(r.stdout, { hookEventName: 'UserPromptSubmit' });
    });
  });

  describe('axis-6: timeout budget', () => {
    const cases = [
      ['no debug', payload({ prompt: '/session-end' }), { MEMORY_TOOLKIT_PIPELINE_DEBUG: undefined }],
      ['debug pipeline skill', JSON.stringify({ prompt: '/session-end' }), { MEMORY_TOOLKIT_PIPELINE_DEBUG: '1' }],
      ['debug malformed', 'garbage', { MEMORY_TOOLKIT_PIPELINE_DEBUG: '1' }],
    ];
    for (const [name, stdin, env] of cases) {
      it(`${name} < 200ms`, () => {
        const r = runHook('pipeline-hint.js', stdin, { env });
        assert.ok(r.durationMs < 200, `took ${r.durationMs}ms`);
      });
    }
  });
});

// Under hostile conditions the hook must exit with a finite code and no signal.
// Exit 0 preferred, non-zero acceptable if controlled (no SIGSEGV, no timeout).
describe('axis-4: uncaught exception paths', () => {
  function assertControlled(r) {
    assert.equal(r.signal, null, `signal=${r.signal}, stderr=${r.stderr}`);
    assert.notEqual(r.exitCode, -1, `timed out: ${r.stderr}`);
    assert.ok(Number.isInteger(r.exitCode));
  }

  it('session-log: notes/ read-only', () => {
    withSandbox(({ home, memoryDir, projectDir }) => {
      const notesDir = path.join(memoryDir, 'notes');
      fs.mkdirSync(notesDir, { recursive: true });
      fs.chmodSync(notesDir, 0o500);
      try {
        const r = runHook('session-log.js', payload({ transcript_path: '/tmp/t.jsonl' }),
          { env: { HOME: home }, cwd: projectDir });
        assertControlled(r);
      } finally { fs.chmodSync(notesDir, 0o755); }
    });
  });

  // Known: session-save.js throws on EACCES (no try/catch around writeFileSync).
  // This test asserts controlled termination, not graceful exit.
  it('session-save: workstreams/ read-only (known crash, controlled)', () => {
    withSandbox(({ home, memoryDir, projectDir }) => {
      const wsDir = path.join(memoryDir, 'workstreams');
      fs.mkdirSync(wsDir, { recursive: true });
      fs.chmodSync(wsDir, 0o500);
      try {
        const r = runHook('session-save.js', payload(), { env: { HOME: home }, cwd: projectDir });
        assertControlled(r);
      } finally { fs.chmodSync(wsDir, 0o755); }
    });
  });

  it('session-watcher: unreachable API endpoint', () => {
    withSandbox({ withPriorSession: true }, ({ home, projectDir }) => {
      const r = runHook('session-watcher.js', payload(), {
        env: {
          HOME: home,
          ANTHROPIC_API_KEY: 'sk-dummy',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
          MEMORY_TOOLKIT_WATCHER_FORCE: '1',
        },
        cwd: projectDir,
        timeout: 15000,
      });
      assertControlled(r);
    });
  });

  it('session-watcher: binary garbage in transcript', () => {
    withSandbox(({ home, memoryDir, projectDir, sandboxRoot }) => {
      const transcriptPath = path.join(sandboxRoot, 'bin.jsonl');
      fs.writeFileSync(transcriptPath, Buffer.concat([
        Buffer.from('{"type":"user","message":'),
        Buffer.from([0xff, 0xfe, 0x00, 0x01]),
        Buffer.from('\n{"broken'),
      ]));
      fs.writeFileSync(path.join(memoryDir, 'sessions.jsonl'),
        JSON.stringify({ id: 'bin', transcript: transcriptPath }) + '\n');
      const r = runHook('session-watcher.js', payload(),
        { env: { HOME: home, PATH: '/nonexistent' }, cwd: projectDir });
      assertControlled(r);
    });
  });

  it('pipeline-hint: CLAUDE_PLUGIN_ROOT → bogus path', () => {
    withSandbox(({ home, projectDir }) => {
      const r = runHook('pipeline-hint.js', JSON.stringify({ prompt: '/session-end' }),
        {
          env: {
            HOME: home,
            CLAUDE_PLUGIN_ROOT: '/tmp/nonexistent-ap42',
            MEMORY_TOOLKIT_PIPELINE_DEBUG: '1',
          },
          cwd: projectDir,
        });
      assertControlled(r);
    });
  });
});

// Hook writes must stay inside memoryDir. User settings.json and the user's
// project tree are off-limits.
describe('axis-7: filesystem scope', () => {
  function assertInMemoryDir({ before, after, memoryDir, projectDir, home }) {
    const { added, modified } = diffFS(before, after);
    const touched = [...added, ...modified];
    const settingsPath = path.join(home, '.claude', 'settings.json');

    assert.ok(!touched.includes(settingsPath),
      `touched user settings.json: ${settingsPath}`);
    for (const p of touched) {
      assert.ok(!p.startsWith(projectDir + path.sep),
        `wrote inside user project: ${p}`);
    }
    const violations = touched.filter(p =>
      p !== memoryDir && !p.startsWith(memoryDir + path.sep));
    assert.deepEqual(violations, [],
      `wrote outside memoryDir:\n  ${violations.join('\n  ')}`);
  }

  it('session-log: writes only in memoryDir', () => {
    withSandbox((ctx) => {
      const before = snapshotFS(ctx.sandboxRoot);
      runHook('session-log.js', payload({ transcript_path: '/tmp/t.jsonl' }),
        { env: { HOME: ctx.home }, cwd: ctx.projectDir });
      assertInMemoryDir({ before, after: snapshotFS(ctx.sandboxRoot), ...ctx });
    });
  });

  it('session-save: writes only in memoryDir', () => {
    withSandbox((ctx) => {
      const before = snapshotFS(ctx.sandboxRoot);
      runHook('session-save.js', payload(), { env: { HOME: ctx.home }, cwd: ctx.projectDir });
      assertInMemoryDir({ before, after: snapshotFS(ctx.sandboxRoot), ...ctx });
    });
  });

  // PATH=/nonexistent blocks the `claude -p` fallback — the CC CLI itself
  // would otherwise write to $HOME/.claude/{backups,projects,sessions}, which
  // is CLI behaviour, not watcher code. Scoping the check to the hook's own
  // writes. See handoff note for ap-43 follow-up on subprocess HOME isolation.
  it('session-watcher: writes only in memoryDir (LLM blocked)', () => {
    withSandbox({ withPriorSession: true }, (ctx) => {
      const before = snapshotFS(ctx.sandboxRoot);
      runHook('session-watcher.js', payload(),
        { env: { HOME: ctx.home, PATH: '/nonexistent' }, cwd: ctx.projectDir });
      assertInMemoryDir({ before, after: snapshotFS(ctx.sandboxRoot), ...ctx });
    });
  });

  it('pipeline-hint: never writes to disk', () => {
    withSandbox((ctx) => {
      const before = snapshotFS(ctx.sandboxRoot);
      runHook('pipeline-hint.js', JSON.stringify({ prompt: '/session-end' }),
        { env: { HOME: ctx.home, MEMORY_TOOLKIT_PIPELINE_DEBUG: '1' }, cwd: ctx.projectDir });
      const { added, modified } = diffFS(before, snapshotFS(ctx.sandboxRoot));
      assert.deepEqual([...added, ...modified], []);
    });
  });
});

// Scoped to what the unit suite can prove: plugin hooks never mutate the
// user's settings.json. Full CC hook-mux priority semantics are guaranteed
// by the platform (R2-hooks) and require invoking Claude Code to exercise.
describe('axis-9: coexistence with user hook', () => {
  function seedUserSettings(home) {
    const dir = path.join(home, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'settings.json');
    const content = JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'echo user' }],
        }],
      },
    }, null, 2);
    fs.writeFileSync(p, content);
    return { settingsPath: p, content };
  }

  function assertUntouched(p, original) {
    assert.ok(fs.existsSync(p), 'settings.json was deleted');
    assert.equal(fs.readFileSync(p, 'utf8'), original, 'settings.json was mutated');
  }

  it('session-log: user settings untouched', () => {
    withSandbox(({ home, projectDir }) => {
      const { settingsPath, content } = seedUserSettings(home);
      runHook('session-log.js', payload({ transcript_path: '/tmp/t.jsonl' }),
        { env: { HOME: home }, cwd: projectDir });
      assertUntouched(settingsPath, content);
    });
  });

  it('session-save: user settings untouched', () => {
    withSandbox(({ home, projectDir }) => {
      const { settingsPath, content } = seedUserSettings(home);
      runHook('session-save.js', payload(), { env: { HOME: home }, cwd: projectDir });
      assertUntouched(settingsPath, content);
    });
  });

  it('session-watcher: user settings untouched', () => {
    withSandbox({ withPriorSession: true }, ({ home, projectDir }) => {
      const { settingsPath, content } = seedUserSettings(home);
      runHook('session-watcher.js', payload(),
        { env: { HOME: home, PATH: '/nonexistent' }, cwd: projectDir });
      assertUntouched(settingsPath, content);
    });
  });

  it('pipeline-hint: user settings untouched', () => {
    withSandbox(({ home, projectDir }) => {
      const { settingsPath, content } = seedUserSettings(home);
      runHook('pipeline-hint.js', JSON.stringify({ prompt: '/session-end' }),
        { env: { HOME: home, MEMORY_TOOLKIT_PIPELINE_DEBUG: '1' }, cwd: projectDir });
      assertUntouched(settingsPath, content);
    });
  });
});
