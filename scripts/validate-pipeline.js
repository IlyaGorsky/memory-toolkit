#!/usr/bin/env node
'use strict';

/**
 * Validate task-template YAML pipelines.
 *
 * Usage:
 *   node validate-pipeline.js <file.yaml>
 *   node validate-pipeline.js --all          # validate all templates
 *
 * Checks:
 *   1. Schema — every phase has id, description, steps
 *   2. Graph  — depends reference existing ids, no cycles
 *   3. Gates  — at least one phase has a verify gate
 *   4. Terminal — last phase has depends (not floating)
 *
 * Exit code 0 = valid, 1 = errors found.
 */

const fs = require('fs');
const path = require('path');

// Minimal YAML parser — handles only the subset we use (no external deps).
// For full YAML, swap in 'js-yaml'. Our templates are simple enough.
function parseYaml(text) {
  // Use a line-based parser for our flat phase structure
  const result = { name: '', description: '', phases: [] };
  let currentPhase = null;
  let currentStep = null;

  for (const raw of text.split('\n')) {
    const line = raw;
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Top-level fields
    if (indent === 0 && trimmed.startsWith('name:')) {
      result.name = trimmed.slice(5).trim();
    } else if (indent === 0 && trimmed.startsWith('description:')) {
      result.description = trimmed.slice(12).trim();
    } else if (indent === 0 && trimmed === 'phases:') {
      // phases block starts
    } else if (indent === 2 && trimmed.startsWith('- id:')) {
      currentPhase = {
        id: trimmed.slice(5).trim(),
        description: '',
        steps: [],
        depends: [],
        output: '',
        verify: '',
      };
      currentStep = null;
      result.phases.push(currentPhase);
    } else if (indent === 2 && trimmed.startsWith('- ') && !trimmed.startsWith('- id:')) {
      // Phase without id — still track it so we can report the error
      currentPhase = {
        id: '',
        description: '',
        steps: [],
        depends: [],
        output: '',
        verify: '',
      };
      currentStep = null;
      result.phases.push(currentPhase);
      // Parse inline field (e.g. "- description: ...")
      if (trimmed.startsWith('- description:')) {
        currentPhase.description = trimmed.slice(14).trim();
      }
    } else if (currentPhase && indent === 4) {
      if (trimmed.startsWith('description:')) {
        currentPhase.description = trimmed.slice(12).trim();
      } else if (trimmed.startsWith('depends:')) {
        const match = trimmed.match(/\[([^\]]*)\]/);
        if (match) {
          currentPhase.depends = match[1].split(',').map(s => s.trim()).filter(Boolean);
        }
      } else if (trimmed.startsWith('output:')) {
        currentPhase.output = trimmed.slice(7).trim();
      } else if (trimmed.startsWith('verify:')) {
        currentPhase.verify = trimmed.slice(7).trim();
      } else if (trimmed === 'steps:') {
        // steps block
      }
    } else if (currentPhase && indent === 6 && trimmed.startsWith('- description:')) {
      currentStep = trimmed.slice(14).trim().replace(/^["']|["']$/g, '');
      currentPhase.steps.push(currentStep);
    } else if (currentPhase && indent === 6 && trimmed.startsWith('- run:')) {
      currentStep = trimmed.slice(6).trim().replace(/^["']|["']$/g, '');
      currentPhase.steps.push(currentStep);
    } else if (currentPhase && indent === 6 && trimmed.startsWith('- skill:')) {
      currentStep = trimmed.slice(8).trim().replace(/^["']|["']$/g, '');
      currentPhase.steps.push(currentStep);
    }
  }

  return result;
}

function validate(filePath) {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(filePath)) {
    errors.push(`File not found: ${filePath}`);
    return { errors, warnings };
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const pipeline = parseYaml(text);
  const basename = path.basename(filePath);

  // Top-level
  if (!pipeline.name) errors.push(`${basename}: missing top-level "name"`);
  if (!pipeline.phases.length) {
    errors.push(`${basename}: no phases found`);
    return { errors, warnings };
  }

  const ids = new Set();
  const idList = [];

  for (const phase of pipeline.phases) {
    const label = `${basename} → ${phase.id || '(no id)'}`;

    // 1. Schema
    if (!phase.id) {
      errors.push(`${label}: phase missing "id"`);
      continue;
    }
    if (ids.has(phase.id)) {
      errors.push(`${label}: duplicate phase id "${phase.id}"`);
    }
    ids.add(phase.id);
    idList.push(phase.id);

    if (!phase.description) {
      errors.push(`${label}: missing "description"`);
    }
    if (!phase.steps.length) {
      errors.push(`${label}: no steps defined`);
    }
  }

  // 2. Graph — depends reference existing ids
  for (const phase of pipeline.phases) {
    for (const dep of phase.depends) {
      if (!ids.has(dep)) {
        errors.push(`${basename} → ${phase.id}: depends on "${dep}" which does not exist`);
      }
      if (dep === phase.id) {
        errors.push(`${basename} → ${phase.id}: depends on itself`);
      }
    }
  }

  // 2b. Cycle detection (DFS)
  const visited = new Set();
  const inStack = new Set();
  const phaseMap = Object.fromEntries(pipeline.phases.map(p => [p.id, p]));

  function hasCycle(id) {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    const phase = phaseMap[id];
    if (phase) {
      for (const dep of phase.depends) {
        if (hasCycle(dep)) return true;
      }
    }
    inStack.delete(id);
    return false;
  }

  for (const id of idList) {
    visited.clear();
    inStack.clear();
    if (hasCycle(id)) {
      errors.push(`${basename}: dependency cycle involving "${id}"`);
      break;
    }
  }

  // 3. Gates — at least one verify
  const hasVerify = pipeline.phases.some(p => p.verify);
  if (!hasVerify) {
    errors.push(`${basename}: no phase has a "verify" gate — pipeline has no structural enforcement`);
  }

  // 4. Terminal phase has depends
  const lastPhase = pipeline.phases[pipeline.phases.length - 1];
  if (lastPhase && !lastPhase.depends.length) {
    errors.push(`${basename} → ${lastPhase.id}: terminal phase has no depends — may run independently`);
  }

  return { errors, warnings, pipeline };
}

// --- CLI ---

const args = process.argv.slice(2);
const templatesDir = path.join(__dirname, '..', 'skills', 'task-template', 'templates');

let files = [];

if (args.includes('--all') || args.length === 0) {
  if (fs.existsSync(templatesDir)) {
    files = fs.readdirSync(templatesDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => path.join(templatesDir, f));
  }
  if (!files.length) {
    console.error('No pipeline templates found in', templatesDir);
    process.exit(1);
  }
} else {
  files = args.map(f => path.resolve(f));
}

let totalErrors = 0;

for (const file of files) {
  const { errors, warnings } = validate(file);
  const name = path.basename(file);

  if (errors.length) {
    console.error(`\n✖ ${name}: ${errors.length} error(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    totalErrors += errors.length;
  } else {
    console.log(`✔ ${name}: valid`);
  }

  for (const w of warnings) {
    console.log(`  ⚠ ${w}`);
  }
}

if (totalErrors) {
  console.error(`\n${totalErrors} error(s) found`);
  process.exit(1);
} else {
  console.log(`\nAll ${files.length} pipeline(s) valid`);
}

// Export for testing
module.exports = { validate, parseYaml };
