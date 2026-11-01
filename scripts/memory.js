#!/usr/bin/env node

/**
 * Memory API — on-demand context loading from memory/
 *
 * Usage:
 *   node memory.js search <query>                                    — search across all files
 *   node memory.js recent [n]                                        — last N feedback files (default: 5)
 *   node memory.js workstream <name>                                 — all files related to a workstream
 *   node memory.js workstreams                                       — list workstreams with per-ws handoff dates
 *   node memory.js add-workstream <name> <keywords...>               — create/update workstream
 *   node memory.js remove-workstream <name>                          — remove workstream
 *   node memory.js decisions [topic]                                 — decisions (Why/How to apply blocks)
 *   node memory.js list [type]                                       — list files (workstreams|feedback|decisions|profile|reference|notes|all)
 *   node memory.js note <text>                                       — daily note (SESSION_* markers auto-routed to sessions.log)
 *   node memory.js docs [--all|--mark-reviewed]                      — DOC: notes since the last review (--all: every one)
 *   node memory.js findings                                          — collect WATCH: entries (auto-captured decisions/plans/corrections)
 *   node memory.js recurring                                         — recurring feedback patterns
 *   node memory.js reindex                                           — rebuild MEMORY.md index sorted by weight
 *   node memory.js health                                            — dead links, stale, size, dupes
 *   node memory.js classify --items=<json>                           — keyword-route items by workstreams.json (multi-label, JSON in/out)
 *   node memory.js session-activity                                  — current session items since last SESSION_START (JSON)
 *   node memory.js session-changes                                   — git commits + files since session start (JSON)
 *   node memory.js receipt [--json]                                  — what this session left: memory files, logged items, workstreams moved
 *   node memory.js handoff [<workstream>]                            — print per-ws handoff if exists, else global, else NO_HANDOFF
 *   node memory.js write-handoff --workstream=<name>|--global --content=<f> — write workstreams/<name>/handoff.md (stamps modified + branch)
 *   node memory.js card <workstream> [--material]                    — workstream card, else NO_CARD (--material: + decisions to draft or update it from)
 *   node memory.js write-card --workstream=<name> --content=<f>      — write workstreams/<name>.md
 *   node memory.js park --title=<t> --content=<f> [--workstream=<name>] [--kind=idea|task|question] — park with context (one file per item)
 *   node memory.js parked [<workstream>]                             — parked items, oldest flagged, plus recent PARKED: notes
 *   node memory.js unpark <file> --to=<where>                        — the exit: remove a parked item, note where it went
 *   node memory.js unassigned [--days=30]                            — decisions that match no workstream, by day
 *   node memory.js signals [--branch=<b>]                            — invitations (card gaps, new workstream, parked, DOC) for SessionStart (JSON)
 *   node memory.js dir                                               — memory directory path
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadSchema, calculateWeight, incrementHits, rebuildIndex, ORIGIN } = require('./lib/weight');
const log = require('./lib/log');

// Resolve memory dir: --dir=<path> → symlink location (memory/memory.js → plugin)
// → project memory found from cwd. Never __dirname: Node resolves symlinks,
// so __dirname points into the plugin repo and notes would land in scripts/.
const { findMemoryDir } = require('./lib/find-memory-dir');
function resolveMemoryDir() {
    const dirArg = process.argv.find(a => a.startsWith('--dir='));
    if (dirArg) {
        const dir = dirArg.slice('--dir='.length);
        if (!dir) {
            console.error('memory.js: empty --dir= (memory dir not resolved?)');
            process.exit(1);
        }
        return { dir, exists: true };
    }
    const invokedDir = path.dirname(path.resolve(process.argv[1] || ''));
    if (invokedDir !== __dirname && fs.existsSync(path.join(invokedDir, 'MEMORY.md'))) {
        return { dir: invokedDir, exists: true };
    }
    return findMemoryDir();
}
const RESOLVED = resolveMemoryDir();
const MEMORY_DIR = RESOLVED.dir;
const IGNORE = ['MEMORY.md', 'memory.js'];
const DIRS = {
    workstreams: path.join(MEMORY_DIR, 'workstreams'),
    feedback: path.join(MEMORY_DIR, 'feedback'),
    decisions: path.join(MEMORY_DIR, 'decisions'),
    profile: path.join(MEMORY_DIR, 'profile'),
    reference: path.join(MEMORY_DIR, 'reference'),
    notes: path.join(MEMORY_DIR, 'notes'),
};

// Load workstreams from workstreams.json (created by /memory-init)
const workstreamsPath = path.join(MEMORY_DIR, 'workstreams.json');
let WORKSTREAM_ALIASES = {};
try {
    if (fs.existsSync(workstreamsPath)) {
        WORKSTREAM_ALIASES = JSON.parse(fs.readFileSync(workstreamsPath, 'utf-8'));
    }
} catch (e) {
    log.warn('workstreams.json corrupted, using empty aliases', { path: workstreamsPath, error: e.message });
}

// --- Core ---

function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const result = {};
    match[1].split('\n').forEach(line => {
        const [key, ...val] = line.split(':');
        if (key && val.length) result[key.trim()] = val.join(':').trim();
    });
    return result;
}

function getBody(content) {
    return content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
}

function getAllFiles(dir) {
    const searchDir = dir || MEMORY_DIR;
    const results = [];

    for (const entry of fs.readdirSync(searchDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('memory-backup')) {
            results.push(...getAllFiles(path.join(searchDir, entry.name)));
        } else if (entry.isFile() && entry.name.endsWith('.md') && !IGNORE.includes(entry.name)) {
            const fullPath = path.join(searchDir, entry.name);
            const stat = fs.statSync(fullPath);
            const content = fs.readFileSync(fullPath, 'utf-8');
            const frontmatter = parseFrontmatter(content);
            const rel = path.relative(MEMORY_DIR, fullPath);
            results.push({ name: rel, path: fullPath, content, frontmatter, mtime: stat.mtime });
        }
    }
    return results;
}

function getFilesFromDir(dirName) {
    const dir = DIRS[dirName];
    if (!dir || !fs.existsSync(dir)) return [];
    return getAllFiles(dir);
}

// --- Queries (return data, don't print) ---

function querySearch(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    return getAllFiles()
        .filter(f => f.content.toLowerCase().includes(q))
        .map(f => {
            const lines = f.content.split('\n');
            const matches = lines
                .map((l, i) => ({ line: i + 1, text: l }))
                .filter(l => l.text.toLowerCase().includes(q));
            return { name: f.name, type: f.frontmatter.type, matches: matches.slice(0, 3) };
        });
}

function queryRecent(n = 5) {
    return getFilesFromDir('feedback')
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, Number(n));
}

function queryWorkstream(name) {
    if (!name) return [];
    const q = name.toLowerCase();
    const keywords = [].concat(WORKSTREAM_ALIASES[q] || q);
    return getAllFiles()
        .filter(f => keywords.some(k =>
            f.name.toLowerCase().includes(k) || f.content.toLowerCase().includes(k)
        ))
        .sort((a, b) => b.mtime - a.mtime);
}

function queryDecisions(topic) {
    const files = [...getFilesFromDir('decisions'), ...getFilesFromDir('feedback'), ...getFilesFromDir('workstreams')];
    return files.filter(f => {
        const body = getBody(f.content);
        if (!body.includes('**Why:**') && !body.includes('**How to apply:**')) return false;
        if (topic && !f.content.toLowerCase().includes(topic.toLowerCase())) return false;
        return true;
    });
}

function queryList(type = 'all') {
    const files = type === 'all'
        ? getAllFiles()
        : (DIRS[type] ? getFilesFromDir(type) : getAllFiles().filter(f => f.frontmatter.type === type));
    return files.sort((a, b) => b.mtime - a.mtime);
}

// --- Flags parser ---

function parseFlags(args) {
    const flags = { brief: false, only: null };
    const positional = [];
    for (const arg of args) {
        if (arg === '--brief') flags.brief = true;
        else if (arg.startsWith('--only=')) flags.only = arg.slice(7).split(',');
        else if (arg.startsWith('--dir=')) { /* already handled */ }
        else positional.push(arg);
    }
    return { flags, positional };
}

function filterByDirs(files, dirs) {
    if (!dirs) return files;
    return files.filter(f => dirs.some(d => f.name.startsWith(d + '/')));
}

// --- Hit tracking ---

function trackHits(files) {
    for (const f of files) {
        if (f.path) incrementHits(f.path);
    }
}

// --- CLI output ---

function printSearch(query) {
    const results = querySearch(query);
    if (!query) return console.log('Usage: memory.js search <query>');
    if (!results.length) return console.log(`Nothing found for "${query}"`);
    trackHits(results.map(r => ({ path: path.join(MEMORY_DIR, r.name) })));
    results.forEach(r => {
        console.log(`\n## ${r.name} (${r.type || '?'})`);
        r.matches.forEach(m => console.log(`  L${m.line}: ${m.text.trim()}`));
    });
}

function printRecent(n = 5) {
    const files = queryRecent(n);
    if (!files.length) return console.log('No feedback files found');
    trackHits(files);
    files.forEach(f => {
        const desc = f.frontmatter.description || '';
        const date = f.mtime.toISOString().slice(0, 10);
        console.log(`\n## ${f.name} (${date})`);
        console.log(desc);
        console.log(getBody(f.content).split('\n').slice(0, 5).join('\n'));
    });
}

function printWorkstream(...args) {
    const { flags, positional } = parseFlags(args);
    const name = positional[0];
    if (!name) return console.log('Usage: memory.js workstream <name> [--brief] [--only=decisions,feedback]');
    let files = queryWorkstream(name);
    files = filterByDirs(files, flags.only);
    if (!files.length) return console.log(`No files found for workstream "${name}"${flags.only ? ` (only: ${flags.only})` : ''}`);
    trackHits(files);
    console.log(`\n# Workstream: ${name} (${files.length} files)\n`);
    files.forEach(f => {
        const type = f.frontmatter.type || '?';
        const desc = f.frontmatter.description || '';
        console.log(`## ${f.name} (${type})`);
        console.log(desc);
        if (!flags.brief) {
            console.log(getBody(f.content).split('\n').slice(0, 8).join('\n'));
        }
        console.log('');
    });
}

function printDecisions(...args) {
    const { flags, positional } = parseFlags(args);
    const topic = positional[0];
    const results = queryDecisions(topic);
    if (!results.length) return console.log(`No decisions found${topic ? ` for "${topic}"` : ''}`);
    trackHits(results);
    console.log(`\n# Decisions${topic ? `: ${topic}` : ''} (${results.length})\n`);
    results.forEach(r => {
        console.log(`## ${r.name} (${r.frontmatter.type})`);
        console.log(r.frontmatter.description);
        if (!flags.brief) {
            const body = getBody(r.content);
            console.log(body.split('\n').slice(0, 10).join('\n'));
        }
        console.log('');
    });
}

function printList(type = 'all') {
    const files = queryList(type);
    const grouped = {};
    files.forEach(f => {
        const dir = path.dirname(f.name);
        const t = dir === '.' ? 'root' : dir;
        if (!grouped[t]) grouped[t] = [];
        grouped[t].push(f);
    });

    Object.entries(grouped).forEach(([t, items]) => {
        console.log(`\n## ${t} (${items.length})`);
        items.forEach(f => {
            const date = f.mtime.toISOString().slice(0, 10);
            console.log(`  ${date}  ${f.name}  — ${f.frontmatter.description || ''}`);
        });
    });
}

// --- Note ---

const SESSION_LOG_PREFIXES = ['SESSION_START', 'SESSION_END', 'NEW_WORKSTREAM'];

function note(...words) {
    const text = words.join(' ');
    if (!text) return console.log('Usage: memory.js note <text>\nExample: memory.js note "auth: switched to JWT for stateless sessions"');

    const time = new Date().toTimeString().slice(0, 5);
    const today = new Date().toISOString().slice(0, 10);
    const isSessionMarker = SESSION_LOG_PREFIXES.some(p => text.startsWith(p));

    if (isSessionMarker) {
        const logPath = path.join(MEMORY_DIR, 'sessions.log');
        fs.appendFileSync(logPath, `${today} ${time} ${text}\n`);
        return console.log(`Logged to sessions.log`);
    }

    const notesDir = DIRS.notes;
    if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });

    const filePath = path.join(notesDir, `${today}.md`);
    const entry = `- ${time} ${text}\n`;

    if (fs.existsSync(filePath)) {
        fs.appendFileSync(filePath, entry);
    } else {
        const header = `---\nname: Notes ${today}\ndescription: Session notes ${today}\ntype: project\norigin: memory-toolkit\n---\n\n# ${today}\n\n`;
        fs.writeFileSync(filePath, header + entry);
    }

    console.log(`Saved to notes/${today}.md`);
}

// --- Docs ---

// /docs-reflect ends with a DOCS_REVIEWED note; `docs` lists only DOC: notes after
// the last one, so each run sees what is new. `docs --all` ignores the marker.
const DOCS_REVIEWED = 'DOCS_REVIEWED';
// "testing — insight": the domain is one word. A sentence that just contains
// a dash (watcher findings) stays whole under "general".
const DOC_DOMAIN = /^[\p{L}\p{N}_-]{1,30}$/u;

function queryDocs({ all = false } = {}) {
    const notesDir = DIRS.notes;
    if (!notesDir || !fs.existsSync(notesDir)) return { docs: [], reviewedAt: null };

    let results = [];
    let reviewedAt = null;
    for (const entry of fs.readdirSync(notesDir).sort()) {
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(notesDir, entry);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const date = entry.replace('.md', '');
        for (const line of lines) {
            const reviewed = line.match(/^- (\d{2}:\d{2}) DOCS_REVIEWED\b/);
            if (reviewed) {
                reviewedAt = `${date} ${reviewed[1]}`;
                if (!all) results = [];
                continue;
            }
            const match = line.match(/^- (\d{2}:\d{2}) DOC:\s*(.+)$/);
            if (match) {
                const [, time, text] = match;
                const dashIdx = text.indexOf(' — ');
                const head = dashIdx >= 0 ? text.slice(0, dashIdx).trim() : '';
                const domain = DOC_DOMAIN.test(head) ? head : 'general';
                const insight = domain === head ? text.slice(dashIdx + 3).trim() : text.trim();
                results.push({ date, time, domain, insight, raw: text });
            }
        }
    }
    return { docs: results, reviewedAt };
}

function printDocs(...args) {
    if (args.includes('--mark-reviewed')) return note(DOCS_REVIEWED);
    const all = args.includes('--all');
    const { docs, reviewedAt } = queryDocs({ all });
    const since = reviewedAt && !all ? ` since the last review (${reviewedAt})` : '';
    if (!docs.length) return console.log(`No DOC: notes${since}. Use: memory.js note "DOC: domain — insight"`);

    // Group by domain
    const grouped = {};
    for (const d of docs) {
        if (!grouped[d.domain]) grouped[d.domain] = [];
        grouped[d.domain].push(d);
    }

    console.log(`\n# DOC notes${since} (${docs.length})\n`);
    for (const [domain, items] of Object.entries(grouped).sort()) {
        console.log(`## ${domain} (${items.length})`);
        for (const item of items) {
            console.log(`  ${item.date} ${item.time}  ${item.insight}`);
        }
        console.log('');
    }
}

// --- Watcher findings (WATCH:DECISION / PLAN / CORRECTION / PHASE) ---

function queryWatchFindings() {
    const notesDir = DIRS.notes;
    if (!notesDir || !fs.existsSync(notesDir)) return [];

    const results = [];
    for (const entry of fs.readdirSync(notesDir).sort()) {
        if (!entry.endsWith('.md')) continue;
        const content = fs.readFileSync(path.join(notesDir, entry), 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.match(/^- (\d{2}:\d{2}) WATCH:([A-Z]+):?\s*(.+)$/);
            if (!match) continue;
            const [, time, type, text] = match;
            results.push({
                date: entry.replace('.md', ''),
                time,
                type: type.toLowerCase(),
                text: text.trim(),
            });
        }
    }
    return results;
}

function printWatchFindings() {
    const findings = queryWatchFindings();
    if (!findings.length) {
        return console.log('No watcher findings. Either watcher is off or this session had no captures.');
    }

    const grouped = {};
    for (const f of findings) {
        if (!grouped[f.type]) grouped[f.type] = [];
        grouped[f.type].push(f);
    }

    console.log(`\n# Watcher findings (${findings.length})\n`);
    for (const [type, items] of Object.entries(grouped).sort()) {
        console.log(`## ${type} (${items.length})`);
        for (const item of items) {
            console.log(`  ${item.date} ${item.time}  ${item.text}`);
        }
        console.log('');
    }
}

// --- Recurring feedback detection ---

function queryRecurring(minCount = 2) {
    const feedbackFiles = getFilesFromDir('feedback');
    if (!feedbackFiles.length) return [];

    // Extract keywords from each feedback file (name + description + body first line)
    const entries = feedbackFiles.map(f => {
        const body = getBody(f.content);
        const firstLine = body.split('\n')[0] || '';
        const desc = f.frontmatter.description || '';
        const tokens = `${f.name} ${desc} ${firstLine}`.toLowerCase()
            .replace(/[^a-z0-9а-яё\s-]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 3);
        return { file: f, tokens: new Set(tokens), desc, firstLine };
    });

    // Find clusters: files that share significant keyword overlap
    const clusters = [];
    const used = new Set();

    for (let i = 0; i < entries.length; i++) {
        if (used.has(i)) continue;
        const cluster = [entries[i]];
        used.add(i);

        for (let j = i + 1; j < entries.length; j++) {
            if (used.has(j)) continue;
            // Count shared tokens
            let shared = 0;
            for (const t of entries[i].tokens) {
                if (entries[j].tokens.has(t)) shared++;
            }
            const minSize = Math.min(entries[i].tokens.size, entries[j].tokens.size);
            // At least 2 shared tokens and >30% overlap
            if (shared >= 2 && minSize > 0 && shared / minSize > 0.3) {
                cluster.push(entries[j]);
                used.add(j);
            }
        }

        if (cluster.length >= minCount) {
            // Find common tokens
            const commonTokens = [...cluster[0].tokens].filter(t =>
                cluster.every(c => c.tokens.has(t))
            );
            clusters.push({
                count: cluster.length,
                files: cluster.map(c => c.file.name),
                topic: commonTokens.slice(0, 5).join(', ') || cluster[0].desc,
                descriptions: cluster.map(c => c.desc || c.firstLine),
            });
        }
    }

    return clusters.sort((a, b) => b.count - a.count);
}

function printRecurring() {
    const clusters = queryRecurring();
    if (!clusters.length) return console.log('No recurring feedback patterns found.');

    console.log(`\n# Recurring feedback (${clusters.length} patterns)\n`);
    for (const c of clusters) {
        console.log(`## "${c.topic}" (×${c.count})`);
        console.log(`  Files: ${c.files.join(', ')}`);
        for (const desc of c.descriptions) {
            console.log(`  - ${desc}`);
        }
        console.log(`  → Candidate for promotion to .claude/rules/`);
        console.log('');
    }
}

// --- Workstream management ---

function addWorkstream(name, ...keywords) {
    if (!name) return console.log('Usage: memory.js add-workstream <name> <keyword1> <keyword2> ...');

    const data = fs.existsSync(workstreamsPath)
        ? JSON.parse(fs.readFileSync(workstreamsPath, 'utf-8'))
        : {};

    if (data[name]) {
        // Merge keywords
        const existing = new Set(data[name]);
        keywords.forEach(k => existing.add(k));
        data[name] = [...existing];
        console.log(`Updated workstream "${name}": ${data[name].join(', ')}`);
    } else {
        data[name] = keywords.length ? keywords : [name];
        console.log(`Created workstream "${name}": ${data[name].join(', ')}`);
    }

    fs.writeFileSync(workstreamsPath, JSON.stringify(data, null, 2));

    // Create workstream dir
    const wsDir = path.join(MEMORY_DIR, 'workstreams');
    if (!fs.existsSync(wsDir)) fs.mkdirSync(wsDir, { recursive: true });
}

function removeWorkstream(name) {
    if (!name) return console.log('Usage: memory.js remove-workstream <name>');
    if (!fs.existsSync(workstreamsPath)) return console.log('No workstreams.json found');

    const data = JSON.parse(fs.readFileSync(workstreamsPath, 'utf-8'));
    if (!data[name]) return console.log(`Workstream "${name}" not found`);

    delete data[name];
    fs.writeFileSync(workstreamsPath, JSON.stringify(data, null, 2));
    console.log(`Removed workstream "${name}"`);
}

function listWorkstreams() {
    if (!fs.existsSync(workstreamsPath)) return console.log('No workstreams configured. Use: memory.js add-workstream <name> <keywords...>');

    const data = JSON.parse(fs.readFileSync(workstreamsPath, 'utf-8'));
    const entries = Object.entries(data);
    if (!entries.length) return console.log('No workstreams configured.');

    const schema = loadSchema(MEMORY_DIR);
    const weightConfig = schema.weight || {};

    const enriched = entries.map(([name, keywords]) => {
        const files = queryWorkstream(name);
        const lastTouched = files.length ? files[0].mtime : null;
        const perWsHandoffPath = path.join(MEMORY_DIR, 'workstreams', name, 'handoff.md');
        const globalHandoffPath = path.join(MEMORY_DIR, 'workstreams', 'handoff.md');
        let handoff = null;
        if (fs.existsSync(perWsHandoffPath)) {
            handoff = { mtime: fs.statSync(perWsHandoffPath).mtime, source: 'per-workstream' };
        } else if (fs.existsSync(globalHandoffPath)) {
            handoff = { mtime: fs.statSync(globalHandoffPath).mtime, source: 'global' };
        }
        const weights = files.map(f => calculateWeight(f, weightConfig)).sort((a, b) => b - a);
        const score = weights.slice(0, 5).reduce((sum, w) => sum + w, 0);
        const card = readCard(name);
        return { name, keywords, files, lastTouched, handoff, score, card };
    });

    enriched.sort((a, b) => b.score - a.score);

    console.log('\nWorkstreams (sorted by top-5 weight concentration):\n');
    enriched.forEach(({ name, keywords, files, lastTouched, handoff, score, card }, i) => {
        const lastDate = lastTouched ? lastTouched.toISOString().slice(0, 10) : '—';
        const handoffDate = handoff ? handoff.mtime.toISOString().slice(0, 10) : null;
        const handoffLabel = handoff ? `, handoff: ${handoffDate}${handoff.source === 'global' ? ' (global)' : ''}` : '';
        const cardLabel = card ? `, card: ${card.updated}` : ', no card';
        console.log(`  ${i + 1}. ${name} — ${files.length} files, score: ${score.toFixed(1)}, last touched: ${lastDate}${handoffLabel}${cardLabel}`);
        console.log(`     keywords: ${keywords.join(', ')}`);
    });
    console.log(`\n  ➕ Add new: memory.js add-workstream <name> <keywords...>`);
}

// --- Reindex ---

function reindex() {
    const memoryMdPath = path.join(MEMORY_DIR, 'MEMORY.md');
    if (!fs.existsSync(memoryMdPath)) return console.log('No MEMORY.md found');

    const content = fs.readFileSync(memoryMdPath, 'utf-8');
    const schema = loadSchema(MEMORY_DIR);

    // Weight function: resolve relative path → file → calculate weight
    function getFileWeight(relativePath) {
        const fullPath = path.join(MEMORY_DIR, relativePath);
        if (!fs.existsSync(fullPath)) return 0;
        try {
            const fileContent = fs.readFileSync(fullPath, 'utf-8');
            const fm = parseFrontmatter(fileContent);
            const stat = fs.statSync(fullPath);
            return calculateWeight({ frontmatter: fm, mtime: stat.mtime }, schema.weight);
        } catch (e) {
            log.debug('weight calc failed', { file: fullPath, error: e.message });
            return 0;
        }
    }

    // Durable memory only: notes, cards and parked items reach the session other ways
    const sectionFor = { feedback: 'Feedback', reference: 'Reference', decisions: 'Backlog', project: 'Backlog' };
    const discovered = getAllFiles()
        .filter(f => sectionFor[f.name.split(/[\\/]/)[0]])
        .map(f => {
            const rel = f.name.split(path.sep).join('/');
            const title = (f.frontmatter.name || path.basename(rel, '.md')).replace(/^"(.*)"$/, '$1');
            const desc = (f.frontmatter.description || '').replace(/^"(.*)"$/, '$1');
            const short = desc.length > 150 ? `${desc.slice(0, 149)}…` : desc;
            return { path: rel, section: sectionFor[rel.split('/')[0]], line: `- [${title}](${rel})${short ? ` — ${short}` : ''}` };
        });

    const headings = Object.fromEntries((schema.sections || []).map(s => [s.name, s.heading]));
    const added = discovered.filter(d => !content.includes(`](${d.path})`)
        && content.split('\n').some(l => l.trimEnd() === headings[d.section])).length;
    const linesBefore = content.split('\n').length;
    const rebuilt = rebuildIndex(content, schema, getFileWeight, discovered);
    const linesAfter = rebuilt.split('\n').length;

    // Atomic write
    const tmp = memoryMdPath + '.tmp';
    fs.writeFileSync(tmp, rebuilt, 'utf-8');
    fs.renameSync(tmp, memoryMdPath);

    const evicted = linesBefore + added - linesAfter;
    console.log(`Reindexed MEMORY.md: ${linesAfter} lines${added > 0 ? `, ${added} new file(s) added` : ''}${evicted > 0 ? ` (${evicted} low-weight entries evicted)` : ''}`);
}

// --- Health check ---

const STALE_DAYS = 30;
const MEMORY_MD_WARN_LINES = 150;
const MEMORY_MD_MAX_LINES = 200;

function health() {
    const issues = [];
    const memoryMdPath = path.join(MEMORY_DIR, 'MEMORY.md');

    // 1. MEMORY.md size
    if (fs.existsSync(memoryMdPath)) {
        const lines = fs.readFileSync(memoryMdPath, 'utf-8').split('\n').length;
        if (lines > MEMORY_MD_MAX_LINES) {
            issues.push({ level: 'error', check: 'size', message: `MEMORY.md is ${lines} lines (max ${MEMORY_MD_MAX_LINES}). Run: memory.js reindex` });
        } else if (lines > MEMORY_MD_WARN_LINES) {
            issues.push({ level: 'warn', check: 'size', message: `MEMORY.md is ${lines}/${MEMORY_MD_MAX_LINES} lines. Consider trimming.` });
        }

        // 2. Dead links in MEMORY.md
        const content = fs.readFileSync(memoryMdPath, 'utf-8');
        const linkPattern = /\[.*?\]\((.*?\.md)\)/g;
        let match;
        while ((match = linkPattern.exec(content)) !== null) {
            const linkPath = match[1];
            const fullPath = path.join(MEMORY_DIR, linkPath);
            if (!fs.existsSync(fullPath)) {
                issues.push({ level: 'error', check: 'dead-link', message: `Dead link in MEMORY.md: ${linkPath}` });
            }
        }
    } else {
        issues.push({ level: 'warn', check: 'missing', message: 'No MEMORY.md found. Run: memory.js reindex' });
    }

    // 3. Stale files
    const now = Date.now();
    const staleCutoff = now - STALE_DAYS * 24 * 60 * 60 * 1000;
    const allFiles = getAllFiles();
    const staleFiles = [];
    for (const f of allFiles) {
        try {
            const stat = fs.statSync(f.path);
            if (stat.mtime.getTime() < staleCutoff) {
                staleFiles.push(f);
            }
        } catch {}
    }
    if (staleFiles.length > 0) {
        issues.push({
            level: 'info',
            check: 'stale',
            message: `${staleFiles.length} file(s) older than ${STALE_DAYS} days`,
            files: staleFiles.map(f => path.relative(MEMORY_DIR, f.path)),
        });
    }

    // 4. Duplicate descriptions
    const descMap = new Map();
    for (const f of allFiles) {
        const desc = (f.frontmatter.description || '').toLowerCase().trim();
        if (!desc) continue;
        if (descMap.has(desc)) {
            descMap.get(desc).push(path.relative(MEMORY_DIR, f.path));
        } else {
            descMap.set(desc, [path.relative(MEMORY_DIR, f.path)]);
        }
    }
    for (const [desc, files] of descMap) {
        if (files.length > 1) {
            issues.push({ level: 'warn', check: 'duplicate', message: `Duplicate description: "${desc.slice(0, 60)}" in ${files.join(', ')}` });
        }
    }

    // 5. Workstreams staleness
    if (fs.existsSync(workstreamsPath)) {
        try {
            const stat = fs.statSync(workstreamsPath);
            const daysSinceUpdate = Math.floor((now - stat.mtime.getTime()) / (24 * 60 * 60 * 1000));
            if (daysSinceUpdate > STALE_DAYS) {
                issues.push({ level: 'info', check: 'workstreams-stale', message: `workstreams.json not updated in ${daysSinceUpdate} days` });
            }
        } catch {}
    }

    // 7. A card past its size stops being read whole
    for (const ws of Object.keys(WORKSTREAM_ALIASES)) {
        const card = readCard(ws);
        if (!card) continue;
        const lines = getBody(card.content).split('\n').length;
        if (lines > CARD_MAX_LINES) {
            issues.push({ level: 'warn', check: 'card-size', message: `workstreams/${ws}.md is ${lines} lines (max ${CARD_MAX_LINES}): move finished iterations out, keep what is current` });
        }
    }

    // 6. Session-watcher parse error rate
    const watcherStatePath = path.join(MEMORY_DIR, '.watcher-state.json');
    if (fs.existsSync(watcherStatePath)) {
        try {
            const ws = JSON.parse(fs.readFileSync(watcherStatePath, 'utf-8'));
            const parseErrors = ws.parseErrors || 0;
            const cliErrors = ws.cliErrors || 0;
            const findingsCount = ws.findingsCount || 0;
            const total = parseErrors + findingsCount;
            const ratio = total > 0 ? parseErrors / total : 0;
            const perSession = 'cliErrors' in ws;
            if (perSession && parseErrors > 5 && ratio > 0.5) {
                const lastErr = ws.lastParseError ? ` (last: ${ws.lastParseError})` : '';
                issues.push({
                    level: 'warn',
                    check: 'watcher-parse-errors',
                    message: `session-watcher: ${parseErrors} parse errors vs ${findingsCount} findings this session (${Math.round(ratio * 100)}%)${lastErr}`,
                });
            }
            if (cliErrors > 5) {
                issues.push({
                    level: 'warn',
                    check: 'watcher-cli-errors',
                    message: `session-watcher: ${cliErrors} CLI/network failures this session (timeout, exit code or no network)`,
                });
            }
        } catch {}
    }

    // Output
    if (issues.length === 0) {
        console.log('✓ Memory healthy — no issues found');
        return issues;
    }

    const errors = issues.filter(i => i.level === 'error');
    const warns = issues.filter(i => i.level === 'warn');
    const infos = issues.filter(i => i.level === 'info');

    if (errors.length) {
        console.log(`\n✗ ${errors.length} error(s):`);
        errors.forEach(i => console.log(`  - ${i.message}`));
    }
    if (warns.length) {
        console.log(`\n⚠ ${warns.length} warning(s):`);
        warns.forEach(i => console.log(`  - ${i.message}`));
    }
    if (infos.length) {
        console.log(`\nℹ ${infos.length} info:`);
        const brief = process.argv.includes('--brief');
        infos.forEach(i => {
            console.log(`  - ${i.message}`);
            if (i.files && !brief) i.files.forEach(f => console.log(`      ${f}`));
        });
    }

    console.log(`\nTotal: ${errors.length} errors, ${warns.length} warnings, ${infos.length} info`);
    return issues;
}

// --- Classify ---

// Workstreams whose keywords occur in the text (case-insensitive, multi-label).
// A keyword is a word, not a substring: "doc" must not take "documentation", nor
// "repo" take "report" — substrings sent most of a project's decisions to whichever
// workstream had a short keyword. English endings (docs, hooks, parked) still match;
// a Cyrillic keyword matches as a word start, to cover case endings.
const keywordPatterns = new Map();
function keywordPattern(keyword) {
    const k = String(keyword).toLowerCase();
    if (!keywordPatterns.has(k)) {
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const tail = /\p{Script=Cyrillic}/u.test(k) ? '' : '(?:s|es|ed|ing)?(?![\\p{L}\\p{N}])';
        keywordPatterns.set(k, new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${tail}`, 'iu'));
    }
    return keywordPatterns.get(k);
}

function matchWorkstreams(text) {
    const s = String(text);
    return Object.entries(WORKSTREAM_ALIASES)
        .filter(([, keywords]) => [].concat(keywords || []).some(k => k && keywordPattern(k).test(s)))
        .map(([ws]) => ws);
}

function classifyItems(items) {
    const buckets = {};
    const unassigned = [];

    for (const raw of items) {
        const item = String(raw);
        const hits = matchWorkstreams(item);
        if (hits.length === 0) {
            unassigned.push(item);
        } else {
            for (const ws of hits) {
                if (!buckets[ws]) buckets[ws] = [];
                buckets[ws].push(item);
            }
        }
    }

    return { ...buckets, _unassigned: unassigned };
}

function classify(...args) {
    const itemsArg = args.find(a => a && a.startsWith('--items='));
    if (!itemsArg) {
        console.log('Usage: memory.js classify --items=<path-to-json>');
        console.log('  items.json: array of strings');
        console.log('  output: JSON { "<workstream>": [items...], "_unassigned": [...] }');
        return;
    }
    const itemsPath = itemsArg.slice('--items='.length);
    let items;
    try {
        items = JSON.parse(fs.readFileSync(itemsPath, 'utf-8'));
    } catch (e) {
        console.error(`Failed to read items: ${e.message}`);
        process.exit(1);
    }
    if (!Array.isArray(items)) {
        console.error('items file must contain a JSON array of strings');
        process.exit(1);
    }
    console.log(JSON.stringify(classifyItems(items), null, 2));
}

// --- Workstream cards ---

// workstreams/<ws>.md is a living card: what the workstream is (a task, an experiment,
// an area), why, what it doesn't do, where results live, what's open. The model keeps
// it current during work and drafts it from decisions sessions already logged
// (WATCH:DECISION/CORRECTION, REFLECT). In tms such cards carried the context, not
// ritual handoffs: /session-start ran in 3 of 525 sessions (decisions/value-in-the-moment).
const CARD_MAX_LINES = 150;
const CARD_MATERIAL_LIMIT = 60;
// SessionStart signals, calibrated on real memory 2026-10-24: a one-off session
// leaves too few decisions, or all on one day, to suggest anything.
const SIGNAL_WINDOW_DAYS = 30;
const CARD_MIN_DECISIONS = 8;
const CARD_MIN_RECENT = 3;
const CARD_BEHIND_DECISIONS = 5;
const NEW_WORKSTREAM_MIN_ITEMS = 10;
const NEW_WORKSTREAM_MIN_DAYS = 3;
const DOCS_PENDING_MIN = 5;
// Invitations go to the user, and the hook that shows one logs `OFFERED: <key>`:
// the same key is not shown again for two weeks. A week of tms sessions showed the
// model ignores "offer at a natural pause", so this does not rely on it.
const OFFER_PAUSE_DAYS = 14;

function readCard(ws) {
    const file = path.join(MEMORY_DIR, 'workstreams', `${ws}.md`);
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf-8');
    // `modified` (memory.js and CC's stamper set it), else mtime — which hits bump
    const modified = Date.parse(parseFrontmatter(content).modified);
    const updated = new Date(Number.isNaN(modified) ? fs.statSync(file).mtimeMs : modified).toISOString().slice(0, 10);
    return { file, content, updated };
}

function queryDecisionLog() {
    const notesDir = DIRS.notes;
    if (!notesDir || !fs.existsSync(notesDir)) return [];

    const results = [];
    for (const entry of fs.readdirSync(notesDir).sort()) {
        if (!entry.endsWith('.md')) continue;
        const date = entry.replace('.md', '');
        for (const line of fs.readFileSync(path.join(notesDir, entry), 'utf-8').split('\n')) {
            const match = line.match(/^- (\d{2}:\d{2}) (?:WATCH:(DECISION|CORRECTION)|(REFLECT)):?\s*(.+)$/);
            if (match) results.push({ date, time: match[1], kind: (match[2] || match[3]).toLowerCase(), text: match[4].trim() });
        }
    }
    return results;
}

// Keys of invitations shown in the last OFFER_PAUSE_DAYS (`OFFERED: key key …` notes)
function recentOffers() {
    const notesDir = DIRS.notes;
    const keys = new Set();
    if (!notesDir || !fs.existsSync(notesDir)) return keys;
    const since = daysAgo(OFFER_PAUSE_DAYS);
    for (const entry of fs.readdirSync(notesDir).filter(f => f.endsWith('.md') && f >= since)) {
        for (const m of fs.readFileSync(path.join(notesDir, entry), 'utf-8').matchAll(/^- \d{2}:\d{2} OFFERED: (.+)$/gm)) {
            for (const key of m[1].trim().split(/\s+/)) keys.add(key);
        }
    }
    return keys;
}

function daysAgo(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function printCard(...args) {
    const ws = (args.find(a => a && !a.startsWith('--')) || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(ws)) {
        console.error('Usage: memory.js card <workstream> [--material]');
        process.exit(1);
    }
    const card = readCard(ws);
    if (!args.includes('--material')) {
        if (!card) return console.log('NO_CARD');
        return process.stdout.write(card.content);
    }

    const decisions = queryDecisionLog().filter(d => matchWorkstreams(d.text).includes(ws)).reverse();
    console.log(`# Card material: ${ws}\n`);
    console.log(`keywords: ${[].concat(WORKSTREAM_ALIASES[ws] || []).join(', ') || '—'}\n`);
    console.log(card ? `## Current card (updated ${card.updated})\n\n${getBody(card.content)}\n` : '## Current card\n\nNO_CARD\n');
    console.log(`## Decisions, corrections, reflections (${decisions.length}, newest first)\n`);
    let marked = !card;
    for (const d of decisions.slice(0, CARD_MATERIAL_LIMIT)) {
        if (!marked && d.date <= card.updated) {
            console.log(`— card updated ${card.updated} —`);
            marked = true;
        }
        console.log(`- ${d.date} ${d.kind}: ${d.text}`);
    }
    if (decisions.length > CARD_MATERIAL_LIMIT) console.log(`\n… ${decisions.length - CARD_MATERIAL_LIMIT} older not shown`);
}

function printUnassigned(...args) {
    const daysArg = args.find(a => a && a.startsWith('--days='));
    const days = Number(daysArg && daysArg.slice('--days='.length)) || SIGNAL_WINDOW_DAYS;
    const since = daysAgo(days);
    const items = queryDecisionLog().filter(d => d.date >= since && !matchWorkstreams(d.text).length);
    if (!items.length) return console.log(`No decisions outside workstreams in the last ${days} days.`);

    const byDate = {};
    for (const d of items) (byDate[d.date] = byDate[d.date] || []).push(d);
    const dates = Object.keys(byDate).sort().reverse();
    console.log(`\n# Decisions outside every workstream, last ${days} days (${items.length} over ${dates.length} days)\n`);
    for (const date of dates) {
        console.log(`## ${date} (${byDate[date].length})`);
        for (const d of byDate[date]) console.log(`  ${d.time} ${d.kind}: ${d.text}`);
        console.log('');
    }
}

// What the SessionStart hook turns into invitations for the user and a card index
// for the model.
function workstreamSignals(branch = '') {
    const since = daysAgo(SIGNAL_WINDOW_DAYS);
    const cards = Object.fromEntries(Object.keys(WORKSTREAM_ALIASES).map(ws => [ws, readCard(ws)]));
    const counts = {};
    const unassigned = [];
    for (const d of queryDecisionLog()) {
        const hits = matchWorkstreams(d.text);
        const fresh = d.date >= since;
        if (!hits.length && fresh) unassigned.push(d);
        for (const ws of hits) {
            const c = counts[ws] || (counts[ws] = { total: 0, recent: 0, sinceCard: 0 });
            c.total++;
            if (fresh) c.recent++;
            if (fresh && cards[ws] && d.date > cards[ws].updated) c.sinceCard++;
        }
    }

    // A workstream with no card yet, or a card the decisions have outrun. Without a
    // card, files named <ws>-*.md may be its card under another name — say so rather
    // than invite a duplicate.
    const wsDir = path.join(MEMORY_DIR, 'workstreams');
    const wsFiles = fs.existsSync(wsDir) ? fs.readdirSync(wsDir).filter(f => f.endsWith('.md')) : [];
    const cardGaps = Object.entries(counts)
        .map(([workstream, c]) => ({ workstream, ...c, card: Boolean(cards[workstream]) }))
        .filter(g => g.card
            ? g.sinceCard >= CARD_BEHIND_DECISIONS
            : g.total >= CARD_MIN_DECISIONS && g.recent >= CARD_MIN_RECENT)
        .sort((a, b) => b.recent - a.recent)
        .map(g => (g.card ? g : { ...g, related: wsFiles.filter(f => f.startsWith(`${g.workstream}-`)) }));
    const parked = queryParked();
    const parkedBy = {};
    for (const p of parked) if (p.workstream) parkedBy[p.workstream] = (parkedBy[p.workstream] || 0) + 1;
    const staleParked = parked.filter(p => p.parked < daysAgo(PARKED_STALE_DAYS)).length;
    // One line per card at every session start: keep it short
    const cardIndex = Object.entries(cards)
        .filter(([, card]) => card)
        .map(([workstream, card]) => {
            const description = (parseFrontmatter(card.content).description || '').replace(/^"(.*)"$/, '$1');
            return {
                workstream,
                description: description.length > 120 ? `${description.slice(0, 119)}…` : description,
                parked: parkedBy[workstream] || 0,
            };
        });
    const days = new Set(unassigned.map(d => d.date)).size;
    const docsPending = queryDocs().docs.length;
    // Workstreams the branch name points to, if there is anything to continue
    const branchWorkstreams = (branch ? matchWorkstreams(branch) : [])
        .map(ws => ({
            workstream: ws,
            card: Boolean(cards[ws]),
            handoff: fs.existsSync(path.join(MEMORY_DIR, 'workstreams', ws, 'handoff.md')),
            parked: parkedBy[ws] || 0,
        }))
        .filter(w => w.card || w.handoff || w.parked);

    return {
        windowDays: SIGNAL_WINDOW_DAYS,
        cards: cardIndex,
        branchWorkstreams,
        cardGaps,
        parked: { total: parked.length, stale: staleParked },
        unassigned: {
            items: unassigned.length,
            days,
            suggest: unassigned.length >= NEW_WORKSTREAM_MIN_ITEMS && days >= NEW_WORKSTREAM_MIN_DAYS,
        },
        docs: { pending: docsPending, suggest: docsPending >= DOCS_PENDING_MIN },
        offeredRecently: [...recentOffers()],
    };
}

// --- Parking ---

// Parked is a state, not a kind of content: an idea, a task, a question set aside
// with its context to come back to. Unlike an ideas catalog, it has to end — picked
// up, moved to the backlog or a catalog, or dropped (unpark). One file per item, so
// CC's recall can surface it by its description when the topic comes back.
const PARKED_STALE_DAYS = 30;
const PARKED_KINDS = ['idea', 'task', 'question'];

function slugify(title) {
    return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'parked';
}

function argValue(args, name) {
    const arg = args.find(a => a && a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3).trim() : '';
}

function park(...args) {
    const title = argValue(args, 'title');
    const contentPath = argValue(args, 'content');
    const ws = argValue(args, 'workstream');
    const kind = argValue(args, 'kind');
    if (!title || !contentPath) {
        console.log('Usage: memory.js park --title=<title> --content=<path-to-md> [--workstream=<name>] [--kind=idea|task|question]');
        console.log('  writes workstreams/<name>/<slug>.md, or parked/<slug>.md without a workstream');
        return;
    }
    if ((ws && !/^[a-zA-Z0-9_-]+$/.test(ws)) || (kind && !PARKED_KINDS.includes(kind))) {
        console.error(`Invalid ${ws && !/^[a-zA-Z0-9_-]+$/.test(ws) ? `workstream name: "${ws}"` : `kind: "${kind}"`}`);
        process.exit(1);
    }
    let body;
    try { body = fs.readFileSync(contentPath, 'utf-8'); }
    catch (e) { console.error(`Failed to read content: ${e.message}`); process.exit(1); }

    const dir = ws ? `workstreams/${ws}` : 'parked';
    fs.mkdirSync(path.join(MEMORY_DIR, dir), { recursive: true });
    const slug = slugify(title);
    let rel = `${dir}/${slug}.md`;
    for (let n = 2; fs.existsSync(path.join(MEMORY_DIR, rel)); n++) rel = `${dir}/${slug}-${n}.md`;

    const now = new Date().toISOString();
    const withFrontmatter = body.startsWith('---\n') ? body : `---\nname: ${title}\ndescription: ${title}\ntype: project\n---\n\n${body}`;
    const final = setFrontmatter(withFrontmatter, { category: 'parked', ...(kind && { kind }), parked: now.slice(0, 10), modified: now, ...sessionStamp() });
    fs.writeFileSync(path.join(MEMORY_DIR, rel), final.endsWith('\n') ? final : final + '\n');
    console.log(`Parked: ${rel}`);
}

// Parked files, newest first. Files /park wrote into a workstream folder before
// `category: parked` existed are recognised by its "## Next step" section.
function queryParked() {
    const items = [];
    const add = (rel, workstream) => {
        const file = path.join(MEMORY_DIR, rel);
        const content = fs.readFileSync(file, 'utf-8');
        const fm = parseFrontmatter(content);
        if (fm.category !== 'parked' && !(workstream && /^## Next step/m.test(content))) return;
        items.push({
            file: rel,
            workstream,
            title: (fm.name || path.basename(rel, '.md')).replace(/^"(.*)"$/, '$1'),
            description: (fm.description || '').replace(/^"(.*)"$/, '$1'),
            kind: fm.kind || '',
            // mtime last: reading a file through memory.js bumps it
            parked: fm.parked || (fm.modified || '').slice(0, 10) || new Date(fs.statSync(file).mtimeMs).toISOString().slice(0, 10),
        });
    };
    const wsDir = path.join(MEMORY_DIR, 'workstreams');
    if (fs.existsSync(wsDir)) {
        for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            for (const f of fs.readdirSync(path.join(wsDir, entry.name))) {
                if (f.endsWith('.md') && f !== 'handoff.md') add(`workstreams/${entry.name}/${f}`, entry.name);
            }
        }
    }
    const parkedDir = path.join(MEMORY_DIR, 'parked');
    if (fs.existsSync(parkedDir)) {
        for (const f of fs.readdirSync(parkedDir)) if (f.endsWith('.md')) add(`parked/${f}`, null);
    }
    return items.sort((a, b) => b.parked.localeCompare(a.parked));
}

// `PARKED:` note lines — the cheapest parking, kept as it is
function queryParkedNotes(days) {
    const notesDir = DIRS.notes;
    if (!notesDir || !fs.existsSync(notesDir)) return [];
    const since = daysAgo(days);
    const results = [];
    for (const entry of fs.readdirSync(notesDir).filter(f => f.endsWith('.md')).sort().reverse()) {
        const date = entry.replace('.md', '');
        if (date < since) break;
        for (const line of fs.readFileSync(path.join(notesDir, entry), 'utf-8').split('\n')) {
            const m = line.match(/^- \d{2}:\d{2} PARKED:\s*(.+)$/);
            if (m) results.push({ date, text: m[1].trim() });
        }
    }
    return results;
}

function printParked(...args) {
    const ws = args.find(a => a && !a.startsWith('--')) || '';
    const items = queryParked().filter(i => !ws || i.workstream === ws);
    const raw = ws ? [] : queryParkedNotes(PARKED_STALE_DAYS);
    if (!items.length && !raw.length) return console.log(ws ? `Nothing parked in ${ws}.` : 'Nothing parked.');

    const stale = daysAgo(PARKED_STALE_DAYS);
    const groups = {};
    for (const i of items) (groups[i.workstream || 'general'] = groups[i.workstream || 'general'] || []).push(i);
    console.log(`\n# Parked (${items.length})\n`);
    for (const [group, list] of Object.entries(groups)) {
        console.log(`## ${group} (${list.length})`);
        for (const i of list) {
            const kind = i.kind ? `[${i.kind}] ` : '';
            const old = i.parked < stale ? '  ⚠ over 30 days' : '';
            const desc = i.description && i.description !== i.title ? ` — ${i.description}` : '';
            console.log(`  ${i.parked} ${kind}${i.title}${desc}\n    ${i.file}${old}`);
        }
        console.log('');
    }
    if (raw.length) {
        console.log(`## PARKED notes, last ${PARKED_STALE_DAYS} days (${raw.length})`);
        for (const r of raw) console.log(`  ${r.date} ${r.text}`);
        console.log('');
    }
}

// The exit: the item was picked up, moved (backlog, decision, ideas catalog) or dropped
function unpark(...args) {
    const rel = args.find(a => a && !a.startsWith('--')) || '';
    const to = argValue(args, 'to');
    if (!rel || !to) {
        console.log('Usage: memory.js unpark <parked file, e.g. parked/x.md> --to=<where it went: picked-up | backlog | decision | ideas | drop>');
        return;
    }
    const item = queryParked().find(i => i.file === rel);
    if (!item) {
        console.error(`Not a parked item: ${rel} (see memory.js parked)`);
        process.exit(1);
    }
    fs.unlinkSync(path.join(MEMORY_DIR, rel));
    note(`UNPARKED: ${item.title} → ${to}`);
}

function printSignals(...args) {
    const branchArg = args.find(a => a && a.startsWith('--branch='));
    console.log(JSON.stringify(workstreamSignals(branchArg ? branchArg.slice('--branch='.length) : ''), null, 2));
}

// --- Session activity ---

// The SessionStart hook logs SESSION_START again on every resume and compact, and
// a session can run past midnight. So the session begins at the first marker with
// its uuid — CLAUDE_CODE_SESSION_ID, else the latest marker's — not at the last one.
const SESSION_LOOKBACK_FILES = 14;

function sessionActivity() {
    const result = { session_start: null, session_start_date: null, items: [], docs: [] };
    const notesDir = DIRS.notes;
    if (!notesDir || !fs.existsSync(notesDir)) return result;

    const today = new Date().toISOString().slice(0, 10);
    const files = fs.readdirSync(notesDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-SESSION_LOOKBACK_FILES);
    let lines = files.flatMap(f => fs.readFileSync(path.join(notesDir, f), 'utf-8').split('\n')
        .map(line => ({ date: f.slice(0, 10), line })));
    const START = /^- (\d{2}:\d{2}) SESSION_START(?: uuid:(\S+))?/;
    const MARKER = /^- \d{2}:\d{2} (SESSION_START|SESSION_END|NEW_WORKSTREAM|DOCS_REVIEWED|OFFERED)/;
    const LINE = /^- (\d{2}:\d{2}) (.+)$/;

    const starts = lines.map((l, i) => [i, l.line.match(START)]).filter(([, m]) => m);
    const latest = starts[starts.length - 1];
    const uuid = starts.some(([, m]) => m[2] && m[2] === process.env.CLAUDE_CODE_SESSION_ID)
        ? process.env.CLAUDE_CODE_SESSION_ID
        : latest && latest[1][2];
    const first = uuid ? starts.find(([, m]) => m[2] === uuid) : latest;
    if (first) {
        result.session_start = first[1][1];
        result.session_start_date = lines[first[0]].date;
        lines = lines.slice(first[0] + 1);
    } else {
        lines = lines.filter(l => l.date === today);
    }

    for (const { line } of lines) {
        if (MARKER.test(line)) continue;
        const m = line.match(LINE);
        if (!m) continue;
        const text = m[2].trim();
        if (!text) continue;
        result.items.push(text);
        if (text.startsWith('DOC:')) result.docs.push(text);
    }

    return result;
}

function printSessionActivity() {
    console.log(JSON.stringify(sessionActivity(), null, 2));
}

function sessionChanges() {
    const activity = sessionActivity();
    const cwd = process.cwd();
    const result = { since: activity.session_start, files: [], commits: [] };
    const git = cmd => {
        try { return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
        catch { return ''; }
    };

    if (activity.session_start) {
        const today = new Date().toISOString().slice(0, 10);
        const since = activity.session_start_date === today
            ? activity.session_start
            : `${activity.session_start_date} ${activity.session_start}`;
        const commits = git(`git log --since="${since}" --pretty=format:"%h %s"`);
        if (commits) result.commits = commits.split('\n').filter(Boolean);
        const commitFiles = git(`git log --since="${since}" --name-only --pretty=format:""`);
        const fromCommits = commitFiles.split('\n').filter(Boolean);
        const status = git('git status --porcelain');
        const uncommitted = status.split('\n').filter(Boolean).map(l => l.slice(3));
        result.files = [...new Set([...fromCommits, ...uncommitted])].sort();
    } else {
        const status = git('git status --porcelain');
        result.files = status.split('\n').filter(Boolean).map(l => l.slice(3)).sort();
    }

    return result;
}

function printSessionChanges() {
    console.log(JSON.stringify(sessionChanges(), null, 2));
}

// --- Session receipt ---

// What the session left: memory files it wrote (originSessionId — CC's stamper and
// memory.js both set it), what the watcher and the model logged, the workstreams it
// moved and whether their cards kept up. Deterministic, writes nothing: the end of a
// session is a receipt, not a ritual (decisions/value-in-the-moment).
const RECEIPT_KINDS = {
    decision: /^WATCH:DECISION/, correction: /^WATCH:CORRECTION/, plan: /^WATCH:PLAN/,
    doc: /^DOC:/, reflect: /^REFLECT:/, parked: /^PARKED:/, commit: /^COMMIT:/,
};

function sessionReceipt() {
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID || '';
    const activity = sessionActivity();
    const files = sessionId
        ? getAllFiles().filter(f => !f.name.startsWith('notes') && f.frontmatter.originSessionId === sessionId).map(f => f.name).sort()
        : null;
    const logged = Object.fromEntries(Object.entries(RECEIPT_KINDS)
        .map(([kind, re]) => [kind, activity.items.filter(t => re.test(t)).length]));
    const touched = {};
    for (const item of activity.items) {
        if (!Object.values(RECEIPT_KINDS).some(re => re.test(item))) continue;
        for (const ws of matchWorkstreams(item)) touched[ws] = (touched[ws] || 0) + 1;
    }
    const workstreams = Object.entries(touched)
        .sort((a, b) => b[1] - a[1])
        .map(([workstream, items]) => {
            const card = readCard(workstream);
            const cardState = !card ? 'missing'
                : sessionId && parseFrontmatter(card.content).originSessionId === sessionId ? 'updated' : 'not updated';
            return { workstream, items, card: cardState };
        });
    return {
        session: sessionId || null,
        since: activity.session_start ? `${activity.session_start_date} ${activity.session_start}` : null,
        files,
        logged,
        workstreams,
    };
}

function printReceipt(...args) {
    const r = sessionReceipt();
    if (args.includes('--json')) return console.log(JSON.stringify(r, null, 2));

    console.log(`\n# Session receipt${r.since ? ` — since ${r.since}` : ''}\n`);
    if (r.files === null) {
        console.log('Memory files: unknown (no CLAUDE_CODE_SESSION_ID)');
    } else {
        console.log(`Memory files written (${r.files.length})${r.files.length ? ':' : ''}`);
        for (const f of r.files) console.log(`  ${f}`);
    }
    const l = r.logged;
    console.log(`\nLogged: ${l.decision} decisions, ${l.correction} corrections, ${l.plan} plans, ${l.doc} DOC, ${l.reflect} reflections, ${l.parked} parked, ${l.commit} commits`);
    if (r.workstreams.length) {
        console.log('\nWorkstreams moved:');
        for (const w of r.workstreams) console.log(`  ${w.workstream} — ${w.items} items, card ${w.card}`);
    }
}

function printHandoff(...args) {
    const ws = (args[0] || '').trim();
    if (ws) {
        if (!/^[a-zA-Z0-9_-]+$/.test(ws)) {
            console.error(`Invalid workstream name: "${ws}"`);
            process.exit(1);
        }
        const perWs = path.join(MEMORY_DIR, 'workstreams', ws, 'handoff.md');
        if (fs.existsSync(perWs)) return process.stdout.write(fs.readFileSync(perWs, 'utf-8'));
    }
    const global = path.join(MEMORY_DIR, 'workstreams', 'handoff.md');
    if (fs.existsSync(global)) return process.stdout.write(fs.readFileSync(global, 'utf-8'));
    console.log('NO_HANDOFF');
}

// A handoff records when and on which branch it was written: the SessionStart hook
// shows an old or other-branch handoff as such instead of as the last session.
// `--global` writes workstreams/handoff.md.
function writeHandoff(...args) {
    const branch = currentBranch();
    writeWorkstreamFile('write-handoff', args, {
        global: args.includes('--global'),
        relFor: ws => (ws ? `workstreams/${ws}/handoff.md` : 'workstreams/handoff.md'),
        frontmatterFor: ws => ws
            ? `---\nname: ${ws} handoff\ndescription: Per-workstream handoff for ${ws}\ntype: project\n---\n`
            : '---\nname: Session handoff\ndescription: Context for starting the next session\ntype: project\n---\n',
        stamp: { modified: new Date().toISOString(), ...(branch && { branch }) },
    });
}

function writeCard(...args) {
    writeWorkstreamFile('write-card', args, {
        relFor: ws => `workstreams/${ws}.md`,
        frontmatterFor: ws => `---\nname: ${ws}\ndescription: Workstream card for ${ws}\ntype: project\ncategory: workstream\n---\n`,
        stamp: { modified: new Date().toISOString() },
    });
}

function currentBranch() {
    try {
        return execSync('git branch --show-current', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

// Every file MT writes says so (`origin`, as other tools sharing the folder do), and
// carries originSessionId — the key CC's stamper puts on files a session writes — so
// the session receipt sees everything the session left.
function sessionStamp() {
    const id = process.env.CLAUDE_CODE_SESSION_ID;
    return { origin: ORIGIN, ...(id && { originSessionId: id }) };
}

// Sets frontmatter keys in place — top-level, or the copy CC's stamper moved under metadata:.
function setFrontmatter(content, fields) {
    return content.replace(/^---\n([\s\S]*?)\n---/, (_, fm) => {
        for (const [key, value] of Object.entries(fields)) {
            const line = new RegExp(`^(\\s*)${key}:.*$`, 'm');
            fm = line.test(fm) ? fm.replace(line, (__, indent) => `${indent}${key}: ${value}`) : `${fm}\n${key}: ${value}`;
        }
        return `---\n${fm}\n---`;
    });
}

// Node writes the file, so CC's frontmatter stamper (Write/Edit tools only)
// leaves our keys where they are.
function writeWorkstreamFile(command, args, { global = false, relFor, frontmatterFor, stamp }) {
    const wsArg = args.find(a => a && a.startsWith('--workstream='));
    const contentArg = args.find(a => a && a.startsWith('--content='));
    if ((!wsArg && !global) || !contentArg) {
        console.log(`Usage: memory.js ${command} --workstream=<name> --content=<path-to-md>`);
        console.log(`  writes to ${relFor('<name>')}`);
        return;
    }
    const ws = global ? null : wsArg.slice('--workstream='.length).trim();
    const contentPath = contentArg.slice('--content='.length);
    if (!global && !/^[a-zA-Z0-9_-]+$/.test(ws)) {
        console.error(`Invalid workstream name: "${ws}"`);
        process.exit(1);
    }
    let body;
    try { body = fs.readFileSync(contentPath, 'utf-8'); }
    catch (e) { console.error(`Failed to read content: ${e.message}`); process.exit(1); }

    const rel = relFor(ws);
    const out = path.join(MEMORY_DIR, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    const final = setFrontmatter(body.startsWith('---\n') ? body : `${frontmatterFor(ws)}\n${body}`, { ...stamp, ...sessionStamp() });
    fs.writeFileSync(out, final.endsWith('\n') ? final : final + '\n');
    console.log(`Wrote ${rel}`);
}

// --- Router ---

const commands = {
    search: printSearch,
    recent: printRecent,
    workstream: printWorkstream,
    decisions: printDecisions,
    list: printList,
    note,
    'add-workstream': addWorkstream,
    'remove-workstream': removeWorkstream,
    workstreams: listWorkstreams,
    docs: printDocs,
    findings: printWatchFindings,
    classify,
    'session-activity': printSessionActivity,
    'session-changes': printSessionChanges,
    receipt: printReceipt,
    'write-handoff': writeHandoff,
    handoff: printHandoff,
    card: printCard,
    'write-card': writeCard,
    park,
    parked: printParked,
    unpark,
    unassigned: printUnassigned,
    signals: printSignals,
    recurring: printRecurring,
    reindex,
    health,
    // Prints the path even when memory does not exist yet (bootstrap uses it), exit 1 then
    dir: () => { console.log(MEMORY_DIR); if (!RESOLVED.exists) process.exitCode = 1; },
};

// CLI mode
if (require.main === module) {
    const cliArgs = process.argv.slice(2).filter(a => !a.startsWith('--dir='));
    const [cmd, ...args] = cliArgs;
    if (!cmd || !commands[cmd]) {
        console.log('Memory API — on-demand context\n');
        console.log('Commands:');
        console.log('  search <query>         — search across all files');
        console.log('  recent [n]             — last N feedback files (default: 5)');
        console.log('  workstream <name>      — workstream context');
        console.log('  workstreams            — list all workstreams');
        console.log('  add-workstream <name> <keywords...>  — create/update workstream');
        console.log('  remove-workstream <name>             — remove workstream');
        console.log('  decisions [topic]      — decisions by topic');
        console.log('  list [type]            — list files');
        console.log('  note <text>            — quick note');
        console.log('  docs [--all]           — DOC: notes since the last review (--mark-reviewed closes one)');
        console.log('  findings               — collect WATCH:DECISION/PLAN/CORRECTION/PHASE entries from daily notes');
        console.log('  classify --items=<f>   — classify items by workstream keywords (JSON in/out)');
        console.log('  session-activity       — current session items since last SESSION_START (JSON)');
        console.log('  session-changes        — git files+commits since session start (JSON)');
        console.log('  receipt [--json]       — what this session left: memory files, logged items, workstreams moved');
        console.log('  write-handoff --workstream=<name>|--global --content=<f>  — write a handoff (stamps modified + branch)');
        console.log('  handoff [<workstream>]  — print per-workstream handoff if exists, else global');
        console.log('  card <ws> [--material]  — workstream card (--material: decisions to draft or update it from)');
        console.log('  write-card --workstream=<name> --content=<f>  — write workstreams/<name>.md');
        console.log('  park --title=<t> --content=<f> [--workstream=<name>] [--kind=idea|task|question]  — park with context');
        console.log('  parked [<workstream>]  — parked items, oldest flagged, plus recent PARKED: notes');
        console.log('  unpark <file> --to=<where>  — the exit: remove a parked item, note where it went');
        console.log('  unassigned [--days=30] — decisions that match no workstream, by day');
        console.log('  signals [--branch=<b>]  — invitations for SessionStart: card gaps, new workstream, parked, DOC (JSON)');
        console.log('  recurring              — find recurring feedback patterns');
        console.log('  reindex                — rebuild MEMORY.md index sorted by weight');
        console.log('  health                 — check memory health (dead links, stale, size, dupes)');
        console.log('  dir                    — memory directory path');
    } else if (!RESOLVED.exists && cmd !== 'dir') {
        console.error(`memory.js: no memory for ${process.cwd()} — pass --dir=<path> or run /memory-setup`);
        process.exit(1);
    } else {
        commands[cmd](...args);
    }
}

// Exports for testing
module.exports = {
    parseFrontmatter,
    getBody,
    getAllFiles,
    getFilesFromDir,
    querySearch,
    queryRecent,
    queryWorkstream,
    queryDecisions,
    queryList,
    WORKSTREAM_ALIASES,
    DIRS,
    note,
    queryDocs,
    queryWatchFindings,
    classifyItems,
    matchWorkstreams,
    readCard,
    queryParked,
    queryDecisionLog,
    workstreamSignals,
    sessionActivity,
    sessionChanges,
    sessionReceipt,
    writeHandoff,
    queryRecurring,
    health,
};
