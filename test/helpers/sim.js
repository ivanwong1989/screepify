'use strict';

/**
 * A small single-room Screeps simulator for tests.
 *
 * Covers what the phase-1 economy uses: spawning (energy from spawns and
 * extensions, 3 ticks per part), movement (one tile per tick, no fatigue,
 * no creep stacking), harvest / transfer / withdraw / pickup / drop,
 * build / repair / upgrade, controller levels, source regeneration, spawn
 * energy regen, creep death, dropped-energy decay, and PathFinder over terrain
 * plus cost matrices.
 *
 * Intents are recorded during the loop and applied at end of tick, one per
 * pipeline (work / carry / move), like the real engine. Return codes are
 * validated against start-of-tick state.
 */

const C = require('./constants');

const DIRS = { 1: [0, -1], 2: [1, -1], 3: [1, 0], 4: [1, 1], 5: [0, 1], 6: [-1, 1], 7: [-1, 0], 8: [-1, -1] };
let nextId = 1;
const newId = () => (nextId++).toString(16).padStart(12, '0');

// ---------- Store ----------

class Store {
    constructor(capacity, energyOnly) {
        Object.defineProperty(this, '_cap', { value: capacity, writable: true });
        Object.defineProperty(this, '_energyOnly', { value: !!energyOnly });
        this.energy = 0;
    }
    getCapacity(r) {
        if (this._energyOnly && r && r !== 'energy') return null;
        return this._cap;
    }
    getUsedCapacity(r) {
        if (r) return this[r] || 0;
        let t = 0;
        for (const k in this) t += this[k] || 0;
        return t;
    }
    getFreeCapacity(r) {
        if (this._energyOnly && r && r !== 'energy') return null;
        return this._cap - this.getUsedCapacity();
    }
}

// ---------- RoomPosition ----------

class RoomPosition {
    constructor(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    }
    getRangeTo(a, b) {
        const p = typeof a === 'number' ? { x: a, y: b, roomName: this.roomName } : (a.pos || a);
        if (p.roomName !== this.roomName) return Infinity;
        return Math.max(Math.abs(p.x - this.x), Math.abs(p.y - this.y));
    }
    inRangeTo(a, b, c) {
        if (typeof a === 'number') return this.getRangeTo(a, b) <= c;
        return this.getRangeTo(a) <= b;
    }
    isNearTo(a) {
        return this.getRangeTo(a) <= 1;
    }
    isEqualTo(a, b) {
        const p = typeof a === 'number' ? { x: a, y: b, roomName: this.roomName } : (a.pos || a);
        return p.x === this.x && p.y === this.y && p.roomName === this.roomName;
    }
    getDirectionTo(a, b) {
        const p = typeof a === 'number' ? { x: a, y: b } : (a.pos || a);
        const dx = Math.sign(p.x - this.x);
        const dy = Math.sign(p.y - this.y);
        for (const d in DIRS) if (DIRS[d][0] === dx && DIRS[d][1] === dy) return Number(d);
        return 0;
    }
    findClosestByRange(what, opts) {
        let list = typeof what === 'number' ? global.Game.rooms[this.roomName].find(what) : what;
        if (opts && opts.filter) list = list.filter(opts.filter);
        let best = null;
        let bestR = Infinity;
        for (const o of list) {
            const r = this.getRangeTo(o);
            if (r < bestR) {
                bestR = r;
                best = o;
            }
        }
        return best;
    }
    findInRange(what, range, opts) {
        let list = typeof what === 'number' ? global.Game.rooms[this.roomName].find(what) : what;
        list = list.filter(o => this.getRangeTo(o) <= range);
        if (opts && opts.filter) list = list.filter(opts.filter);
        return list;
    }
    lookFor(type) {
        return global.Game.rooms[this.roomName].lookForAt(type, this.x, this.y);
    }
    findPathTo(target, opts) {
        const p = target.pos || target;
        const range = opts && Number.isFinite(opts.range) ? opts.range : 1;
        const ret = global.PathFinder.search(this, { pos: p, range }, {
            plainCost: 1, swampCost: 5,
            roomCallback: (rn) => global.__simWorld.obstacleMatrix(!(opts && opts.ignoreCreeps))
        });
        let last = this;
        return ret.path.map(step => {
            const d = { x: step.x, y: step.y, dx: step.x - last.x, dy: step.y - last.y, direction: last.getDirectionTo(step) };
            last = step;
            return d;
        });
    }
}

// ---------- Game objects ----------

class RoomObject {
    constructor(world, x, y) {
        this.id = newId();
        this.pos = new RoomPosition(x, y, world.roomName);
        Object.defineProperty(this, '_world', { value: world });
        world.objects.set(this.id, this);
    }
    get room() {
        return this._world.room;
    }
}

class Source extends RoomObject {
    constructor(world, x, y) {
        super(world, x, y);
        this.energy = C.SOURCE_ENERGY_CAPACITY;
        this.energyCapacity = C.SOURCE_ENERGY_CAPACITY;
        this.ticksToRegeneration = C.ENERGY_REGEN_TIME;
    }
}

class Resource extends RoomObject {
    constructor(world, x, y, amount) {
        super(world, x, y);
        this.resourceType = 'energy';
        this.amount = amount;
    }
}

class Structure extends RoomObject {
    constructor(world, x, y, type, hits) {
        super(world, x, y);
        this.structureType = type;
        this.hits = hits;
        this.hitsMax = hits;
        this.my = type !== 'road' && type !== 'container' && type !== 'constructedWall';
        if (this.my) this.owner = { username: 'me' };
    }
}

class StructureController extends Structure {
    constructor(world, x, y) {
        super(world, x, y, 'controller', 0);
        this.my = true;
        this.level = 1;
        this.progress = 0;
        this.progressTotal = C.CONTROLLER_LEVELS[1];
        this.ticksToDowngrade = 20000;
        this.safeMode = undefined;
        this.safeModeAvailable = 1;
        this.owner = { username: 'me' };
        delete this.hits;
        delete this.hitsMax;
    }
    activateSafeMode() {
        return C.OK;
    }
}

class StructureSpawn extends Structure {
    constructor(world, x, y, name) {
        super(world, x, y, 'spawn', 5000);
        this.name = name;
        this.store = new Store(C.SPAWN_ENERGY_CAPACITY, true);
        this.store.energy = C.SPAWN_ENERGY_START;
        this.spawning = null;
    }
    spawnCreep(body, name, opts) {
        if (this.spawning) return C.ERR_BUSY;
        if (global.Game.creeps[name]) return C.ERR_NAME_EXISTS;
        const cost = body.reduce((s, p) => s + C.BODYPART_COST[p], 0);
        if (this._world.energyAvailable() < cost) return C.ERR_NOT_ENOUGH_ENERGY;
        this._world.spendEnergy(cost);
        const creep = new Creep(this._world, this.pos.x, this.pos.y, name, body);
        creep.spawning = true;
        if (!global.Memory.creeps) global.Memory.creeps = {};
        global.Memory.creeps[name] = (opts && opts.memory) || {};
        this.spawning = { name, needTime: body.length * C.CREEP_SPAWN_TIME, remainingTime: body.length * C.CREEP_SPAWN_TIME };
        this._world.stats.spawned.push({ name, body: body.slice(), cost, time: global.Game.time });
        return C.OK;
    }
    renewCreep(creep) {
        if (this.spawning) return C.ERR_BUSY;
        if (!creep || !this.pos.isNearTo(creep.pos)) return C.ERR_NOT_IN_RANGE;
        const add = Math.floor(600 / creep.body.length);
        if (creep.ticksToLive + add > C.CREEP_LIFE_TIME) return C.ERR_FULL;
        const cost = Math.ceil(creep.body.reduce((t, p) => t + C.BODYPART_COST[p.type], 0) / 2.5 / creep.body.length);
        if (this._world.energyAvailable() < cost) return C.ERR_NOT_ENOUGH_ENERGY;
        this._world.spendEnergy(cost);
        creep.ticksToLive += add;
        this._world.stats.renewed = (this._world.stats.renewed || 0) + 1;
        return C.OK;
    }
}

class StoreStructure extends Structure {
    constructor(world, x, y, type, hits, capacity, energyOnly) {
        super(world, x, y, type, hits);
        this.store = new Store(capacity, energyOnly);
    }
}

class StructureTower extends StoreStructure {
    _act(target, power, apply) {
        if (!target || this.store.energy < C.TOWER_ENERGY_COST) return C.ERR_NOT_ENOUGH_ENERGY;
        const r = Math.max(1, this.pos.getRangeTo(target.pos));
        let amount = power;
        if (r >= C.TOWER_FALLOFF_RANGE) amount = power * (1 - C.TOWER_FALLOFF);
        else if (r > C.TOWER_OPTIMAL_RANGE) {
            amount = power * (1 - C.TOWER_FALLOFF * (r - C.TOWER_OPTIMAL_RANGE) / (C.TOWER_FALLOFF_RANGE - C.TOWER_OPTIMAL_RANGE));
        }
        this.store.energy -= C.TOWER_ENERGY_COST;
        apply(Math.floor(amount));
        this._world.stats.towerActions = (this._world.stats.towerActions || 0) + 1;
        return C.OK;
    }
    attack(t) { return this._act(t, C.TOWER_POWER_ATTACK, a => { t.hits -= a; }); }
    heal(t) { return this._act(t, C.TOWER_POWER_HEAL, a => { t.hits = Math.min(t.hitsMax, t.hits + a); }); }
    repair(t) { return this._act(t, C.TOWER_POWER_REPAIR, a => { t.hits = Math.min(t.hitsMax, t.hits + a); }); }
}

class StructureLink extends StoreStructure {
    constructor(world, x, y) {
        super(world, x, y, 'link', 1000, 800, true);
        this.cooldown = 0;
    }
    transferEnergy() { return C.OK; }
}

class ConstructionSite extends RoomObject {
    constructor(world, x, y, type) {
        super(world, x, y);
        this.structureType = type;
        this.progress = 0;
        this.progressTotal = C.CONSTRUCTION_COST[type];
        this.my = true;
    }
}

class Creep extends RoomObject {
    constructor(world, x, y, name, body) {
        super(world, x, y);
        this.name = name;
        this.body = body.map(type => ({ type, hits: 100 }));
        this.hits = body.length * 100;
        this.hitsMax = this.hits;
        this.my = true;
        this.owner = { username: 'me' };
        this.fatigue = 0;
        this.spawning = false;
        this.ticksToLive = undefined;
        const carry = body.filter(p => p === 'carry').length;
        this.store = new Store(carry * C.CARRY_CAPACITY);
        Object.defineProperty(this, '_intents', { value: {}, writable: true });
        global.Game.creeps[name] = this;
    }
    get memory() {
        return global.Memory.creeps[this.name] || (global.Memory.creeps[this.name] = {});
    }
    set memory(v) {
        global.Memory.creeps[this.name] = v;
    }
    getActiveBodyparts(type) {
        return this.body.filter(p => p.type === type && p.hits > 0).length;
    }
    say() {}
    suicide() {
        this.ticksToLive = 1; // removed at the end of this tick
        return C.OK;
    }
    _need(part) {
        return this.getActiveBodyparts(part) > 0;
    }
    move(dir) {
        if (this.spawning) return C.ERR_BUSY;
        if (!DIRS[dir]) return C.ERR_INVALID_ARGS;
        this._intents.move = dir;
        return C.OK;
    }
    moveTo(target, opts) {
        const p = target.pos || target;
        const range = opts && Number.isFinite(opts.range) ? opts.range : 1;
        if (this.pos.inRangeTo(p, range)) return C.OK;
        const path = this.pos.findPathTo(p, { range });
        if (!path.length) return C.ERR_NO_PATH;
        return this.move(path[0].direction);
    }
    harvest(src) {
        if (!this._need('work')) return C.ERR_NO_BODYPART;
        if (!src || !(src instanceof Source)) return C.ERR_INVALID_TARGET;
        if (!this.pos.isNearTo(src)) return C.ERR_NOT_IN_RANGE;
        if (src.energy <= 0) return C.ERR_NOT_ENOUGH_RESOURCES;
        this._intents.work = { a: 'harvest', target: src };
        return C.OK;
    }
    upgradeController(ctrl) {
        if (!this._need('work')) return C.ERR_NO_BODYPART;
        if (!this.pos.inRangeTo(ctrl, 3)) return C.ERR_NOT_IN_RANGE;
        if (this.store.energy <= 0) return C.ERR_NOT_ENOUGH_RESOURCES;
        this._intents.work = { a: 'upgrade', target: ctrl };
        return C.OK;
    }
    build(site) {
        if (!this._need('work')) return C.ERR_NO_BODYPART;
        if (!site || !(site instanceof ConstructionSite)) return C.ERR_INVALID_TARGET;
        if (!this.pos.inRangeTo(site, 3)) return C.ERR_NOT_IN_RANGE;
        if (this.store.energy <= 0) return C.ERR_NOT_ENOUGH_RESOURCES;
        this._intents.work = { a: 'build', target: site };
        return C.OK;
    }
    repair(st) {
        if (!this._need('work')) return C.ERR_NO_BODYPART;
        if (!st || !st.hitsMax) return C.ERR_INVALID_TARGET;
        if (!this.pos.inRangeTo(st, 3)) return C.ERR_NOT_IN_RANGE;
        if (this.store.energy <= 0) return C.ERR_NOT_ENOUGH_RESOURCES;
        this._intents.work = { a: 'repair', target: st };
        return C.OK;
    }
    transfer(target, r, amount) {
        if (!target || !target.store) return C.ERR_INVALID_TARGET;
        if (!this.pos.isNearTo(target)) return C.ERR_NOT_IN_RANGE;
        if ((this.store[r] || 0) <= 0) return C.ERR_NOT_ENOUGH_RESOURCES;
        if (target.store.getFreeCapacity(r) <= 0) return C.ERR_FULL;
        this._intents.carry = { a: 'transfer', target, r, amount };
        return C.OK;
    }
    withdraw(target, r, amount) {
        if (!target || !target.store) return C.ERR_INVALID_TARGET;
        if (!this.pos.isNearTo(target)) return C.ERR_NOT_IN_RANGE;
        if ((target.store[r] || 0) <= 0) return C.ERR_NOT_ENOUGH_RESOURCES;
        if (this.store.getFreeCapacity(r) <= 0) return C.ERR_FULL;
        this._intents.carry = { a: 'withdraw', target, r, amount };
        return C.OK;
    }
    pickup(res) {
        if (!res || !(res instanceof Resource)) return C.ERR_INVALID_TARGET;
        if (!this.pos.isNearTo(res)) return C.ERR_NOT_IN_RANGE;
        if (this.store.getFreeCapacity() <= 0) return C.ERR_FULL;
        this._intents.carry = { a: 'pickup', target: res };
        return C.OK;
    }
    drop(r) {
        if ((this.store[r] || 0) <= 0) return C.ERR_NOT_ENOUGH_RESOURCES;
        this._intents.carry = { a: 'drop', r };
        return C.OK;
    }
    dismantle() { return C.ERR_INVALID_TARGET; }
    reserveController() { return C.ERR_INVALID_TARGET; }
    claimController() { return C.ERR_INVALID_TARGET; }
}

// ---------- PathFinder ----------

class CostMatrix {
    constructor() {
        this._bits = new Uint8Array(2500);
    }
    get(x, y) { return this._bits[y * 50 + x]; }
    set(x, y, v) { this._bits[y * 50 + x] = v; }
    clone() {
        const m = new CostMatrix();
        m._bits.set(this._bits);
        return m;
    }
}

function makePathFinder(world) {
    return {
        CostMatrix,
        search(origin, goal, opts) {
            const goals = Array.isArray(goal) ? goal : [goal];
            const g = goals[0].pos ? goals[0] : { pos: goals[0], range: 0 };
            const range = g.range || 0;
            const plain = (opts && opts.plainCost) || 1;
            const swamp = (opts && opts.swampCost) || 5;
            let matrix = null;
            if (opts && opts.roomCallback) {
                const m = opts.roomCallback(origin.roomName);
                if (m === false) return { path: [], ops: 0, cost: 0, incomplete: true };
                if (m) matrix = m;
            }
            const dist = new Float64Array(2500).fill(Infinity);
            const prev = new Int32Array(2500).fill(-1);
            const start = origin.y * 50 + origin.x;
            dist[start] = 0;
            const open = [start];
            let found = -1;
            let ops = 0;
            while (open.length) {
                let bi = 0;
                for (let i = 1; i < open.length; i++) if (dist[open[i]] < dist[open[bi]]) bi = i;
                const cur = open[bi];
                open[bi] = open[open.length - 1];
                open.pop();
                ops++;
                const cx = cur % 50;
                const cy = (cur - cx) / 50;
                if (Math.max(Math.abs(cx - g.pos.x), Math.abs(cy - g.pos.y)) <= range) {
                    found = cur;
                    break;
                }
                for (const d in DIRS) {
                    const nx = cx + DIRS[d][0];
                    const ny = cy + DIRS[d][1];
                    if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
                    const t = world.terrain[ny * 50 + nx];
                    if (t === C.TERRAIN_MASK_WALL) continue;
                    let cost = matrix ? matrix.get(nx, ny) : 0;
                    if (cost === 255) continue;
                    if (cost === 0) cost = t === C.TERRAIN_MASK_SWAMP ? swamp : plain;
                    const n = ny * 50 + nx;
                    const nd = dist[cur] + cost;
                    if (nd < dist[n]) {
                        if (dist[n] === Infinity) open.push(n);
                        dist[n] = nd;
                        prev[n] = cur;
                    }
                }
            }
            if (found === -1) return { path: [], ops, cost: 0, incomplete: true };
            const path = [];
            for (let n = found; n !== start; n = prev[n]) path.push(new RoomPosition(n % 50, Math.floor(n / 50), origin.roomName));
            path.reverse();
            return { path, ops, cost: dist[found], incomplete: false };
        }
    };
}

// ---------- World ----------

/**
 * @param {{roomName?: string, walls?: Array<[number, number]>, swamps?: Array<[number, number]>,
 *          spawn: [number, number], sources: Array<[number, number]>, controller: [number, number],
 *          time?: number, cpuLimit?: number}} spec
 */
function createWorld(spec) {
    nextId = 1;
    const roomName = spec.roomName || 'W1N1';
    const world = {
        roomName,
        objects: new Map(),
        terrain: new Uint8Array(2500),
        stats: { spawned: [], died: [], errors: [], logs: [] },
        room: null
    };
    for (let i = 0; i < 50; i++) {
        for (const [x, y] of [[i, 0], [i, 49], [0, i], [49, i]]) world.terrain[y * 50 + x] = C.TERRAIN_MASK_WALL;
    }
    for (const [x, y] of spec.walls || []) world.terrain[y * 50 + x] = C.TERRAIN_MASK_WALL;
    for (const [x, y] of spec.swamps || []) world.terrain[y * 50 + x] = C.TERRAIN_MASK_SWAMP;

    Object.assign(global, C, {
        RoomPosition, Creep, Source, Resource, Structure, StructureSpawn, StructureController, ConstructionSite,
        Tombstone: class Tombstone {}, Ruin: class Ruin {}, PowerCreep: class PowerCreep {}
    });
    global.PathFinder = makePathFinder(world);
    global.Memory = { creeps: {} };
    global.RawMemory = { segments: {}, _active: [], _parsed: undefined, setActiveSegments(ids) { this._active = ids.slice(); } };
    global.RawMemory._parsed = global.Memory;
    let cpuUsed = 0;
    global.Game = {
        time: spec.time || 1,
        shard: { name: 'shard3' },
        cpu: { limit: spec.cpuLimit || 20, tickLimit: 500, bucket: 10000, getUsed: () => cpuUsed, generatePixel: () => C.OK },
        gcl: { level: 1, progress: 0, progressTotal: 1000000 },
        creeps: {},
        rooms: {},
        spawns: {},
        flags: {},
        map: { findRoute: () => [] },
        getObjectById: (id) => world.objects.get(id) || null
    };
    world.setCpu = (v) => { cpuUsed = v; };

    const structures = [];
    const sites = [];
    const sources = spec.sources.map(([x, y]) => new Source(world, x, y));
    const controller = new StructureController(world, spec.controller[0], spec.controller[1]);
    const spawn = new StructureSpawn(world, spec.spawn[0], spec.spawn[1], 'Spawn1');
    structures.push(spawn);
    global.Game.spawns.Spawn1 = spawn;
    const dropped = [];

    world.structures = structures;
    world.sites = sites;
    world.sources = sources;
    world.dropped = dropped;
    world.controller = controller;
    world.energyAvailable = () => structures.filter(s => s.structureType === 'spawn' || s.structureType === 'extension')
        .reduce((t, s) => t + s.store.energy, 0);
    world.spendEnergy = (cost) => {
        const fill = structures.filter(s => s.structureType === 'spawn').concat(structures.filter(s => s.structureType === 'extension'));
        for (const s of fill) {
            const take = Math.min(cost, s.store.energy);
            s.store.energy -= take;
            cost -= take;
            if (cost <= 0) break;
        }
    };
    world.creepList = () => Object.values(global.Game.creeps);
    /** Hostile creeps (not in Game.creeps; they stand still). */
    world.hostiles = [];
    world.addHostile = (x, y, body, owner) => {
        const h = new Creep(world, x, y, `hostile_${world.hostiles.length}`, body);
        h.my = false;
        h.owner = { username: owner || 'Invader' };
        h.ticksToLive = 1500;
        world.hostiles.push(h);
        return h;
    };

    const room = {
        name: roomName,
        controller,
        memory: undefined,
        get storage() { return structures.find(s => s.structureType === 'storage'); },
        get terminal() { return structures.find(s => s.structureType === 'terminal'); },
        get energyAvailable() { return world.energyAvailable(); },
        get energyCapacityAvailable() {
            return structures.filter(s => s.structureType === 'spawn' || s.structureType === 'extension')
                .reduce((t, s) => t + s.store.getCapacity('energy'), 0);
        },
        getTerrain() { return { get: (x, y) => world.terrain[y * 50 + x] }; },
        find(type, opts) {
            let out;
            switch (type) {
                case C.FIND_SOURCES: out = sources.slice(); break;
                case C.FIND_SOURCES_ACTIVE: out = sources.filter(s => s.energy > 0); break;
                case C.FIND_CREEPS: out = world.creepList().filter(c => !c.spawning).concat(world.hostiles); break;
                case C.FIND_MY_CREEPS: out = world.creepList().filter(c => !c.spawning); break;
                case C.FIND_HOSTILE_CREEPS: out = world.hostiles.slice(); break;
                case C.FIND_STRUCTURES: out = structures.concat([controller]); break;
                case C.FIND_MY_STRUCTURES: out = structures.filter(s => s.my).concat([controller]); break;
                case C.FIND_MY_SPAWNS: out = structures.filter(s => s.structureType === 'spawn'); break;
                case C.FIND_CONSTRUCTION_SITES:
                case C.FIND_MY_CONSTRUCTION_SITES: out = sites.slice(); break;
                case C.FIND_DROPPED_RESOURCES: out = dropped.slice(); break;
                default: out = [];
            }
            return opts && opts.filter ? out.filter(opts.filter) : out;
        },
        lookForAt(type, x, y) {
            if (typeof x === 'object') {
                const p = x.pos || x;
                y = p.y;
                x = p.x;
            }
            const at = (o) => o.pos.x === x && o.pos.y === y;
            if (type === C.LOOK_STRUCTURES) return structures.concat([controller]).filter(at);
            if (type === C.LOOK_CREEPS) return world.creepList().filter(c => !c.spawning && at(c));
            if (type === C.LOOK_CONSTRUCTION_SITES) return sites.filter(at);
            if (type === C.LOOK_RESOURCES) return dropped.filter(at);
            return [];
        },
        createConstructionSite(x, y, type) {
            const allowed = (C.CONTROLLER_STRUCTURES[type] || {})[controller.level] || 0;
            const have = structures.filter(s => s.structureType === type).length + sites.filter(s => s.structureType === type).length;
            if (have >= allowed) return C.ERR_RCL_NOT_ENOUGH;
            if (world.terrain[y * 50 + x] === C.TERRAIN_MASK_WALL) return C.ERR_INVALID_TARGET;
            if (sites.some(s => s.pos.x === x && s.pos.y === y)) return C.ERR_INVALID_TARGET;
            if (structures.some(s => s.pos.x === x && s.pos.y === y && (type !== 'road') === (s.structureType !== 'road'))) return C.ERR_INVALID_TARGET;
            sites.push(new ConstructionSite(world, x, y, type));
            return C.OK;
        }
    };
    world.room = room;
    global.Game.rooms[roomName] = room;
    global.Memory.rooms = {};
    Object.defineProperty(room, 'memory', { get: () => global.Memory.rooms[roomName] || (global.Memory.rooms[roomName] = {}) });

    world.addStructure = (type, x, y) => {
        let s;
        const cap = { extension: C.EXTENSION_ENERGY_CAPACITY[controller.level], container: C.CONTAINER_CAPACITY, storage: C.STORAGE_CAPACITY, terminal: 300000, tower: C.TOWER_CAPACITY }[type];
        if (type === 'tower') s = new StructureTower(world, x, y, type, 3000, cap, true);
        else if (type === 'link') s = new StructureLink(world, x, y);
        else if (cap) s = new StoreStructure(world, x, y, type, type === 'container' ? C.CONTAINER_HITS : 1000, cap, type !== 'storage' && type !== 'container' && type !== 'terminal');
        else s = new Structure(world, x, y, type, type === 'road' ? C.ROAD_HITS : 1000);
        if (type === 'terminal') s.cooldown = 0;
        structures.push(s);
        return s;
    };

    /** Applies all intents and advances the world by one tick. */
    world.endTick = () => {
        const creeps = world.creepList();
        // Carry pipeline.
        for (const c of creeps) {
            const it = c._intents.carry;
            if (!it) continue;
            if (it.a === 'transfer') {
                const amt = Math.min(it.amount || Infinity, c.store[it.r] || 0, it.target.store.getFreeCapacity(it.r));
                if (amt > 0) {
                    c.store[it.r] -= amt;
                    it.target.store[it.r] = (it.target.store[it.r] || 0) + amt;
                }
            } else if (it.a === 'withdraw') {
                const amt = Math.min(it.amount || Infinity, it.target.store[it.r] || 0, c.store.getFreeCapacity(it.r));
                if (amt > 0) {
                    it.target.store[it.r] -= amt;
                    c.store[it.r] = (c.store[it.r] || 0) + amt;
                }
            } else if (it.a === 'pickup') {
                if (dropped.indexOf(it.target) !== -1) {
                    const amt = Math.min(it.target.amount, c.store.getFreeCapacity());
                    it.target.amount -= amt;
                    c.store.energy += amt;
                }
            } else if (it.a === 'drop') {
                const amt = c.store[it.r] || 0;
                c.store[it.r] = 0;
                world.dropEnergy(c.pos.x, c.pos.y, amt);
            }
        }
        // Work pipeline.
        for (const c of creeps) {
            const it = c._intents.work;
            if (!it) continue;
            const w = c.getActiveBodyparts('work');
            if (it.a === 'harvest') {
                const amt = Math.min(w * C.HARVEST_POWER, it.target.energy);
                it.target.energy -= amt;
                const keep = Math.min(amt, c.store.getFreeCapacity());
                c.store.energy += keep;
                if (amt > keep) world.dropEnergy(c.pos.x, c.pos.y, amt - keep);
            } else if (it.a === 'upgrade') {
                const amt = Math.min(w, c.store.energy);
                c.store.energy -= amt;
                controller.progress += amt;
                world.stats.upgraded = (world.stats.upgraded || 0) + amt;
                if (controller.level < 8 && controller.progress >= controller.progressTotal) {
                    controller.progress -= controller.progressTotal;
                    controller.level++;
                    controller.progressTotal = C.CONTROLLER_LEVELS[controller.level] || 0;
                    for (const s of structures) {
                        if (s.structureType === 'extension') s.store._cap = C.EXTENSION_ENERGY_CAPACITY[controller.level];
                    }
                }
            } else if (it.a === 'build') {
                if (sites.indexOf(it.target) === -1) continue;
                const amt = Math.min(w * C.BUILD_POWER, c.store.energy, it.target.progressTotal - it.target.progress);
                c.store.energy -= amt;
                it.target.progress += amt;
                if (it.target.progress >= it.target.progressTotal) {
                    sites.splice(sites.indexOf(it.target), 1);
                    world.objects.delete(it.target.id);
                    world.addStructure(it.target.structureType, it.target.pos.x, it.target.pos.y);
                    world.stats.built = (world.stats.built || 0) + 1;
                }
            } else if (it.a === 'repair') {
                const amt = Math.min(w, c.store.energy);
                c.store.energy -= amt;
                it.target.hits = Math.min(it.target.hitsMax, it.target.hits + amt * C.REPAIR_POWER);
            }
        }
        // Movement: no stacking; swaps allowed; a creep may step into a tile
        // vacated this tick (resolved in passes until nothing changes, like the engine).
        const occupied = new Map();
        for (const c of creeps) if (!c.spawning) occupied.set(c.pos.y * 50 + c.pos.x, c);
        const moved = new Set();
        let progress = true;
        while (progress) {
            progress = false;
            for (const c of creeps) {
                const dir = c._intents.move;
                if (!dir || c.spawning || moved.has(c)) continue;
                const nx = c.pos.x + DIRS[dir][0];
                const ny = c.pos.y + DIRS[dir][1];
                if (nx < 1 || nx > 48 || ny < 1 || ny > 48) continue;
                if (world.terrain[ny * 50 + nx] === C.TERRAIN_MASK_WALL) continue;
                const blocker = structures.concat([controller]).find(s => s.pos.x === nx && s.pos.y === ny &&
                    C.OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1);
                if (blocker || sources.some(s => s.pos.x === nx && s.pos.y === ny)) continue;
                const other = occupied.get(ny * 50 + nx);
                if (other && other !== c) {
                    const od = other._intents.move;
                    const swaps = od && other.pos.x + DIRS[od][0] === c.pos.x && other.pos.y + DIRS[od][1] === c.pos.y;
                    if (!swaps) continue;
                }
                if (occupied.get(c.pos.y * 50 + c.pos.x) === c) occupied.delete(c.pos.y * 50 + c.pos.x);
                c.pos = new RoomPosition(nx, ny, roomName);
                occupied.set(ny * 50 + nx, c);
                moved.add(c);
                progress = true;
            }
        }
        for (const c of creeps) c._intents = {};

        // Spawning.
        for (const s of structures) {
            if (s.structureType !== 'spawn') continue;
            if (s.spawning) {
                s.spawning.remainingTime--;
                if (s.spawning.remainingTime <= 0) {
                    const c = global.Game.creeps[s.spawning.name];
                    c.spawning = false;
                    c.ticksToLive = C.CREEP_LIFE_TIME;
                    for (const d in DIRS) {
                        const x = s.pos.x + DIRS[d][0];
                        const y = s.pos.y + DIRS[d][1];
                        if (world.terrain[y * 50 + x] === C.TERRAIN_MASK_WALL || occupied.has(y * 50 + x)) continue;
                        if (structures.some(st => st.pos.x === x && st.pos.y === y && C.OBSTACLE_OBJECT_TYPES.indexOf(st.structureType) !== -1)) continue;
                        c.pos = new RoomPosition(x, y, roomName);
                        occupied.set(y * 50 + x, c);
                        break;
                    }
                    s.spawning = null;
                }
            }
            if (world.energyAvailable() < C.SPAWN_ENERGY_CAPACITY && s.store.energy < C.SPAWN_ENERGY_CAPACITY) s.store.energy++;
        }
        // Hostiles die at 0 hits.
        for (const h of world.hostiles.slice()) {
            if (h.hits > 0) continue;
            world.hostiles.splice(world.hostiles.indexOf(h), 1);
            world.objects.delete(h.id);
            world.stats.killed = (world.stats.killed || 0) + 1;
        }
        // Aging and death (and my creeps at 0 hits).
        for (const c of creeps) {
            if (c.spawning || c.ticksToLive === undefined) continue;
            c.ticksToLive--;
            if (c.hits <= 0) c.ticksToLive = 0;
            if (c.ticksToLive <= 0) {
                if (c.store.energy > 0) world.dropEnergy(c.pos.x, c.pos.y, c.store.energy);
                delete global.Game.creeps[c.name];
                world.objects.delete(c.id);
                world.stats.died.push(c.name);
            }
        }
        // Sources regenerate.
        for (const s of sources) {
            s.ticksToRegeneration--;
            if (s.ticksToRegeneration <= 0) {
                s.energy = s.energyCapacity;
                s.ticksToRegeneration = C.ENERGY_REGEN_TIME;
            }
        }
        // Dropped energy decays.
        for (let i = dropped.length - 1; i >= 0; i--) {
            const r = dropped[i];
            r.amount -= Math.ceil(r.amount / 1000);
            if (r.amount <= 0) {
                dropped.splice(i, 1);
                world.objects.delete(r.id);
            }
        }
        // Segments become readable the tick after they're requested.
        const segs = global.RawMemory.segments;
        world.segStore = world.segStore || {};
        for (const id of Object.keys(segs)) world.segStore[id] = segs[id];
        global.RawMemory.segments = {};
        for (const id of global.RawMemory._active) global.RawMemory.segments[id] = world.segStore[id] || '';
        global.Game.time++;
        cpuUsed = 0;
    };

    world.obstacleMatrix = (withCreeps) => {
        const m = new CostMatrix();
        for (const st of structures.concat([controller])) {
            if (st.structureType === 'road') m.set(st.pos.x, st.pos.y, 1);
            else if (C.OBSTACLE_OBJECT_TYPES.indexOf(st.structureType) !== -1) m.set(st.pos.x, st.pos.y, 255);
        }
        for (const src of sources) m.set(src.pos.x, src.pos.y, 255);
        if (withCreeps) for (const c of world.creepList()) if (!c.spawning) m.set(c.pos.x, c.pos.y, 255);
        return m;
    };
    global.__simWorld = world;

    world.dropEnergy = (x, y, amt) => {
        const box = structures.find(st => st.structureType === 'container' && st.pos.x === x && st.pos.y === y);
        if (box) {
            const into = Math.min(amt, box.store.getFreeCapacity('energy'));
            box.store.energy += into;
            amt -= into;
            if (amt <= 0) return;
        }
        const pile = dropped.find(r => r.pos.x === x && r.pos.y === y);
        if (pile) pile.amount += amt;
        else dropped.push(new Resource(world, x, y, amt));
    };

    return world;
}

module.exports = { createWorld, RoomPosition, Store, C };
