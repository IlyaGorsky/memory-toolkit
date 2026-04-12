const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { calculateWeight, incrementHits, parseSections, rebuildIndex, loadSchema } = require('../scripts/lib/weight');

const TMP = path.join(__dirname, '.tmp-weight');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'memory.js');

function run(args) {
    return execSync(`node "${SCRIPT}" --dir="${TMP}" ${args}`, {
        encoding: 'utf8',
        timeout: 5000,
    }).trim();
}

function writeFile(relativePath, content) {
    const full = path.join(TMP, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

describe('weight.js', () => {
    beforeEach(() => {
        fs.mkdirSync(TMP, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(TMP, { recursive: true, force: true });
    });

    describe('calculateWeight', () => {
        const weightConfig = {
            type_base: { decision: 10, feedback: 8, reference: 5, note: 2 },
            decay_half_life_days: 90,
        };

        it('decisions weigh more than notes', () => {
            const now = new Date();
            const decision = { frontmatter: { type: 'decision', hits: '5' }, mtime: now };
            const note = { frontmatter: { type: 'note', hits: '5' }, mtime: now };
            assert.ok(calculateWeight(decision, weightConfig) > calculateWeight(note, weightConfig));
        });

        it('more hits = higher weight', () => {
            const now = new Date();
            const manyHits = { frontmatter: { type: 'feedback', hits: '20' }, mtime: now };
            const fewHits = { frontmatter: { type: 'feedback', hits: '1' }, mtime: now };
            assert.ok(calculateWeight(manyHits, weightConfig) > calculateWeight(fewHits, weightConfig));
        });

        it('recent files weigh more than old files', () => {
            const now = new Date();
            const oldDate = new Date(Date.now() - 180 * 86400000); // 180 days ago
            const recent = { frontmatter: { type: 'feedback', hits: '3' }, mtime: now };
            const old = { frontmatter: { type: 'feedback', hits: '3' }, mtime: oldDate };
            assert.ok(calculateWeight(recent, weightConfig) > calculateWeight(old, weightConfig));
        });

        it('zero-hit entry still has positive weight', () => {
            const now = new Date();
            const entry = { frontmatter: { type: 'note', hits: '0' }, mtime: now };
            assert.ok(calculateWeight(entry, weightConfig) > 0);
        });

        it('missing frontmatter defaults gracefully', () => {
            const entry = { frontmatter: {}, mtime: new Date() };
            assert.ok(calculateWeight(entry, weightConfig) > 0);
        });
    });

    describe('incrementHits', () => {
        it('adds hits field to file without it', () => {
            const filePath = path.join(TMP, 'feedback', 'test.md');
            writeFile('feedback/test.md', '---\nname: Test\ntype: feedback\n---\n\nContent here');
            incrementHits(filePath);
            const content = fs.readFileSync(filePath, 'utf-8');
            assert.ok(content.includes('hits: 1'));
            assert.ok(content.includes('last_hit:'));
        });

        it('increments existing hits counter', () => {
            const filePath = path.join(TMP, 'feedback', 'test.md');
            writeFile('feedback/test.md', '---\nname: Test\ntype: feedback\nhits: 5\n---\n\nContent');
            incrementHits(filePath);
            const content = fs.readFileSync(filePath, 'utf-8');
            assert.ok(content.includes('hits: 6'));
        });

        it('increments multiple times', () => {
            const filePath = path.join(TMP, 'feedback', 'test.md');
            writeFile('feedback/test.md', '---\nname: Test\ntype: feedback\n---\n\nContent');
            incrementHits(filePath);
            incrementHits(filePath);
            incrementHits(filePath);
            const content = fs.readFileSync(filePath, 'utf-8');
            assert.ok(content.includes('hits: 3'));
        });

        it('skips files without frontmatter', () => {
            const filePath = path.join(TMP, 'plain.md');
            writeFile('plain.md', '# No frontmatter\n\nJust text');
            incrementHits(filePath); // should not throw
            const content = fs.readFileSync(filePath, 'utf-8');
            assert.ok(!content.includes('hits:'));
        });
    });

    describe('parseSections', () => {
        it('identifies protected and evictable sections', () => {
            const schema = loadSchema(null); // default schema
            const content = [
                '# Project — Memory',
                '',
                '## API',
                '```bash',
                'node memory.js <command>',
                '```',
                '',
                '## Rules',
                '### Save',
                '- Rule 1',
                '',
                '## Feedback',
                '- [Entry A](feedback/a.md) — desc A',
                '- [Entry B](feedback/b.md) — desc B',
                '',
                '## Notes',
                '- [Note 1](notes/n1.md) — desc N1',
            ].join('\n');

            const sections = parseSections(content, schema);
            const api = sections.find(s => s.name === 'API');
            const rules = sections.find(s => s.name === 'Rules');
            const feedback = sections.find(s => s.name === 'Feedback');
            const notes = sections.find(s => s.name === 'Notes');

            assert.ok(api.protected);
            assert.ok(rules.protected);
            assert.ok(!feedback.protected);
            assert.ok(!notes.protected);
            assert.equal(feedback.entries.length, 2);
            assert.equal(notes.entries.length, 1);
        });
    });

    describe('rebuildIndex', () => {
        it('sorts evictable entries by weight descending', () => {
            const schema = loadSchema(null);
            const content = [
                '# Memory',
                '',
                '## Feedback',
                '- [Low](feedback/low.md) — low weight',
                '- [High](feedback/high.md) — high weight',
            ].join('\n');

            // High.md has higher weight than low.md
            const weights = {
                'feedback/high.md': 100,
                'feedback/low.md': 1,
            };

            const rebuilt = rebuildIndex(content, schema, (p) => weights[p] || 0);
            const lines = rebuilt.split('\n');
            const highIdx = lines.findIndex(l => l.includes('High'));
            const lowIdx = lines.findIndex(l => l.includes('Low'));
            assert.ok(highIdx < lowIdx, `High (idx ${highIdx}) should come before Low (idx ${lowIdx})`);
        });

        it('does not touch protected sections', () => {
            const schema = loadSchema(null);
            const content = [
                '# Memory',
                '',
                '## API',
                '```bash',
                'node memory.js <command>',
                '```',
                '',
                '## Rules',
                '- Important rule',
                '',
                '## Feedback',
                '- [Entry](feedback/e.md) — desc',
            ].join('\n');

            const rebuilt = rebuildIndex(content, schema, () => 1);
            assert.ok(rebuilt.includes('## API'));
            assert.ok(rebuilt.includes('node memory.js <command>'));
            assert.ok(rebuilt.includes('## Rules'));
            assert.ok(rebuilt.includes('Important rule'));
        });

        it('evicts lowest-weight entries when over max_lines', () => {
            const schema = { ...loadSchema(null), max_lines: 10 };
            // Build content with 12 lines: header(2) + feedback with 10 entries = 12 lines
            const entries = Array.from({ length: 10 }, (_, i) =>
                `- [Entry${i}](feedback/e${i}.md) — entry ${i}`
            );
            const content = ['# Memory', '', '## Feedback', ...entries].join('\n');

            // Entry0 has lowest weight, Entry9 has highest
            const rebuilt = rebuildIndex(content, schema, (p) => {
                const m = p.match(/e(\d+)/);
                return m ? parseInt(m[1]) + 1 : 0;
            });

            const lines = rebuilt.split('\n').filter(l => l.trim());
            assert.ok(lines.length <= 10, `Should be ≤10 lines, got ${lines.length}`);
            // Entry9 (highest weight) should survive
            assert.ok(rebuilt.includes('Entry9'), 'Highest-weight entry should survive');
            // Entry0 (lowest weight) should be evicted
            assert.ok(!rebuilt.includes('Entry0'), 'Lowest-weight entry should be evicted');
        });

        it('never evicts protected section content', () => {
            const schema = { ...loadSchema(null), max_lines: 8 };
            const content = [
                '# Memory',
                '',
                '## API',
                '```bash',
                'node memory.js',
                '```',
                '',
                '## Feedback',
                '- [A](feedback/a.md) — a',
                '- [B](feedback/b.md) — b',
                '- [C](feedback/c.md) — c',
            ].join('\n');

            const rebuilt = rebuildIndex(content, schema, () => 1);
            // API block must survive regardless of line budget
            assert.ok(rebuilt.includes('## API'));
            assert.ok(rebuilt.includes('node memory.js'));
        });
    });

    describe('integration: search increments hits', () => {
        it('search result files get hits incremented', () => {
            writeFile('feedback/auth.md', '---\nname: Auth decision\ntype: feedback\ndescription: auth stuff\n---\n\nWe decided on JWT');
            writeFile('workstreams.json', '{}');

            run('search JWT');

            const content = fs.readFileSync(path.join(TMP, 'feedback', 'auth.md'), 'utf-8');
            assert.ok(content.includes('hits: 1'), `Expected hits: 1, got:\n${content}`);
        });

        it('multiple searches accumulate hits', () => {
            writeFile('feedback/auth.md', '---\nname: Auth\ntype: feedback\ndescription: auth\n---\n\nJWT token decision');
            writeFile('workstreams.json', '{}');

            run('search JWT');
            run('search JWT');
            run('search token');

            const content = fs.readFileSync(path.join(TMP, 'feedback', 'auth.md'), 'utf-8');
            assert.ok(content.includes('hits: 3'), `Expected hits: 3, got:\n${content}`);
        });
    });

    describe('integration: reindex command', () => {
        it('reindex sorts entries by weight', () => {
            // Create MEMORY.md with two feedback entries
            writeFile('MEMORY.md', [
                '# Memory',
                '',
                '## Feedback',
                '- [Low](feedback/low.md) — rarely used',
                '- [High](feedback/high.md) — often used',
            ].join('\n'));

            // Low: 0 hits, old
            writeFile('feedback/low.md', '---\nname: Low\ntype: feedback\nhits: 0\n---\n\nRarely used');
            // High: 20 hits, recent
            writeFile('feedback/high.md', '---\nname: High\ntype: feedback\nhits: 20\n---\n\nOften used');

            writeFile('workstreams.json', '{}');

            const output = run('reindex');
            assert.ok(output.includes('Reindexed'));

            const content = fs.readFileSync(path.join(TMP, 'MEMORY.md'), 'utf-8');
            const highIdx = content.indexOf('High');
            const lowIdx = content.indexOf('Low');
            assert.ok(highIdx < lowIdx, 'High-weight entry should come first after reindex');
        });
    });
});
