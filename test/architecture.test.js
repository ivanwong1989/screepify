'use strict';

/**
 * Architecture rules (DESIGN §3, PORTING §2), checked on the source:
 * - processes don't import other processes
 * - missions and actions don't import processes
 * - a mission type doesn't import another mission type (missions/index.js is
 *   the registry; missions/shared/* is for helpers)
 * - services don't import processes or missions
 * - no file over 400 lines
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MAX_LINES = 400;

/** @param {string} dir @returns {string[]} */
function files(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...files(p));
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

/** Resolved, src-relative paths of a file's local requires. @param {string} file */
function requires(file) {
    const text = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const m of text.matchAll(/require\('(\.[^']+)'\)/g)) {
        out.push(path.relative(SRC, path.resolve(path.dirname(file), m[1])).replace(/\\/g, '/').replace(/\.js$/, ''));
    }
    return out;
}

const rel = (f) => path.relative(SRC, f).replace(/\\/g, '/').replace(/\.js$/, '');
const area = (r) => r.split('/')[0];
const isMissionType = (r) => area(r) === 'missions' && r.split('/').length === 2 && r !== 'missions/index';

test('imports follow the layer rules', () => {
    const bad = [];
    for (const f of files(SRC)) {
        const from = rel(f);
        for (const to of requires(f)) {
            const a = area(from);
            if (a === 'processes' && area(to) === 'processes') bad.push(`${from} → ${to} (process → process)`);
            if ((a === 'missions' || a === 'actions') && area(to) === 'processes') bad.push(`${from} → ${to} (→ process)`);
            if (a === 'services' && (area(to) === 'processes' || area(to) === 'missions')) bad.push(`${from} → ${to} (service → plugin)`);
            if (isMissionType(from) && isMissionType(to)) bad.push(`${from} → ${to} (mission → mission)`);
        }
    }
    assert.deepEqual(bad, []);
});

test(`no source file over ${MAX_LINES} lines`, () => {
    const big = files(SRC)
        .map(f => ({ f: rel(f), n: fs.readFileSync(f, 'utf8').split('\n').length }))
        .filter(x => x.n > MAX_LINES && !x.f.startsWith('types/'));
    assert.deepEqual(big, []);
});
