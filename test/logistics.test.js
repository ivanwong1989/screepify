'use strict';

/**
 * Logistics model (docs/v2/LOGISTICS.md, step L1): bands, ledger, requests,
 * matcher. The property test is the point: haulers that only take jobs from
 * the matcher never move a resource A → B and then B → A, unless something
 * outside (spawning, towers, sends, mining) changed A or B in between.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorld, Store } = require('./helpers/sim');

createWorld({ spawn: [25, 25], sources: [[10, 10]], controller: [40, 40] });
const bands = require('../src/services/bands');
const ledger = require('../src/services/ledger');
const requests = require('../src/services/requests');
const matcher = require('../src/services/matcher');

const TERMINAL = { energy: 20000, energyMargin: 2000, stock: { X: 3000 }, flushUntargeted: true, rooms: {}, balance: { enabled: false, batch: 0 } };

/** Seeded PRNG (mulberry32). @param {number} seed */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

let nextId = 0;
/** @param {string} type @param {number} cap @param {boolean} energyOnly @param {object} content */
function mk(type, cap, energyOnly, content, x, y) {
    const s = { id: `${type}${nextId++}`, structureType: type, my: type !== 'container', pos: { x: x || 0, y: y || 0 }, store: new Store(cap, energyOnly) };
    Object.assign(s.store, content);
    return s;
}

function world() {
    const storage = mk('storage', 1000000, false, { energy: 300000, X: 20000, O: 10000 }, 25, 25);
    const terminal = mk('terminal', 300000, false, { energy: 5000, O: 5000 }, 26, 25);
    const spawn = mk('spawn', 300, true, { energy: 300 }, 24, 24);
    const ext = [];
    for (let i = 0; i < 10; i++) ext.push(mk('extension', 200, true, { energy: 200 }, 20 + i, 30));
    const towers = [mk('tower', 1000, true, { energy: 1000 }, 30, 20), mk('tower', 1000, true, { energy: 500 }, 31, 20)];
    const mining = mk('container', 2000, false, { energy: 0 }, 10, 11);
    const ctrl = mk('container', 2000, false, { energy: 2000 }, 39, 39);
    const all = [storage, terminal, spawn, ...ext, ...towers, mining, ctrl];
    const info = { terminal: TERMINAL, roomName: 'W1N1', miningContainers: new Set([mining.id]) };
    return { storage, terminal, spawn, ext, towers, mining, ctrl, all, info };
}

test('bands: min ≤ target ≤ max for every store and resource', () => {
    const w = world();
    for (const s of w.all) {
        if (bands.isBuffer(s)) continue;
        for (const res of ['energy', 'X', 'O', 'H']) {
            const b = bands.band(s, res, w.info);
            if (!b) continue;
            assert.ok(b.min <= b.target && b.target <= b.max, `${s.id} ${res} ${JSON.stringify(b)}`);
        }
    }
    assert.deepEqual(bands.band(w.terminal, 'energy', w.info), { min: 18000, target: 20000, max: 22000 });
    assert.deepEqual(bands.band(w.terminal, 'X', w.info), { min: 2850, target: 3000, max: 3150 });
    assert.equal(bands.band(w.terminal, 'H', Object.assign({}, w.info, { terminal: Object.assign({}, TERMINAL, { flushUntargeted: false }) })), null);
});

test('requests: in-flight amounts count, so nothing is filled twice', () => {
    const w = world();
    w.terminal.store.energy = 10000;
    const creep = { spawning: false, memory: { j: { r: 'energy', q: 6000, f: w.storage.id, d: w.terminal.id, s: 'p' } }, store: new Store(1650) };
    const reqs = requests.build(w.all, ledger.build([creep]), w.info);
    const termReq = reqs.byRes.energy.req.find(e => e.id === w.terminal.id);
    assert.equal(termReq.amount, 4000, '20000 − (10000 + 6000 on the way)');
    // A second job for the same deficit takes only what's left.
    const job = matcher.pick(reqs, { cap: 50000, to: new Set([w.terminal.id]) });
    assert.deepEqual(job, { r: 'energy', q: 4000, f: w.storage.id, d: w.terminal.id, s: 'p' });
    assert.equal(matcher.pick(reqs, { cap: 50000, to: new Set([w.terminal.id]), res: 'energy' }), null, 'nothing left in the same tick');
});

test('matcher: requests before offers to the buffer, never buffer → buffer', () => {
    const w = world();
    w.ext[0].store.energy = 0;
    w.terminal.store.energy = 30000;
    const reqs = requests.build(w.all, ledger.build([]), w.info);
    const first = matcher.pick(reqs, { cap: 1000 });
    assert.equal(first.d, w.ext[0].id, 'extension first');
    assert.equal(first.f, w.terminal.id, 'filled from the terminal offer, not storage');
    const jobs = [];
    for (let j; (j = matcher.pick(reqs, { cap: 100000 }));) jobs.push(j);
    assert.ok(jobs.every(j => j.f !== j.d), 'no job to itself');
    assert.ok(!jobs.some(j => j.f === w.storage.id && j.d === w.storage.id), 'never buffer → buffer');
});

/**
 * Runs haulers that only use the matcher against random outside changes.
 * @returns {{moves: any[], reversals: string[]}}
 */
function simulate(seed, ticks) {
    const rand = rng(seed);
    const w = world();
    const byId = Object.fromEntries(w.all.map(s => [s.id, s]));
    const outside = {};
    const touch = (s, t) => { (outside[s.id] || (outside[s.id] = [])).push(t); };
    const caps = [50, 400, 1650, 1650, 1250, 800];
    const haulers = caps.map((c, i) => ({ name: `h${i}`, spawning: false, memory: {}, store: new Store(c), wait: 0 }));
    const moves = [];
    const latch = {};
    for (let t = 1; t <= ticks; t++) {
        // Outside world.
        if (rand() < 0.05) for (const s of [w.spawn, ...w.ext]) if (rand() < 0.5) { s.store.energy = 0; touch(s, t); }
        for (const tw of w.towers) if (rand() < 0.2) { tw.store.energy = Math.max(0, tw.store.energy - Math.floor(rand() * 300)); touch(tw, t); }
        w.mining.store.energy = Math.min(2000, w.mining.store.energy + 10); touch(w.mining, t);
        if (w.ctrl.store.energy > 0) { w.ctrl.store.energy = Math.max(0, w.ctrl.store.energy - 15); touch(w.ctrl, t); }
        if (rand() < 0.002) { w.terminal.store.energy = Math.max(0, w.terminal.store.energy - 11000); touch(w.terminal, t); }
        if (rand() < 0.002) { w.terminal.store.energy += 10000; touch(w.terminal, t); }
        if (rand() < 0.002) { w.terminal.store.X = Math.max(0, (w.terminal.store.X || 0) + (rand() < 0.5 ? -1000 : 1000)); touch(w.terminal, t); }

        const reqs = requests.build(w.all, ledger.build(haulers), w.info, latch);
        for (const h of haulers) {
            if (h.wait > 0) { h.wait--; continue; }
            let j = h.memory.j;
            if (!j) {
                j = matcher.pick(reqs, { cap: h.store.getFreeCapacity() });
                if (!j) continue;
                h.memory.j = j;
                h.pickTick = t;
                h.wait = Math.floor(rand() * 4);
                continue;
            }
            if (j.s === 'p') {
                const src = byId[j.f];
                const n = Math.min(j.q, src.store[j.r] || 0, h.store.getFreeCapacity());
                if (n <= 0) { delete h.memory.j; continue; }
                src.store[j.r] -= n;
                h.store[j.r] = (h.store[j.r] || 0) + n;
                j.q = n;
                j.s = 'd';
                h.wait = Math.floor(rand() * 4);
                continue;
            }
            let dst = byId[j.d];
            if ((dst.store.getFreeCapacity(j.r) || 0) <= 0) {
                const alt = matcher.redirect(reqs, j.r, h.store[j.r], { exclude: j.d });
                if (!alt) continue;
                j.d = alt;
                dst = byId[alt];
            }
            const n = Math.min(h.store[j.r], dst.store.getFreeCapacity(j.r));
            dst.store[j.r] = (dst.store[j.r] || 0) + n;
            h.store[j.r] -= n;
            moves.push({ res: j.r, from: j.f, to: j.d, pick: h.pickTick, done: t, n });
            if (h.store[j.r] > 0) {
                j.q = h.store[j.r];
                j.f = null;
                const alt = matcher.redirect(reqs, j.r, h.store[j.r], { exclude: j.d });
                if (alt) j.d = alt;
            } else {
                delete h.memory.j;
            }
        }
    }
    // Per store and resource, in the order jobs were picked: a store that gave
    // something away must not then be filled with it (or the other way round)
    // unless something outside changed that store in between. That also
    // catches loops through a third store (A → B, C → A).
    const touched = (id, a, b) => (outside[id] || []).some(x => x > a && x <= b);
    const last = {};
    const reversals = [];
    const ordered = moves.slice().sort((x, y) => x.pick - y.pick);
    for (const m of ordered) {
        for (const [id, dir] of [[m.from, 'out'], [m.to, 'in']]) {
            if (!id || id === w.storage.id) continue;
            const key = `${id}:${m.res}`;
            const prev = last[key];
            if (prev && prev.dir !== dir && !touched(id, prev.pick, m.pick)) {
                reversals.push(`${m.res} ${id}: ${prev.dir} at t${prev.pick}, ${dir} at t${m.pick}`);
            }
            last[key] = { dir, pick: m.pick };
        }
    }
    return { moves, reversals };
}

test('property: no ping-pong without an outside change, 20 seeds × 3000 ticks', () => {
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) {
        const { moves, reversals } = simulate(seed, 3000);
        total += moves.length;
        assert.deepEqual(reversals, [], `seed ${seed}`);
    }
    assert.ok(total > 2000, `enough activity (${total} moves)`);
});
