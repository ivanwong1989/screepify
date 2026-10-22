// @ts-check
'use strict';

const cache = require('../services/cache');

/**
 * Builds the TickContext (DESIGN §6) once per tick.
 *
 * Tracked rooms (DESIGN §18.1) = visible rooms that are either owned, or have a
 * kind recorded in Memory.rooms[name].k. Room-scope processes run for each one.
 */

/**
 * @param {Room} room
 * @returns {import('../contracts/ctx').RoomKind|null}
 */
function roomKind(room) {
    const mem = Memory.rooms && Memory.rooms[room.name];
    const recorded = mem && mem.k;
    if (room.controller && room.controller.my) {
        // A claimed room without a spawn is still bootstrapping (parent feeds it).
        if (recorded === 'bootstrap') return 'bootstrap';
        return 'owned';
    }
    return recorded || null;
}

/**
 * @param {import('../config').Config} config
 * @returns {import('../contracts/ctx').TickContext}
 */
function build(config) {
    /** @type {Record<string, import('../contracts/ctx').RoomCtx>} */
    const rooms = {};
    /** @type {import('../contracts/ctx').RoomCtx[]} */
    const roomList = [];
    const missionStore = cache.store('room.missions');
    const names = Object.keys(Game.rooms).sort();
    for (const name of names) {
        const room = Game.rooms[name];
        const kind = roomKind(room);
        if (!kind) continue;
        /** @type {import('../contracts/ctx').RoomCtx} */
        const rc = { name, room, kind };
        // Missions are planned on a cadence and kept on heap between passes.
        const planned = missionStore[name];
        if (planned) {
            rc.missions = planned.list;
            rc.missionsById = planned.byId;
        }
        rooms[name] = rc;
        roomList.push(rc);
    }
    return {
        time: Game.time,
        shard: (Game.shard && Game.shard.name) || 'sim',
        cpu: {
            limit: Game.cpu.limit,
            bucket: Game.cpu.bucket,
            tickLimit: Game.cpu.tickLimit
        },
        config,
        rooms,
        roomList,
        kernel: { burstPending: false, softLimit: Game.cpu.limit }
    };
}

module.exports = { build, roomKind };
