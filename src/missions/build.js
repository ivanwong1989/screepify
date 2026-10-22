// @ts-check
'use strict';

const state = require('./shared/state');
const { gather } = require('./shared/gather');
const { vacate } = require('./shared/vacate');

/**
 * Construction (port of v1 mission.build + exec/build).
 *
 * One mission at a time: the oldest construction site (FIFO by first seen),
 * with 5 WORK (+2 per RCL above 3) and up to 5 workers.
 */

/**
 * FIFO queue of site ids by first-seen tick, in Memory.rooms[n].bq.
 * @param {Room} room
 * @param {ConstructionSite[]} sites
 */
function queue(room, sites) {
    const mem = /** @type {any} */ (Memory.rooms[room.name] || (Memory.rooms[room.name] = {}));
    const seen = mem.bq || (mem.bq = {});
    /** @type {Set<string>} */
    const live = new Set(sites.map(s => String(s.id)));
    for (const id in seen) if (!live.has(id)) delete seen[id];
    for (const s of sites) if (seen[s.id] === undefined) seen[s.id] = Game.time;
    return Object.keys(seen).sort((a, b) => (seen[a] - seen[b]) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, intel, state: rs } = plan;
    if (intel.sites.length === 0) {
        const mem = /** @type {any} */ (Memory.rooms[rc.name]);
        if (mem && mem.bq) delete mem.bq;
        return;
    }
    if (rs.op === 'EMERGENCY') return;
    const rcl = (rc.room.controller && rc.room.controller.level) || 1;
    const ids = queue(rc.room, intel.sites);
    const site = intel.sites.find(s => s.id === /** @type {any} */ (ids[0]));
    if (!site) return;
    out.push({
        id: `build:${site.id}`,
        type: 'build',
        home: rc.name,
        room: rc.name,
        archetype: 'worker',
        demand: { work: 5 + Math.max(0, rcl - 3) * 2, minCreeps: 1, maxCreeps: 5 },
        spawn: 'pool',
        targetId: site.id,
        pos: site.pos,
        data: { sourceIds: intel.energySourceIds },
        priority: 60
    });
}

/** @type {import('../contracts/mission').MissionType['nextTask']} */
function nextTask(creep, m, rc) {
    state.update(creep);
    if (creep.memory.s === 'working') {
        const site = /** @type {ConstructionSite|null} */ (state.obj(m.targetId));
        if (!site) return null;
        return vacate(creep, 'build', site, 3) || { a: 'build', i: site.id };
    }
    const data = /** @type {any} */ (m.data || {});
    return gather(creep, rc, { allowedIds: data.sourceIds || null });
}

module.exports = { type: 'build', generate, nextTask };
