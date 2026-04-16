/**
 * Unit tests for session-watcher pure functions.
 *
 * No API calls, no filesystem side effects (except readNewMessages which reads a temp file).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseFindings, extractText, readNewMessages, buildConversationText, ANALYSIS_PROMPT, extractStructuredOutput, FINDINGS_SCHEMA } = require('../scripts/session-watcher');

// --- parseFindings ---

describe('parseFindings', () => {
  it('parses valid JSON with findings and phase', () => {
    const input = '{"findings": [{"type": "decision", "summary": "chose REST over gRPC"}], "phase": "planning"}';
    const result = parseFindings(input);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].type, 'decision');
    assert.equal(result.phase, 'planning');
  });

  it('parses JSON wrapped in markdown code block', () => {
    const input = '```json\n{"findings": [{"type": "correction", "summary": "fix"}], "phase": "debug"}\n```';
    const result = parseFindings(input);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].type, 'correction');
    assert.equal(result.phase, 'debug');
  });

  it('returns empty on no findings', () => {
    const input = '{"findings": [], "phase": null}';
    const result = parseFindings(input);
    assert.equal(result.findings.length, 0);
    assert.equal(result.phase, null);
  });

  it('returns empty on garbage input', () => {
    const result = parseFindings('not json at all');
    assert.equal(result.findings.length, 0);
    assert.equal(result.phase, null);
  });

  it('returns empty on empty string', () => {
    const result = parseFindings('');
    assert.equal(result.findings.length, 0);
    assert.equal(result.phase, null);
  });

  it('handles missing phase field', () => {
    const input = '{"findings": [{"type": "plan", "summary": "do X then Y"}]}';
    const result = parseFindings(input);
    assert.equal(result.findings.length, 1);
    assert.equal(result.phase, null);
  });

  it('handles missing findings field', () => {
    const input = '{"phase": "implementation"}';
    const result = parseFindings(input);
    assert.equal(result.findings.length, 0);
    assert.equal(result.phase, 'implementation');
  });

  it('extracts JSON from prose preamble', () => {
    const input = 'Sure, here is the analysis:\n{"findings": [{"type": "decision", "summary": "use Haiku"}], "phase": "planning"}';
    const result = parseFindings(input);
    assert.equal(result.findings.length, 1);
    assert.equal(result.phase, 'planning');
  });

  it('returns empty on prose without any JSON', () => {
    const input = 'I did not find anything worth saving in this conversation.';
    const result = parseFindings(input);
    assert.equal(result.findings.length, 0);
    assert.equal(result.phase, null);
  });
});

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
    assert.equal(newOffset, 3);
  });

  it('reads only new messages from offset', () => {
    const { messages, newOffset } = readNewMessages(transcriptPath, 2);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'do X');
    assert.equal(newOffset, 3);
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
