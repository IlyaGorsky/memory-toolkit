#!/usr/bin/env node
// PreToolUse hook for the Skill tool.
// If the invoked skill has `metadata.pipeline: true` in its frontmatter,
// inject the task-template orchestrator contract into the tool-call context
// so the model routes through the pipeline instead of following SKILL.md prose.

const fs = require('fs');
const path = require('path');
const log = require('./lib/log');

let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}

let payload = {};
try { payload = JSON.parse(stdin); } catch { process.exit(0); }

const toolName = payload.tool_name || '';
if (toolName !== 'Skill') process.exit(0);

const rawSkill = (payload.tool_input && payload.tool_input.skill) || '';
if (!rawSkill) process.exit(0);

const skillName = rawSkill.includes(':') ? rawSkill.split(':').pop() : rawSkill;

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const skillPath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
if (!fs.existsSync(skillPath)) process.exit(0);

let content = '';
try { content = fs.readFileSync(skillPath, 'utf8'); } catch { process.exit(0); }

const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) process.exit(0);
const fm = fmMatch[1];

const hasPipeline = /metadata:[\s\S]*?\n\s+pipeline:\s*true\b/.test(fm);
if (!hasPipeline) process.exit(0);

const templatePath = path.join(pluginRoot, 'skills', 'task-template', 'templates', `${skillName}.yaml`);
const templateExists = fs.existsSync(templatePath);

const contract = [
  '═══════════════════════════════════════════════════════════',
  `PIPELINE SKILL DETECTED: ${skillName}`,
  '═══════════════════════════════════════════════════════════',
  '',
  'This skill has `metadata.pipeline: true`. Do NOT execute the prose',
  'in its SKILL.md directly — route through the task-template orchestrator.',
  '',
  'Contract (MUST):',
  `  1. Load pipeline YAML: ${templatePath}${templateExists ? '' : '  (MISSING — abort and report)'}`,
  '  2. Print the plan banner BEFORE any phase runs, using ASCII fences:',
  '       ==================================================',
  `       PIPELINE START: ${skillName}  (args: <k=v>)`,
  '       ==================================================',
  '       Wave 1 (no deps):',
  '         1. <phase-id> -- <description>',
  '       ...',
  '       ==================================================',
  '       END PLAN -- <N> phases, executing now',
  '       ==================================================',
  '  3. Announce each phase before executing:',
  '       >>> PHASE <n>/<N>: <phase-id> -- <description>',
  '     Skipped (when=false):  --- SKIP <n>/<N>: <phase-id> ...',
  '     Retry (verify fail):   !!! RETRY <n>/<N>: <phase-id> -> <retry_from>',
  '  4. Honor depends / when / verify / retry_from exactly — no phase skipping,',
  '     no gate bypass, no silent execution.',
  '  5. SKILL.md prose is per-phase reference, not a script.',
  '',
  `Full contract: ${path.join(pluginRoot, 'skills', 'task-template', 'SKILL.md')}`,
  '═══════════════════════════════════════════════════════════',
].join('\n');

const output = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    additionalContext: contract,
  },
};

log.debug('pipeline-hint fired', { skill: skillName, templateExists });
process.stdout.write(JSON.stringify(output) + '\n');
