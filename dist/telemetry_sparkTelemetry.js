'use strict';

const sparkStats = require('utils_sparkStats');

function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

function getCfg() {
    // Backward compatible: if you already toggle this
    const enabled = (Memory.sparkStatsPrint !== false);

    // Central config (override anytime from console)
    if (!Memory.telemetry) Memory.telemetry = {};
    const t = Memory.telemetry;

    // defaults
    if (typeof t.enabled !== 'boolean') t.enabled = true;
    if (typeof t.sampleEvery !== 'number') t.sampleEvery = 5;   // ticks
    if (typeof t.printEvery !== 'number') t.printEvery = 20;    // ticks
    if (typeof t.maxLen !== 'number') t.maxLen = 60;

    // combine toggles
    t.enabled = t.enabled && enabled;

    // Energy scaling config (optional)
    if (typeof t.energyTarget !== 'number') t.energyTarget = 800000; // empire target
    if (typeof t.energyMode !== 'string') t.energyMode = 'pct'; // 'abs' | 'pct' | 'delta'
    // Normalize user input from console (trim/case-insensitive)
    t.energyMode = String(t.energyMode).trim().toLowerCase();
    if (t.energyMode !== 'abs' && t.energyMode !== 'pct' && t.energyMode !== 'delta') {
        t.energyMode = 'pct';
    }

    return t;
}

function totalMyStorageEnergy() {
    let energy = 0;
    for (const rName in Game.rooms) {
        const room = Game.rooms[rName];
        if (!room.controller || !room.controller.my) continue;
        const storage = room.storage;
        if (storage) energy += (storage.store.energy || 0);
    }
    return energy;
}

function sample() {
    const cfg = getCfg();
    if (!cfg.enabled) return;
    if (Game.time % cfg.sampleEvery !== 0) return;

    sparkStats.pushSeries('cpu.now', Game.cpu.getUsed(), { maxLen: cfg.maxLen });
    sparkStats.pushSeries('cpu.ema', Number(Memory.avgCpu || 0), { maxLen: cfg.maxLen });
    sparkStats.pushSeries('cpu.bucket', Game.cpu.bucket, { maxLen: cfg.maxLen });

    // Energy storage (choose a mode that actually has resolution)
    const e = totalMyStorageEnergy();

    if (cfg.energyMode === 'abs') {
        sparkStats.pushSeries('energy.storage', e, { maxLen: cfg.maxLen });
    } else if (cfg.energyMode === 'delta') {
        const last = (typeof Memory._lastTotalStorageE === 'number') ? Memory._lastTotalStorageE : e;
        Memory._lastTotalStorageE = e;
        sparkStats.pushSeries('energy.delta', e - last, { maxLen: cfg.maxLen });
    } else { // 'pct'
        const pct = clamp((e / cfg.energyTarget) * 100, 0, 100);
        sparkStats.pushSeries('energy.pct', pct, { maxLen: cfg.maxLen });
    }
}

function print() {
    const cfg = getCfg();
    if (!cfg.enabled) return;
    if (Game.shard && Game.shard.name !== 'shard3') return;
    if (Game.time % cfg.printEvery !== 0) return;

    console.log(sparkStats.printSeries('cpu.now', { label: 'CPU used' }));
    console.log(sparkStats.printSeries('cpu.ema', { label: 'CPU ema', min: 0, max: Game.cpu.limit }));
    console.log(sparkStats.printSeries('cpu.bucket', { label: 'CPU bucket', min: 0, max: 10000 }));

    if (cfg.energyMode === 'abs') {
        console.log(sparkStats.printSeries('energy.storage', { label: 'Storage E' }));
    } else if (cfg.energyMode === 'delta') {
        console.log(sparkStats.printSeries('energy.delta', { label: 'Storage Δ' }));
    } else {
        console.log(sparkStats.printSeries('energy.pct', { label: 'Storage %', min: 0, max: 100 }));
    }
}

module.exports = { sample, print };
