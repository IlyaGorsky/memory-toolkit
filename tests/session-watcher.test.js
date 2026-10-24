/**
 * Unit tests for session-watcher pure functions.
 *
 * No API calls, no filesystem side effects (except readNewMessages which reads a temp file).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractText, readNewMessages, buildConversationText, ANALYSIS_PROMPT, extractStructuredOutput, FINDINGS_SCHEMA, CLI_ARGS, quoteArg } = require('../scripts/session-watcher');

// --- extractStructuredOutput ---

describe('extractStructuredOutput', () => {
  it('reads structured_output object from envelope', () => {
    const envelope = JSON.stringify({
      type: 'result',
      result: 'Done.',
      structured_output: {
        findings: [{ type: 'decision', summary: 'use Haiku' }],
        phase: 'planning',
      },
    });
    const res = extractStructuredOutput(envelope);
    assert.equal(res.findings.length, 1);
    assert.equal(res.phase, 'planning');
    assert.equal(res.parseError, false);
  });

  it('accepts null phase', () => {
    const envelope = JSON.stringify({ structured_output: { findings: [], phase: null } });
    const res = extractStructuredOutput(envelope);
    assert.equal(res.phase, null);
    assert.equal(res.parseError, false);
  });

  it('parseError on missing structured_output field', () => {
    const envelope = JSON.stringify({ type: 'result', result: 'Done.' });
    const res = extractStructuredOutput(envelope);
    assert.equal(res.parseError, true);
    assert.equal(res.findings.length, 0);
  });

  it('parseError on invalid envelope JSON', () => {
    const res = extractStructuredOutput('not json at all');
    assert.equal(res.parseError, true);
  });

  it('parseError when findings is not an array', () => {
    const envelope = JSON.stringify({ structured_output: { findings: 'nope', phase: null } });
    const res = extractStructuredOutput(envelope);
    assert.equal(res.parseError, true);
  });
});

// --- claude CLI invocation ---

describe('CLI_ARGS', () => {
  it('runs the nested claude in safe mode, without tools or a transcript', () => {
    for (const flag of ['-p', '--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) {
      assert.ok(CLI_ARGS.includes(flag), flag);
    }
    assert.equal(CLI_ARGS[CLI_ARGS.indexOf('--tools') + 1], '');
    assert.deepEqual(JSON.parse(CLI_ARGS[CLI_ARGS.indexOf('--json-schema') + 1]), FINDINGS_SCHEMA);
  });
});

describe('quoteArg (Windows command line)', () => {
  it('leaves plain args alone', () => {
    assert.equal(quoteArg('--safe-mode'), '--safe-mode');
    assert.equal(quoteArg('claude-haiku-5-5'), 'claude-haiku-5-5');
  });

  it('quotes empty args and escapes inner quotes', () => {
    assert.equal(quoteArg(''), '""');
    assert.equal(quoteArg('{"a":1}'), '"{\\"a\\":1}"');
  });
});

// The Anthropic directory holds versions that read a credential from the user's
// environment or forward the whole environment to a subprocess.
describe('no credential reads in plugin scripts', () => {
  const scriptsDir = path.join(__dirname, '..', 'scripts');
  const files = [...fs.readdirSync(scriptsDir), ...fs.readdirSync(path.join(scriptsDir, 'lib')).map(f => `lib/${f}`)]
    .filter(f => f.endsWith('.js'));
  for (const file of files) {
    it(file, () => {
      const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
      assert.ok(!/ANTHROPIC_API_KEY|API_KEY|_TOKEN\b/.test(src), 'reads a credential');
      assert.ok(!/\.\.\.process\.env/.test(src), 'forwards the whole environment');
    });
  }
});

// --- FINDINGS_SCHEMA ---

describe('FINDINGS_SCHEMA', () => {
  it('constrains findings and phase shape for --json-schema', () => {
    assert.equal(FINDINGS_SCHEMA.type, 'object');
    assert.deepEqual(FINDINGS_SCHEMA.required, ['findings', 'phase']);
    assert.equal(FINDINGS_SCHEMA.properties.findings.type, 'array');
    assert.ok(FINDINGS_SCHEMA.properties.phase.enum.includes('planning'));
    assert.ok(FINDINGS_SCHEMA.properties.phase.enum.includes(null));
  });
});

// --- extractText ---

describe('extractText', () => {
  it('extracts from string', () => {
    assert.equal(extractText('hello'), 'hello');
  });

  it('extracts from {content: string}', () => {
    assert.equal(extractText({ content: 'hello' }), 'hello');
  });

  it('extracts from {content: [{type: "text", text: ...}]}', () => {
    const msg = { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] };
    assert.equal(extractText(msg), 'first\nsecond');
  });

  it('filters out non-text content blocks', () => {
    const msg = { content: [{ type: 'tool_use', id: '1' }, { type: 'text', text: 'visible' }] };
    assert.equal(extractText(msg), 'visible');
  });

  it('returns empty for null/undefined', () => {
    assert.equal(extractText(null), '');
    assert.equal(extractText(undefined), '');
  });

  it('returns empty for object without content', () => {
    assert.equal(extractText({ role: 'user' }), '');
  });
});

// --- readNewMessages ---

describe('readNewMessages', () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'watcher-test-'));
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');

  it('reads messages from offset 0', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'do X' }] } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const { messages, newOffset } = readNewMessages(transcriptPath, 0);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].text, 'hello');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(newOffset, fs.statSync(transcriptPath).size);
  });

  it('reads only new messages from a byte offset', () => {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const afterTwo = Buffer.byteLength(content.split('\n').slice(0, 2).join('\n') + '\n');
    const { messages, newOffset } = readNewMessages(transcriptPath, afterTwo);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'do X');
    assert.equal(newOffset, fs.statSync(transcriptPath).size);
  });

  it('leaves a line still being written for the next run', () => {
    const done = JSON.stringify({ type: 'user', message: { content: 'complete' } }) + '\n';
    fs.writeFileSync(transcriptPath, done + '{"type":"user","message":{"content":"half');
    const { messages, newOffset } = readNewMessages(transcriptPath, 0);
    assert.deepEqual(messages.map(m => m.text), ['complete']);
    assert.equal(newOffset, Buffer.byteLength(done));
  });

  it('starts over when the offset is past the end (file rewritten)', () => {
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'user', message: { content: 'fresh' } }) + '\n');
    const { messages } = readNewMessages(transcriptPath, 10_000_000);
    assert.deepEqual(messages.map(m => m.text), ['fresh']);
  });

  it('null offset reads only the tail and skips the cut line', () => {
    const filler = JSON.stringify({ type: 'system', text: 'x'.repeat(1024 * 1024) }) + '\n';
    const last = JSON.stringify({ type: 'user', message: { content: 'newest' } }) + '\n';
    fs.writeFileSync(transcriptPath, filler.repeat(6) + last);
    const { messages, newOffset } = readNewMessages(transcriptPath, null);
    assert.deepEqual(messages.map(m => m.text), ['newest']);
    assert.equal(newOffset, fs.statSync(transcriptPath).size);
  });

  it('keeps only the newest 40 messages', () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: `m${i}` } }));
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
    const { messages } = readNewMessages(transcriptPath, 0);
    assert.equal(messages.length, 40);
    assert.equal(messages[0].text, 'm10');
    assert.equal(messages[39].text, 'm49');
  });

  it('skips command messages', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '<command>slash</command>' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'real message' }] } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const { messages } = readNewMessages(transcriptPath, 0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'real message');
  });

  it('truncates long messages to 1000 chars', () => {
    const longText = 'x'.repeat(2000);
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: longText }] } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const { messages } = readNewMessages(transcriptPath, 0);
    assert.equal(messages[0].text.length, 1000);
  });

  it('returns empty for non-existent file', () => {
    const { messages, newOffset } = readNewMessages('/tmp/no-such-file.jsonl', 0);
    assert.equal(messages.length, 0);
    assert.equal(newOffset, 0);
  });

  it('handles role field (alternative transcript format)', () => {
    const lines = [
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'alt format' }] }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const { messages } = readNewMessages(transcriptPath, 0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'alt format');
  });

  // cleanup
  it('cleanup', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// --- buildConversationText ---

describe('buildConversationText', () => {
  it('formats user and assistant messages', () => {
    const messages = [
      { role: 'user', text: 'how to fix this?' },
      { role: 'assistant', text: 'try restarting' },
    ];
    const result = buildConversationText(messages);
    assert.ok(result.includes('User: how to fix this?'));
    assert.ok(result.includes('Assistant: try restarting'));
  });

  it('separates messages with double newline', () => {
    const messages = [
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
    ];
    const result = buildConversationText(messages);
    assert.ok(result.includes('\n\n'));
  });

  it('returns empty for empty array', () => {
    assert.equal(buildConversationText([]), '');
  });
});

// --- ANALYSIS_PROMPT ---

describe('ANALYSIS_PROMPT', () => {
  it('includes phase detection', () => {
    assert.ok(ANALYSIS_PROMPT.includes('phase'));
    assert.ok(ANALYSIS_PROMPT.includes('planning'));
    assert.ok(ANALYSIS_PROMPT.includes('implementation'));
    assert.ok(ANALYSIS_PROMPT.includes('review'));
    assert.ok(ANALYSIS_PROMPT.includes('debug'));
  });

  it('includes all finding types', () => {
    assert.ok(ANALYSIS_PROMPT.includes('correction'));
    assert.ok(ANALYSIS_PROMPT.includes('decision'));
    assert.ok(ANALYSIS_PROMPT.includes('plan'));
    assert.ok(ANALYSIS_PROMPT.includes('documentation'));
  });

  it('requests JSON output', () => {
    assert.ok(ANALYSIS_PROMPT.includes('"findings"'));
    assert.ok(ANALYSIS_PROMPT.includes('"phase"'));
  });
});
