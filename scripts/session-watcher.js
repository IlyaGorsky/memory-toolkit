#!/usr/bin/env node

/**
 * Session Watcher — proactive context detector.
 *
 * Reads the active transcript, sends new messages to Haiku for analysis,
 * and saves findings (corrections, decisions, plans) to memory.
 *
 * Called by PostToolUse hook. Self-throttles to avoid running too often.
 *
 * State stored in: <memoryDir>/.watcher-state.json
 * Findings saved via: memory.js note "WATCH: ..."
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const { findMemoryDirOrExit } = require('./lib/find-memory-dir');

// --- Config ---
const THROTTLE_MS = 3 * 60 * 1000; // run at most every 3 minutes
const MIN_NEW_MESSAGES = 6;          // need at least 6 new messages to analyze
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;

// --- Find memory dir ---
const memoryDir = findMemoryDirOrExit();

// --- State ---
const statePath = path.join(memoryDir, '.watcher-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch { return { offset: 0, lastRun: 0, transcriptPath: '' }; }
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// --- Find transcript path ---
function findTranscript() {
  const sessionsPath = path.join(memoryDir, 'sessions.jsonl');
  if (!fs.existsSync(sessionsPath)) return null;
  const lines = fs.readFileSync(sessionsPath, 'utf8').trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  const last = JSON.parse(lines[lines.length - 1]);
  return last.transcript || null;
}

// --- Parse transcript ---
function readNewMessages(transcriptPath, offset) {
  if (!fs.existsSync(transcriptPath)) return { messages: [], newOffset: offset };

  const content = fs.readFileSync(transcriptPath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const newLines = lines.slice(offset);
  const messages = [];

  for (const line of newLines) {
    try {
      const d = JSON.parse(line);
      if (d.type === 'user' || d.role === 'user') {
        const text = extractText(d.message || d);
        if (text && !text.startsWith('<command')) {
          messages.push({ role: 'user', text: text.slice(0, 1000) });
        }
      } else if (d.type === 'assistant') {
        const text = extractText(d.message);
        if (text) {
          messages.push({ role: 'assistant', text: text.slice(0, 1000) });
        }
      }
    } catch {}
  }

  return { messages, newOffset: lines.length };
}

function extractText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return '';
}

// --- LLM analysis ---
const ANALYSIS_PROMPT = `You are a session watcher. Analyze the conversation fragment below and extract ONLY genuinely important items. Be very selective — most conversations have nothing worth saving.

Extract:
- **corrections**: when the user corrects the assistant's approach or understanding (not just minor clarifications)
- **decisions**: explicit choices made during discussion that affect future work (not routine confirmations)
- **plans**: execution strategies or multi-step approaches that were agreed upon
- **documentation**: surprising platform behaviors, non-obvious constraints, or architectural insights that a future contributor wouldn't find without digging

Return JSON (no markdown, no explanation):
{
  "findings": [
    {"type": "correction|decision|plan|documentation", "summary": "one sentence, concise"}
  ]
}

If nothing important — return {"findings": []}.
Be strict: routine tool calls, file reads, standard operations are NOT findings.`;

function buildConversationText(messages) {
  return messages.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    return `${role}: ${m.text}`;
  }).join('\n\n');
}

function callLLM(conversationText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return callAPI(apiKey, conversationText);
  return callCLI(conversationText);
}

function callAPI(apiKey, conversationText) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: `${ANALYSIS_PROMPT}\n\n---\n\n${conversationText}`,
    }],
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '';
          resolve(parseFindings(text));
        } catch {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.setTimeout(15000, () => { req.destroy(); resolve([]); });
    req.write(body);
    req.end();
  });
}

function callCLI(conversationText) {
  try {
    const prompt = `${ANALYSIS_PROMPT}\n\n---\n\n${conversationText}`;
    const result = execSync(
      'claude -p --model claude-haiku-4-5-20251001 --output-format text --disable-slash-commands',
      { input: prompt, timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 }
    );
    return parseFindings(result);
  } catch {
    return [];
  }
}

function parseFindings(text) {
  try {
    // Extract JSON from response (may have markdown wrapper)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const json = JSON.parse(jsonMatch[0]);
    return json.findings || [];
  } catch {
    return [];
  }
}

// --- Save findings ---
function saveFindings(findings) {
  if (!findings.length) return;

  const memJs = findMemoryJs();

  if (!memJs) {
    // Fallback: write directly to notes
    const today = new Date().toISOString().slice(0, 10);
    const notesDir = path.join(memoryDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    const notePath = path.join(notesDir, `${today}.md`);
    const time = new Date().toTimeString().slice(0, 5);

    const entries = findings.map(f =>
      `- ${time} WATCH:${f.type} ${f.summary}`.slice(0, 200)
    ).join('\n');

    if (fs.existsSync(notePath)) {
      fs.appendFileSync(notePath, '\n' + entries + '\n');
    } else {
      fs.writeFileSync(notePath, `---\nname: Notes ${today}\ndescription: Session notes ${today}\ntype: project\n---\n\n# ${today}\n\n${entries}\n`);
    }
    return;
  }

  for (const f of findings) {
    const summary = (f.summary || '').replace(/"/g, '\\"').slice(0, 200);
    // documentation findings use DOC: prefix so /docs-reflect can collect them
    const label = f.type === 'documentation' ? 'DOC' : `WATCH:${f.type.toUpperCase()}`;
    try {
      execSync(
        `node "${memJs}" --dir="${memoryDir}" note "${label}: ${summary}"`,
        { timeout: 5000, stdio: 'ignore' }
      );
    } catch {}
  }
}

function findMemoryJs() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    const p = path.join(pluginRoot, 'scripts', 'memory.js');
    if (fs.existsSync(p)) return p;
  }
  const sibling = path.join(__dirname, 'memory.js');
  if (fs.existsSync(sibling)) return sibling;
  const local = path.join(memoryDir, 'memory.js');
  if (fs.existsSync(local)) return local;
  return null;
}

// --- Main ---
async function main() {
  const state = loadState();
  const now = Date.now();

  // Throttle
  if (now - state.lastRun < THROTTLE_MS) {
    process.exit(0);
  }

  // Find transcript
  const transcriptPath = findTranscript();
  if (!transcriptPath) process.exit(0);

  // Reset offset if transcript changed
  const offset = (transcriptPath === state.transcriptPath) ? state.offset : 0;

  // Read new messages
  const { messages, newOffset } = readNewMessages(transcriptPath, offset);

  // Save state early
  saveState({
    offset: newOffset,
    lastRun: now,
    transcriptPath,
  });

  // Need minimum messages to analyze
  if (messages.length < MIN_NEW_MESSAGES) {
    process.exit(0);
  }

  // Analyze with LLM
  const conversationText = buildConversationText(messages);
  const findings = await callLLM(conversationText);

  if (findings && findings.length) {
    saveFindings(findings);
    process.stderr.write(`[watcher] ${findings.length} finding(s): ${findings.map(f => `${f.type}: ${f.summary}`).join('; ')}\n`);
  }
}

main().catch(() => process.exit(0));
