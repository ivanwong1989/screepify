// @ts-check
'use strict';

const log = require('../../services/log');
const movement = require('../../services/movement');
const roomData = require('../../services/roomData');

/**
 * Stamp layout + construction builder (DESIGN §12.1, phase 1 stand-in).
 *
 * Layout (once per room, stored in Memory.rooms[n].plan):
 * - roads from the first spawn to each source and the controller
 * - a container at the end of each source road and the controller road
 * - storage and up to 6 tower spots at range 2–3 of the spawn
 * - extensions on a checkerboard around the spawn (the other colour stays
 *   walkable), nearest first, away from exits, sources and the controller
 *
 * Builder (every 50 ticks, and right away when the RCL changes): places sites
 * from the plan up to what the RCL allows, at most 5 open sites, in order
 * spawn → extension → tower → storage → container → road. Containers from
 * RCL 2, roads from RCL 3 (so early workers aren't diverted from upgrading).
 *
 * The phase-2 planner will write the same plan format.
 */

const PLAN_VERSION = 1;
const MAX_OPEN_SITES = 5;
const EXTENSION_COUNT = 60;
const TOWER_COUNT = 6;
const ORDER = [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_CONTAINER, STRUCTURE_TOWER, STRUCTURE_STORAGE, STRUCTURE_ROAD];
const MIN_RCL = { [STRUCTURE_CONTAINER]: 2, [STRUCTURE_ROAD]: 3 };

/**
 * @typedef {{v: number, anchor: number, s: Record<string, number[]>}} RoomPlan
 */

/** @param {number} x @param {number} y */
function idx(x, y) {
    return y * 50 + x;
}

/**
 * @param {Room} room
 * @param {StructureSpawn} spawn
 * @returns {RoomPlan}
 */
function layout(room, spawn) {
    const terrain = room.getTerrain();
    const ax = spawn.pos.x;
    const ay = spawn.pos.y;
    const used = new Set([idx(ax, ay)]);
    const keepClear = new Set();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keepClear.add(idx(ax + dx, ay + dy));

    /** @param {RoomPosition} p @param {number} r */
    const reserveAround = (p, r) => {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) keepClear.add(idx(p.x + dx, p.y + dy));
    };
    for (const s of roomData.sources(room)) reserveAround(s.pos, 1);
    for (const m of roomData.minerals(room)) reserveAround(m.pos, 1);
    if (room.controller) reserveAround(room.controller.pos, 1);

    /** @param {number} x @param {number} y */
    const open = (x, y) => x >= 2 && x <= 47 && y >= 2 && y <= 47 && terrain.get(x, y) !== TERRAIN_MASK_WALL;

    // Roads + containers.
    const roads = [];
    const containers = [];
    const roadSet = new Set();
    /** @param {RoomPosition} goal @param {number} range */
    const road = (goal, range) => {
        const ret = PathFinder.search(spawn.pos, { pos: goal, range }, {
            plainCost: 2, swampCost: 10, maxOps: 4000,
            roomCallback: (rn) => {
                if (rn !== room.name) return false;
                const m = new PathFinder.CostMatrix();
                for (const i of roadSet) m.set(i % 50, Math.floor(i / 50), 1);
                return m;
            }
        });
        if (ret.incomplete || ret.path.length === 0) return;
        const last = ret.path[ret.path.length - 1];
        containers.push(idx(last.x, last.y));
        used.add(idx(last.x, last.y));
        for (let i = 0; i < ret.path.length - 1; i++) {
            const p = ret.path[i];
            const k = idx(p.x, p.y);
            if (!roadSet.has(k)) {
                roadSet.add(k);
                roads.push(k);
            }
        }
    };
    for (const s of roomData.sources(room)) road(s.pos, 1);
    if (room.controller) road(room.controller.pos, 2);

    /** @param {number} x @param {number} y */
    const free = (x, y) => open(x, y) && !used.has(idx(x, y)) && !roadSet.has(idx(x, y)) && !keepClear.has(idx(x, y));

    // Rings around the spawn, nearest first.
    const ring = [];
    for (let r = 2; r <= 12; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                ring.push({ x: ax + dx, y: ay + dy, r });
            }
        }
    }

    /** @param {number} x @param {number} y */
    const openness = (x, y) => {
        let n = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (open(x + dx, y + dy)) n++;
        return n;
    };

    const storage = [];
    const storageCands = ring.filter(p => p.r === 2 && free(p.x, p.y)).sort((a, b) => openness(b.x, b.y) - openness(a.x, a.y));
    if (storageCands.length) {
        const s = storageCands[0];
        storage.push(idx(s.x, s.y));
        used.add(idx(s.x, s.y));
    }

    const parity = (ax + ay) % 2;
    const towers = [];
    for (const p of ring) {
        if (towers.length >= TOWER_COUNT) break;
        if (p.r > 3 || (p.x + p.y) % 2 !== parity || !free(p.x, p.y)) continue;
        towers.push(idx(p.x, p.y));
        used.add(idx(p.x, p.y));
    }

    const extensions = [];
    for (const p of ring) {
        if (extensions.length >= EXTENSION_COUNT) break;
        if ((p.x + p.y) % 2 !== parity || !free(p.x, p.y)) continue;
        extensions.push(idx(p.x, p.y));
        used.add(idx(p.x, p.y));
    }

    return {
        v: PLAN_VERSION,
        anchor: idx(ax, ay),
        s: {
            [STRUCTURE_SPAWN]: [idx(ax, ay)],
            [STRUCTURE_EXTENSION]: extensions,
            [STRUCTURE_TOWER]: towers,
            [STRUCTURE_STORAGE]: storage,
            [STRUCTURE_CONTAINER]: containers,
            [STRUCTURE_ROAD]: roads
        }
    };
}

/**
 * Places construction sites from the plan. Returns how many were placed.
 * @param {Room} room
 * @param {RoomPlan} plan
 */
function build(room, plan) {
    const rcl = room.controller ? room.controller.level : 0;
    let open = roomData.sites(room).length;
    if (open >= MAX_OPEN_SITES) return 0;
    let placed = 0;
    for (const type of ORDER) {
        if (rcl < (MIN_RCL[type] || 1)) continue;
        const allowed = (CONTROLLER_STRUCTURES[type] && CONTROLLER_STRUCTURES[type][rcl]) || 0;
        let have = roomData.byType(room, type).length + roomData.sites(room).filter(s => s.structureType === type).length;
        for (const i of (plan.s[type] || [])) {
            if (open >= MAX_OPEN_SITES || have >= allowed) break;
            const x = i % 50;
            const y = Math.floor(i / 50);
            const here = room.lookForAt(LOOK_STRUCTURES, x, y);
            if (here.some(s => s.structureType === type)) continue;
            if (type !== STRUCTURE_ROAD && here.some(s => s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_RAMPART)) continue;
            if (room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length > 0) continue;
            if (room.createConstructionSite(x, y, type) === OK) {
                open++;
                have++;
                placed++;
            }
        }
        if (open >= MAX_OPEN_SITES) break;
    }
    if (placed > 0) movement.invalidateRoom(room.name);
    return placed;
}

/** @type {import('../../contracts/process').Process & Record<string, any>} */
module.exports = {
    id: 'plan.construction',
    phase: 'PLAN',
    scope: 'room',
    kinds: ['owned'],
    tier: 'normal',
    priority: 50,
    run(ctx, rc) {
        if (!ctx.config.construction.enabled) return;
        const room = rc.room;
        const mem = /** @type {any} */ (Memory.rooms[room.name] || (Memory.rooms[room.name] = {}));
        const rcl = room.controller ? room.controller.level : 0;
        const due = mem.cRcl !== rcl || !mem.cAt || ctx.time - mem.cAt >= 50;
        if (!due) return;

        let plan = /** @type {RoomPlan|undefined} */ (mem.plan);
        if (!plan || plan.v !== PLAN_VERSION) {
            const spawn = roomData.myByType(room, STRUCTURE_SPAWN)[0];
            if (!spawn) return;
            plan = mem.plan = layout(room, spawn);
            log.info(`[layout] ${room.name}: ${plan.s[STRUCTURE_EXTENSION].length} extensions, ` +
                `${plan.s[STRUCTURE_ROAD].length} roads, ${plan.s[STRUCTURE_CONTAINER].length} containers`);
        }
        build(room, /** @type {RoomPlan} */ (plan));
        mem.cRcl = rcl;
        mem.cAt = ctx.time;
    },
    layout,
    build
};
