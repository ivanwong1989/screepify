const heap = require('utils_heap');

function getOpportunisticDesiredHits(room, st) {
    if (!st || !st.hitsMax) return 0;

    if (st.structureType === STRUCTURE_WALL || st.structureType === STRUCTURE_RAMPART) {
        if (!allowOpportunisticFortify(room)) return 0;
        const policy = room && room.memory && room.memory.overseer && room.memory.overseer.fortifyPolicy;
        const target = policy && Number.isFinite(policy.target) ? policy.target : 0;
        if (target <= 0) return 0;
        return Math.min(target, st.hitsMax);
    }

    return st.hitsMax;
}

function isDireFortifyContext(room) {
    if (!room) return false;
    const combatState = room.memory && room.memory.admiral && room.memory.admiral.state;
    if (combatState === 'DEFEND' || combatState === 'SIEGE') return true;

    if (room._oppFortifyHostilesTick !== Game.time) {
        let hostiles = [];
        if (global.getRoomCache) {
            const cache = global.getRoomCache(room);
            hostiles = (cache && cache.hostiles) ? cache.hostiles : [];
        } else {
            hostiles = room.find(FIND_HOSTILE_CREEPS);
        }
        room._oppFortifyHostilesPresent = !!(hostiles && hostiles.length > 0);
        room._oppFortifyHostilesTick = Game.time;
    }

    return !!room._oppFortifyHostilesPresent;
}

function allowOpportunisticFortify(room) {
    if (!room) return false;
    if (isDireFortifyContext(room)) return true;
    const economyState = room.memory && room.memory.overseer && room.memory.overseer.economyState;
    return economyState === 'UPGRADING';
}

function getOpportunisticRoomTargets(roomName) {
    if (!roomName) return null;
    let store;
    try {
        store = heap && heap.getStore ? heap.getStore('overseerOpportunisticRepair') : null;
    } catch (e) {
        store = null;
    }
    if (!store || !store.rooms) return null;
    const roomStore = store.rooms[roomName];
    if (!roomStore || !Array.isArray(roomStore.targets)) return null;
    return roomStore.targets;
}

function getCreepHashSeed(creep) {
    if (!creep || !creep.name) return 0;
    let h = 0;
    const name = creep.name;
    for (let i = 0; i < name.length; i++) {
        h = ((h * 31) + name.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

function shouldTryOpportunisticRepairThisTick(creep) {
    const seed = getCreepHashSeed(creep) % 10;
    return ((Game.time + seed) % 10) < 3;
}

function tryOpportunisticRepair(creep, currentTask) {
    if (!creep || creep.spawning) return false;
    if (!creep.store || (creep.store[RESOURCE_ENERGY] <= 0.5 * creep.store.getCapacity())) return false;
    if (creep.getActiveBodyparts(WORK) <= 0) return false;

    const action = currentTask && currentTask.action;
    if (action === 'repair') return false;

    const role = creep.memory && creep.memory.role;
    if (role && ['defender', 'brawler', 'drainer', 'assault'].includes(role)) return false;

    const room = creep.room;
    if (!room) return false;
    const combatState = room.memory && room.memory.admiral && room.memory.admiral.state;
    if (combatState === 'SIEGE') return false;

    if (creep._oppRepairTick === Game.time) return false;
    creep._oppRepairTick = Game.time;

    if (!shouldTryOpportunisticRepairThisTick(creep)) return false;

    const targets = getOpportunisticRoomTargets(room.name);
    if (!targets || targets.length === 0) return false;

    let target = null;
    let bestRatio = 1;
    for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (!t || t.roomName !== room.name) continue;
        if (Math.abs(t.x - creep.pos.x) > 3 || Math.abs(t.y - creep.pos.y) > 3) continue;
        if (!creep.pos.inRangeTo(t.x, t.y, 3)) continue;

        const st = Game.getObjectById(t.id);
        if (!st || !st.hitsMax) continue;
        const wallOrRampart = st.structureType === STRUCTURE_WALL || st.structureType === STRUCTURE_RAMPART;
        if (wallOrRampart && !allowOpportunisticFortify(room)) continue;

        const desired = Number.isFinite(t.desiredHits) ? t.desiredHits : getOpportunisticDesiredHits(room, st);
        if (desired <= 0 || st.hits >= desired || st.hits >= (desired * 0.95)) continue;

        const ratio = st.hits / desired;
        if (ratio < bestRatio) {
            bestRatio = ratio;
            target = st;
        }
    }
    if (!target) return false;

    const res = creep.repair(target);
    return res === OK;
}

module.exports = {
    tryOpportunisticRepair,
};
