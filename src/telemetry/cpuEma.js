// telemetry/cpuEma.js
'use strict';

const heap = require('utils_heap');

const EMA_WINDOW = 20; // ticks

function getStore() {
    const s = heap.getStore('telemetry'); // shared telemetry heap store
    if (!s.cpu || typeof s.cpu !== 'object') s.cpu = Object.create(null);
    return s.cpu;
}

function getAvgCpu() {
    const cpu = getStore();
    // Fallback to old Memory value if present (migration safety)
    if (Number.isFinite(cpu.avgCpu)) return cpu.avgCpu;
    const legacy = Number(Memory.avgCpu);
    return Number.isFinite(legacy) ? legacy : 0;
}

function tick() {
    const cpuUsed = Game.cpu.getUsed();
    const cpu = getStore();

    const prev = getAvgCpu();
    const next = (prev * (EMA_WINDOW - 1) + cpuUsed) / EMA_WINDOW;

    cpu.avgCpu = next;

    // Optional: keep legacy Memory mirror for one release if you’re paranoid.
    // Comment OUT once you’re confident no other module reads Memory.avgCpu.
    // Memory.avgCpu = next;
}

module.exports = { tick, getAvgCpu };