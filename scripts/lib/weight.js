#!/usr/bin/env node

/**
 * Weighted memory eviction — calculateWeight + incrementHits.
 *
 * Weight formula:
 *   weight = typeBase * log(hits + 1) * exp(-ageDays / halfLife)
 *
 * Used by memory.js to:
 *   1. Sort entries within evictable MEMORY.md sections by weight desc
 *   2. Evict lowest-weight entries when over max_lines budget
 *   3. Track hits in frontmatter for each queried file
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SCHEMA_PATH = path.join(__dirname, 'memory-schema.default.json');

/**
 * Load schema from project memory dir, fallback to default.
 */
function loadSchema(memoryDir) {
    const projectSchema = memoryDir
        ? path.join(memoryDir, 'memory-schema.json')
        : null;
    if (projectSchema && fs.existsSync(projectSchema)) {
        try {
            return JSON.parse(fs.readFileSync(projectSchema, 'utf-8'));
        } catch {
            // corrupted project schema — fall back to default
        }
    }
    return JSON.parse(fs.readFileSync(DEFAULT_SCHEMA_PATH, 'utf-8'));
}

/**
 * Calculate weight for a memory entry.
 *
 * @param {object} entry - { frontmatter: { type, hits }, mtime: Date }
 * @param {object} weightConfig - schema.weight section
 * @returns {number}
 */
function calculateWeight(entry, weightConfig) {
    const typeBase = (weightConfig && weightConfig.type_base) || {};
    const halfLife = (weightConfig && weightConfig.decay_half_life_days) || 90;

    const type = (entry.frontmatter && entry.frontmatter.type) || 'note';
    const base = typeBase[type] || 1;
    const hits = parseInt(entry.frontmatter && entry.frontmatter.hits, 10) || 0;
    const mtime = entry.mtime instanceof Date ? entry.mtime : new Date(entry.mtime || 0);
    const ageDays = (Date.now() - mtime.getTime()) / 86400000;
    const decay = Math.exp(-ageDays / halfLife);

    return base * Math.log(hits + 2) * decay; // +2 so new entries (0 hits) have log(2)=0.69, not log(1)=0
}

/**
 * Increment hit counter in a file's frontmatter.
 * Writes the file in place, updating `hits` and `last_hit` fields.
 *
 * @param {string} filePath - absolute path to .md file
 */
function incrementHits(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) return; // no frontmatter, skip

        const fmBlock = fmMatch[1];
        const today = new Date().toISOString().slice(0, 10);

        // Parse current hits
        const hitsMatch = fmBlock.match(/^hits:\s*(\d+)/m);
        const currentHits = hitsMatch ? parseInt(hitsMatch[1], 10) : 0;
        const newHits = currentHits + 1;

        let newFm;
        if (hitsMatch) {
            // Update existing hits line
            newFm = fmBlock.replace(/^hits:\s*\d+/m, `hits: ${newHits}`);
        } else {
            // Add hits line at end of frontmatter
            newFm = fmBlock + `\nhits: ${newHits}`;
        }

        // Update or add last_hit
        if (/^last_hit:/m.test(newFm)) {
            newFm = newFm.replace(/^last_hit:.*/m, `last_hit: ${today}`);
        } else {
            newFm = newFm + `\nlast_hit: ${today}`;
        }

        const newContent = content.replace(/^---\n[\s\S]*?\n---/, `---\n${newFm}\n---`);
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, newContent, 'utf-8');
        fs.renameSync(tmp, filePath); // atomic on POSIX
    } catch {
        // Non-critical — silently skip if file can't be updated
    }
}

/**
 * Parse MEMORY.md into sections based on schema.
 *
 * @param {string} content - MEMORY.md content
 * @param {object} schema - loaded schema
 * @returns {Array<{name, heading, protected, lines, entries}>}
 */
function parseSections(content, schema) {
    const lines = content.split('\n');
    const sectionDefs = schema.sections || [];
    const headingNames = new Map(sectionDefs.map(s => [s.heading, s]));

    const sections = [];
    let current = { name: '_header', protected: true, lines: [], entries: [] };

    for (const line of lines) {
        const trimmed = line.trimEnd();
        const def = headingNames.get(trimmed);
        if (def) {
            sections.push(current);
            current = {
                name: def.name,
                heading: def.heading,
                protected: def.protected,
                sort: def.sort,
                mutable: def.mutable || false,
                lines: [line],
                entries: [],
            };
        } else {
            current.lines.push(line);
            // Detect index entries: "- [Name](path) — description"
            const entryMatch = trimmed.match(/^- \[.*?\]\((.*?)\)/);
            if (entryMatch) {
                current.entries.push({
                    line,
                    path: entryMatch[1],
                    lineIndex: current.lines.length - 1,
                });
            }
        }
    }
    sections.push(current);
    return sections;
}

/**
 * Rebuild MEMORY.md respecting schema constraints:
 *   - Protected sections: kept as-is, in order
 *   - Evictable sections: entries sorted by weight desc
 *   - Total lines capped at max_lines — lowest-weight entries evicted first
 *
 * @param {string} content - current MEMORY.md content
 * @param {object} schema - loaded schema
 * @param {function} getFileWeight - (relativePath) => number
 * @returns {string} new MEMORY.md content
 */
function rebuildIndex(content, schema, getFileWeight) {
    const maxLines = schema.max_lines || 200;
    const sections = parseSections(content, schema);

    // Sort entries within evictable sections by weight
    for (const section of sections) {
        if (!section.protected && section.sort === 'weight' && section.entries.length > 0) {
            // Calculate weight for each entry
            section.entries.forEach(e => {
                e.weight = getFileWeight(e.path);
            });
            // Sort by weight descending
            section.entries.sort((a, b) => b.weight - a.weight);

            // Rebuild section lines: heading + non-entry lines + sorted entries
            const nonEntryLines = section.lines.filter((_, i) =>
                i === 0 || !section.entries.some(e => e.lineIndex === i)
            );
            // Re-insert: heading, then blank lines/comments, then sorted entries
            section.lines = [
                section.lines[0], // heading
                ...nonEntryLines.slice(1).filter(l => l.trim() === '' || !l.trim().startsWith('- [')),
                ...section.entries.map(e => e.line),
            ];
        }
    }

    // Count total lines
    let totalLines = sections.reduce((sum, s) => sum + s.lines.length, 0);

    // Evict lowest-weight entries if over budget
    if (totalLines > maxLines) {
        // Collect all evictable entries with weights
        const evictable = [];
        for (const section of sections) {
            if (!section.protected && section.entries.length > 0) {
                for (const entry of section.entries) {
                    evictable.push({ entry, section });
                }
            }
        }
        // Sort by weight ascending — evict lowest first
        evictable.sort((a, b) => (a.entry.weight || 0) - (b.entry.weight || 0));

        let toRemove = totalLines - maxLines;
        for (const { entry, section } of evictable) {
            if (toRemove <= 0) break;
            // Remove this entry line from its section
            section.lines = section.lines.filter(l => l !== entry.line);
            section.entries = section.entries.filter(e => e !== entry);
            toRemove--;
        }
    }

    return sections.map(s => s.lines.join('\n')).join('\n');
}

module.exports = { loadSchema, calculateWeight, incrementHits, parseSections, rebuildIndex };
