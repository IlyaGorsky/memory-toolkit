/**
 * Runtime e2e — invokes `claude` CLI against a real model to verify
 * that the task-template orchestrator produces correct execution plans
 * from pipeline YAMLs.
 *
 * NOT part of default `npm test` — costs API tokens. Gated by
 * RUN_RUNTIME_TESTS=1. Run with:
 *
 *   RUN_RUNTIME_TESTS=1 node --test tests/pipeline-runtime.test.js
 *
 * Requires `claude` CLI on PATH and valid credentials in env.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const SHOULD_RUN = process.env.RUN_RUNTIME_TESTS === '1';

describe('runtime: orchestrator plan formation', { skip: !SHOULD_RUN && 'set RUN_RUNTIME_TESTS=1 to enable' }, () => {
  // Plan-formation tests read pipeline files; no writes. Run with cwd=PLUGIN_ROOT
  // so tool access to absolute paths below PLUGIN_ROOT is permitted.

  function runClaude(prompt, { timeout = 180000 } = {}) {
    const escaped = prompt.replace(/"/g, '\\"');
    return execSync(
      `claude -p --plugin-dir "${PLUGIN_ROOT}" --dangerously-skip-permissions --output-format text "${escaped}"`,
      {
        encoding: 'utf8',
        timeout,
        cwd: PLUGIN_ROOT,
      }
    );
  }

  it('orchestrator produces plan with all phases from session-end.yaml', () => {
    const yamlPath = path.join(PLUGIN_ROOT, 'skills/task-template/templates/session-end.yaml');
    const contractPath = path.join(PLUGIN_ROOT, 'skills/task-template/SKILL.md');
    const prompt = [
      `Read the pipeline at ${yamlPath}`,
      `and the orchestrator contract at ${contractPath}.`,
      '',
      'Output ONLY the execution plan in the Format for user described in the contract.',
      'Do not execute any phase. Do not ask for confirmation.',
      'The plan must list every phase by id.',
    ].join('\n');

    const output = runClaude(prompt);

    const expectedPhases = [
      'memory-scan',
      'handoff-draft',
      'handoff-confirm',
      'handoff-write',
      'reflect-cascade',
      'docs-scan',
      'docs-cascade',
      'session-marker',
      'report',
    ];

    for (const phase of expectedPhases) {
      assert.ok(
        output.includes(phase),
        `plan should reference phase "${phase}". Output:\n${output}`
      );
    }
  });

  it('orchestrator surfaces verify gates in plan', () => {
    const yamlPath = path.join(PLUGIN_ROOT, 'skills/task-template/templates/session-end.yaml');
    const contractPath = path.join(PLUGIN_ROOT, 'skills/task-template/SKILL.md');
    const prompt = [
      `Read ${yamlPath} and ${contractPath}.`,
      'Output the execution plan only. Mark phases that have verify gates.',
    ].join('\n');

    const output = runClaude(prompt);

    assert.ok(
      /verify/i.test(output),
      `plan should mention verify gates. Output:\n${output}`
    );
  });

  it('orchestrator surfaces retry_from on handoff-confirm', () => {
    const yamlPath = path.join(PLUGIN_ROOT, 'skills/task-template/templates/session-end.yaml');
    const prompt = [
      `Read ${yamlPath}.`,
      'For the handoff-confirm phase, state what retry_from points to. One line only.',
    ].join('\n');

    const output = runClaude(prompt);

    assert.ok(
      /handoff-draft/.test(output),
      `output should name handoff-draft as retry target. Output:\n${output}`
    );
  });
});
