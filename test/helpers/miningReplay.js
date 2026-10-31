'use strict';

const path = require('path');
const { createWorld } = require('./sim');
const ROOT = path.join(__dirname, '../..');

function fresh() {
    for (const key of Object.keys(require.cache)) if (key.startsWith(path.join(ROOT, 'src'))) delete require.cache[key];
    delete global.__v2heap;
}

/** Snapshot replay with real terrain, objects, body parts and birth bindings. */
function replayWorld(fixture) {
    const objects = fixture.objects;
    const spawn = objects.find(o => o.type === 'spawn');
    const controller = objects.find(o => o.type === 'controller');
    const sources = objects.filter(o => o.type === 'source');
    const w = createWorld({ roomName: fixture.room, spawn: [spawn.x, spawn.y], sources: sources.map(o => [o.x, o.y]), controller: [controller.x, controller.y], time: fixture.time });
    fresh();
    w.controller.level = controller.level;
    for (let i = 0; i < 2500; i++) w.terrain[i] = Number(fixture.terrain[i]);
    const rekey = (object, id) => { w.objects.delete(object.id); object.id = id; w.objects.set(id, object); };
    sources.forEach((s, i) => { rekey(w.sources[i], s._id); w.sources[i].energy = s.energy; });
    rekey(w.structures.find(s => s.structureType === 'spawn'), spawn._id);
    for (const o of objects) {
        if (['source', 'controller', 'creep'].includes(o.type) || o.type === 'spawn') continue;
        const s = w.addStructure(o.type, o.x, o.y);
        rekey(s, o._id);
        if (o.store && s.store) Object.assign(s.store, o.store);
    }
    for (const o of objects.filter(o => o.type === 'creep')) {
        const c = new Creep(w, o.x, o.y, o.name, o.body);
        c.memory = JSON.parse(JSON.stringify(o.memory));
        c.ticksToLive = o.ttl;
        Object.assign(c.store, o.store);
    }
    Memory.config = { construction: { enabled: false }, pixel: { enabled: false } };
    const runner = harness(w);
    return Object.assign(runner, { fixture });
}

function harness(w) {
    let totalHarvest = 0, calls = 0;
    const bySource = {};
    const firstHarvest = {};
    const wrapped = new WeakSet();
    const runner = {
        world: w, bySource, firstHarvest,
        tick() {
            for (const c of Object.values(Game.creeps)) if (!wrapped.has(c)) {
                wrapped.add(c);
                const harvest = c.harvest.bind(c);
                c.harvest = s => { const r = harvest(s); if (r === OK) { calls++; if (firstHarvest[s.id] === undefined) firstHarvest[s.id] = Game.time; } return r; };
            }
            const intel = require('../../src/processes/sense/intel').gather(w.room);
            const rc = { name: w.roomName, room: w.room, kind: 'owned', intel, state: { op: 'NORMAL', economy: 'STOCKPILING' }, policy: { state: 'GROW', phase: 'STORAGE' } };
            rc.census = require('../../src/processes/sense/census').build(w.roomName);
            const config = require('../../src/config').get();
            const ctx = { time: Game.time, config, rooms: { [w.roomName]: rc }, roomList: [rc] };
            const plan = { rc, ctx, intel, state: rc.state, policy: rc.policy, budget: w.room.energyCapacityAvailable, efficientSources: new Set(intel.sources.map(s => s.id)), census: () => ({ count: 0, work: 0, carry: 0 }) };
            rc.missions = [];
            require('../../src/missions/harvest').generate(plan, rc.missions);
            require('../../src/missions/miningLane').generate(plan, rc.missions);
            rc.missionsById = Object.fromEntries(rc.missions.map(m => [m.id, m]));
            // Mining-lane actions resolve their mission through the published list.
            require('../../src/services/cache').store('room.missions')[rc.name] = { list: rc.missions, byId: rc.missionsById, t: Game.time };
            // Exercise only the source pipeline; workers and general fleet actions
            // require unrelated logistics boards populated by the full kernel.
            rc.census.active = rc.census.active.filter(c => ['miner', 'miningHauler'].includes(c.memory.a));
            require('../../src/processes/act/creeps').run(ctx, rc);
            require('../../src/services/traffic').resolve(w.room);
            // Measure resolved source energy through the simulator, not accepted API calls.
            const before = Object.fromEntries(w.sources.map(s => [s.id, s.energy]));
            const regen = Object.fromEntries(w.sources.map(s => [s.id, s.ticksToRegeneration]));
            w.endTick();
            for (const s of w.sources) {
                if (regen[s.id] <= 1) continue;
                const amount = Math.max(0, before[s.id] - s.energy);
                totalHarvest += amount;
                bySource[s.id] = (bySource[s.id] || 0) + amount;
            }
            runner.rc = rc;
            return rc;
        },
        run(n) { for (let i = 0; i < n; i++) runner.tick(); return runner; },
        reload() { fresh(); },
        get totalHarvest() { return totalHarvest; },
        get calls() { return calls; }
    };
    return runner;
}
module.exports = { replayWorld, harness, fresh };
