'use strict';

const sparkStats = require('utils_sparkStats');

function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

function getAcc(cfg) {
    if (!Memory.telemetry) Memory.telemetry = {};
    if (!Memory.telemetry._sparkAcc) {
        Memory.telemetry._sparkAcc = { nextEmit: Game.time + cfg.chartEvery, m: {} };
    }
    const acc = Memory.telemetry._sparkAcc;
    if (!acc.m) acc.m = {};
    if (typeof acc.nextEmit !== 'number') acc.nextEmit = Game.time + cfg.chartEvery;
    return acc;
}

function accAdd(acc, key, value) {
    const m = acc.m;
    if (!m[key]) m[key] = { sum: 0, count: 0, last: 0, min: Infinity, max: -Infinity };
    const s = m[key];
    s.sum += value;
    s.count += 1;
    s.last = value;
    if (value < s.min) s.min = value;
    if (value > s.max) s.max = value;
}

function emitAgg(acc, key, mode) {
    const s = acc.m[key];
    if (!s || s.count <= 0) return null;
    if (mode === 'avg') return s.sum / s.count;
    if (mode === 'sum') return s.sum;
    if (mode === 'min') return s.min;
    if (mode === 'max') return s.max;
    return s.last; // default 'last'
}

function resetAcc(acc) {
    acc.m = {};
}

function getCfg() {

    // Central config (override anytime from console)
    if (!Memory.telemetry) Memory.telemetry = {};
    if (!Memory.telemetry.sparkStatsPrint) Memory.telemetry.sparkStatsPrint = {};
    const t = Memory.telemetry;

    // defaults
    if (typeof t.enabled !== 'boolean') t.enabled = true;
    if (typeof t.sampleEvery !== 'number') t.sampleEvery = 5;   // ticks
    if (typeof t.sampleEverySlow !== 'number') t.sampleEverySlow = 20; // ticks (long-term)
    if (typeof t.chartEvery !== 'number') t.chartEvery = 20; // ticks per spark point (canonical)
    if (typeof t.printEvery !== 'number') t.printEvery = 20;    // ticks
    if (typeof t.maxLen !== 'number') t.maxLen = 120;

    // check that we need telemetry enabled, and also sparkStatsPrint enabled.
    // in future when we have more telemetry, the telemetry enabled will be the master switch
    if(t.sparkStatsPrint === true && t.enabled === true) t.enabled = true;

    return t;
}


function getRoomEconomyTotalStored(room) {
    // Mirror Overseer: storage + logistics containers (exclude mining containers)
    const cache = global.getRoomCache(room);
    const structures = (cache && cache.structuresByType) || {};
    const sources = cache.sources || [];

    const miningContainerIds = new Set();
    for (const s of sources) {
        if (s && s.containerId) miningContainerIds.add(s.containerId);
    }

    const containers = structures[STRUCTURE_CONTAINER] || [];
    let logisticsEnergy = 0;
    for (const c of containers) {
        if (!c) continue;
        if (miningContainerIds.has(c.id)) continue;
        logisticsEnergy += (c.store[RESOURCE_ENERGY] || 0);
    }

    const storageEnergy = room.storage ? (room.storage.store[RESOURCE_ENERGY] || 0) : 0;
    return logisticsEnergy + storageEnergy;
}

function sample() {
    const cfg = getCfg();
    if (!cfg.enabled) return;

    // Fast collection cadence
    if (Game.time % cfg.sampleEvery !== 0) return;

    const acc = getAcc(cfg);

    // ---- collect raw values into accumulator ----
    accAdd(acc, 'cpu.now', Game.cpu.getUsed());
    accAdd(acc, 'cpu.ema', Number(Memory.avgCpu || 0));
    accAdd(acc, 'cpu.bucket', Game.cpu.bucket);

    // Economy (raw)
    let empireTotal = 0;
    let empireAvgSum = 0;
    let empireSampleSum = 0;
    let roomCount = 0;

    for (const rName in Game.rooms) {
        const room = Game.rooms[rName];
        if (!room.controller || !room.controller.my) continue;

        const flow = room.memory &&
                    room.memory.overseer &&
                    room.memory.overseer.economyFlow;
        if (!flow) continue;

        const total = getRoomEconomyTotalStored(room);
        empireTotal += total;

        const avg = Number(flow.avg || 0);
        const samplePerTick = Number(flow.lastPerTick || 0);

        empireAvgSum += avg;
        empireSampleSum += samplePerTick;
        roomCount++;

        // per-room (raw -> last)
        accAdd(acc, `econ.${rName}.total`, total);
        accAdd(acc, `econ.${rName}.avg`, avg);
        accAdd(acc, `econ.${rName}.sample`, samplePerTick);
    }

    if (roomCount > 0) {
        accAdd(acc, 'econ.empire.total', empireTotal);
        accAdd(acc, 'econ.empire.avg', empireAvgSum / roomCount);
        accAdd(acc, 'econ.empire.sample', empireSampleSum / roomCount);
    }

    // ---- emit to sparklines only on canonical chart cadence ----
    if (Game.time < acc.nextEmit) return;

    // CPU: average over the bucket
    {
        const v = emitAgg(acc, 'cpu.now', 'avg');
        sparkStats.pushSeries('cpu.now', v == null ? 0 : v, { maxLen: cfg.maxLen });
    }
    {
        const v = emitAgg(acc, 'cpu.ema', 'last');
        sparkStats.pushSeries('cpu.ema', v == null ? 0 : v, { maxLen: cfg.maxLen });
    }
    {
        const v = emitAgg(acc, 'cpu.bucket', 'last');
        sparkStats.pushSeries('cpu.bucket', v == null ? 0 : v, { maxLen: cfg.maxLen });
    }

    // Economy: last values (already smoothed upstream in Overseer)
    for (const k in acc.m) {
        if (k.startsWith('econ.')) {
            const v = emitAgg(acc, k, 'last');
            sparkStats.pushSeries(k, v == null ? 0 : v, { maxLen: cfg.maxLen });
        }
    }

    // advance next emit + reset bucket
    acc.nextEmit = Game.time + cfg.chartEvery;
    resetAcc(acc);
}

function print() {
    const cfg = getCfg();
    if (!cfg.enabled) return;
    if (Game.shard && Game.shard.name !== 'shard3') return;
    if (Game.time % cfg.printEvery !== 0) return;

    // Build a full list first so we can align all sparklines to the same start column.
    const lines = [];

    // CPU
    lines.push(['cpu.now', { label: 'CPU used' }]);
    lines.push(['cpu.ema', { label: 'CPU ema', min: 0, max: Game.cpu.limit }]);
    lines.push(['cpu.bucket', { label: 'CPU bucket', min: 0, max: 10000 }]);

    // --- Economy flow (Overseer economyFlow.avg / lastPerTick) ---
    lines.push(['econ.empire.total', { label: 'Econ total' }]);
    lines.push(['econ.empire.avg', { label: 'Econ avg (EMA)' }]);
    lines.push(['econ.empire.sample', { label: 'Econ sample/tick' }]);

    // Per-room (optional but super useful)
    for (const rName in Game.rooms) {
        const room = Game.rooms[rName];
        if (!room.controller || !room.controller.my) continue;
        lines.push([`econ.${rName}.avg`, { label: `${rName} avg` }]);
        lines.push([`econ.${rName}.sample`, { label: `${rName} samp` }]);
        lines.push([`econ.${rName}.total`, { label: `${rName} total` }]);
    }

    const labelWidth = lines.reduce((w, [, opts]) => {
        const len = String(opts.label).length;
        return len > w ? len : w;
    }, 0);

    for (const [key, opts] of lines) {
        console.log(sparkStats.printSeries(key, { ...opts, labelWidth }));
    }
}

module.exports = { sample, print };
