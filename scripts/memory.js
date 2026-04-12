#!/usr/bin/env node

/**
 * Memory API — on-demand context loading from memory/
 *
 * Usage:
 *   node memory.js search <query>       — search across all files
 *   node memory.js recent [n]           — last N feedback files (default: 5)
 *   node memory.js workstream <name>    — all files related to a workstream
 *   node memory.js decisions [topic]    — decisions (Why/How to apply blocks)
 *   node memory.js list [type]          — list files (workstreams|feedback|decisions|profile|reference|notes|all)
 *   node memory.js docs                 — collect DOC: notes from daily notes
 *   node memory.js reindex              — rebuild MEMORY.md index sorted by weight (evicts low-weight entries if over 200 lines)
 */

const fs = require('fs');
const path = require('path');
const { loadSchema, calculateWeight, incrementHits, rebuildIndex } = require('./lib/weight');

// Support --dir=<path> for symlink/plugin usage, fallback to __dirname
const dirArg = process.argv.find(a => a.startsWith('--dir='));
const MEMORY_DIR = dirArg ? dirArg.split('=')[1] : __dirname;
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
} catch {
    process.stderr.write('[memory] workstreams.json is corrupted, using empty aliases\n');
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

function note(...words) {
    const text = words.join(' ');
    if (!text) return console.log('Usage: memory.js note <text>\nExample: memory.js note "auth: switched to JWT for stateless sessions"');

    const notesDir = DIRS.notes;
    if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(notesDir, `${today}.md`);

    const time = new Date().toTimeString().slice(0, 5);
    const entry = `- ${time} ${text}\n`;

    if (fs.existsSync(filePath)) {
        fs.appendFileSync(filePath, entry);
    } else {
        const header = `---\nname: Notes ${today}\ndescription: Session notes ${today}\ntype: project\n---\n\n# ${today}\n\n`;
        fs.writeFileSync(filePath, header + entry);
    }

    console.log(`Saved to notes/${today}.md`);
}

// --- Docs ---

function queryDocs() {
    const notesDir = DIRS.notes;
    if (!notesDir || !fs.existsSync(notesDir)) return [];

    const results = [];
    for (const entry of fs.readdirSync(notesDir).sort()) {
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(notesDir, entry);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
            const match = line.match(/^- (\d{2}:\d{2}) DOC:\s*(.+)$/);
            if (match) {
                const [, time, text] = match;
                const date = entry.replace('.md', '');
                // Parse "domain — insight" or just "insight"
                const dashIdx = text.indexOf(' — ');
                const domain = dashIdx >= 0 ? text.slice(0, dashIdx).trim() : 'general';
                const insight = dashIdx >= 0 ? text.slice(dashIdx + 3).trim() : text.trim();
                results.push({ date, time, domain, insight, raw: text });
            }
        }
    }
    return results;
}

function printDocs() {
    const docs = queryDocs();
    if (!docs.length) return console.log('No DOC: notes found. Use: memory.js note "DOC: domain — insight"');

    // Group by domain
    const grouped = {};
    for (const d of docs) {
        if (!grouped[d.domain]) grouped[d.domain] = [];
        grouped[d.domain].push(d);
    }

    console.log(`\n# DOC notes (${docs.length})\n`);
    for (const [domain, items] of Object.entries(grouped).sort()) {
        console.log(`## ${domain} (${items.length})`);
        for (const item of items) {
            console.log(`  ${item.date} ${item.time}  ${item.insight}`);
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

    console.log('\nWorkstreams:\n');
    entries.forEach(([name, keywords], i) => {
        const files = queryWorkstream(name);
        const handoff = files.find(f => f.name.includes('handoff'));
        const handoffDate = handoff ? handoff.mtime.toISOString().slice(0, 10) : null;
        console.log(`  ${i + 1}. ${name} — ${files.length} files${handoffDate ? `, handoff: ${handoffDate}` : ''}`);
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
        } catch {
            return 0;
        }
    }

    const linesBefore = content.split('\n').length;
    const rebuilt = rebuildIndex(content, schema, getFileWeight);
    const linesAfter = rebuilt.split('\n').length;

    // Atomic write
    const tmp = memoryMdPath + '.tmp';
    fs.writeFileSync(tmp, rebuilt, 'utf-8');
    fs.renameSync(tmp, memoryMdPath);

    const evicted = linesBefore - linesAfter;
    console.log(`Reindexed MEMORY.md: ${linesAfter} lines${evicted > 0 ? ` (${evicted} low-weight entries evicted)` : ''}`);
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
    recurring: printRecurring,
    reindex,
    dir: () => console.log(MEMORY_DIR),
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
        console.log('  docs                   — collect DOC: notes');
        console.log('  recurring              — find recurring feedback patterns');
        console.log('  reindex                — rebuild MEMORY.md index sorted by weight');
        console.log('  dir                    — memory directory path');
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
    queryRecurring,
};
