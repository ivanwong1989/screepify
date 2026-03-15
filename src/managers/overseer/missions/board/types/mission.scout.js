const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');

const DEFAULT_SCOUT_INTERVAL = 500;
const MIN_SCOUT_INTERVAL = 25;
const DEFAULT_HOLD_TIME = 10;

function ensureScoutMemory(room) {
    if (!room.memory.overseer) room.memory.overseer = {};
    if (!room.memory.overseer.scout) room.memory.overseer.scout = {};
    const scoutMem = room.memory.overseer.scout;
    if (scoutMem.enabled === undefined) scoutMem.enabled = true;
    if (!Array.isArray(scoutMem.skipRooms)) scoutMem.skipRooms = [];
    if (!scoutMem.rooms) scoutMem.rooms = {};
    return scoutMem;
}

function isOwnedRoomWithSpawn(candidateRoom) {
    if (!candidateRoom || !candidateRoom.controller || !candidateRoom.controller.my) return false;
    const spawns = candidateRoom.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
    return spawns.length > 0;
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeScoutKey(context.sponsorRoom);
    },

    create(context) {
        const now = Game.time;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'scout',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 20,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: null,
            assigned: { primary: [], support: [] },
            demand: { role: 'scout', count: 0, bodyProfile: 'scout' },
            progress: { stage: 'scouting' },
            meta: {
                legacyName: `scout:${context.sponsorRoom}`
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[mission.sponsorRoom];
        if (!room || !room.controller || !room.controller.my) return false;
        if (room.controller.level < 3) return false;
        if (Memory.remoteMissionsEnabled === false) return false;
        const scoutMem = ensureScoutMemory(room);
        if (scoutMem.enabled === false) return false;
        return true;
    },

    refresh(mission, runtimeCtx) {
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[mission.sponsorRoom];
        if (!room) return;
        const scoutMem = ensureScoutMemory(room);

        const exits = Game.map.describeExits(room.name);
        const adjacent = exits ? Object.values(exits).filter(r => !!r) : [];
        const memInterval = Number.isFinite(scoutMem.interval) ? scoutMem.interval : null;
        const interval = Math.max(MIN_SCOUT_INTERVAL, memInterval !== null ? memInterval : DEFAULT_SCOUT_INTERVAL);
        const holdTime = Number.isFinite(scoutMem.holdTime) ? scoutMem.holdTime : DEFAULT_HOLD_TIME;
        const skipSet = new Set(scoutMem.skipRooms || []);
        const roomsMem = scoutMem.rooms || {};

        const addSkipRoom = (name) => {
            if (!name) return;
            if (!scoutMem.skipRooms.includes(name)) scoutMem.skipRooms.push(name);
            if (roomsMem && roomsMem[name]) delete roomsMem[name];
            skipSet.add(name);
        };

        const available = [];
        for (let i = 0; i < adjacent.length; i++) {
            const name = adjacent[i];
            if (!name || skipSet.has(name)) continue;
            const visible = Game.rooms[name];
            if (visible && isOwnedRoomWithSpawn(visible)) {
                addSkipRoom(name);
                continue;
            }
            available.push(name);
        }

        for (let i = 0; i < available.length; i++) {
            const name = available[i];
            if (!roomsMem[name]) roomsMem[name] = { lastScout: 0, lastSeen: 0 };
        }

        const now = Game.time;
        const due = available
            .map(name => ({ name, lastScout: (roomsMem[name] && roomsMem[name].lastScout) || 0 }))
            .filter(e => e.lastScout <= 0 || (now - e.lastScout) >= interval);

        due.sort((a, b) => {
            if (a.lastScout !== b.lastScout) return a.lastScout - b.lastScout;
            return String(a.name).localeCompare(String(b.name));
        });
        const targetRoom = due.length > 0 ? due[0].name : null;

        mission.meta = mission.meta || {};
        mission.meta.legacyName = mission.meta.legacyName || `scout:${room.name}`;
        mission.meta.interval = interval;
        mission.meta.holdTime = holdTime;
        mission.meta.rooms = available;
        mission.meta.targetRoom = targetRoom;

        mission.requirements = {
            archetype: 'scout',
            minCount: targetRoom ? 1 : 0,
            maxCount: targetRoom ? 1 : 0,
            spawn: !!targetRoom
        };
        mission.demand = {
            role: 'scout',
            count: targetRoom ? Math.max(0, 1 - (mission.assigned && mission.assigned.primary ? mission.assigned.primary.length : 0)) : 0,
            bodyProfile: 'scout'
        };
        mission.data = {
            sponsorRoom: room.name,
            rooms: available,
            interval,
            holdTime,
            targetRoom,
            adjacentOnly: true
        };
        if (targetRoom && mission.assigned && mission.assigned.primary && mission.assigned.primary.length > 0) {
            mission.lastProgressTick = Game.time;
        }
    },

    isComplete() {
        return false;
    },

    toLegacyMission(mission) {
        const req = mission.requirements || {};
        return {
            name: mission.meta && mission.meta.legacyName ? mission.meta.legacyName : `scout:${mission.sponsorRoom}`,
            type: 'scout',
            archetype: 'scout',
            requirements: {
                archetype: 'scout',
                minCount: Number.isFinite(req.minCount) ? req.minCount : 0,
                maxCount: Number.isFinite(req.maxCount) ? req.maxCount : 0,
                spawn: req.spawn !== false
            },
            data: mission.data || {
                sponsorRoom: mission.sponsorRoom,
                rooms: [],
                interval: DEFAULT_SCOUT_INTERVAL,
                holdTime: DEFAULT_HOLD_TIME,
                targetRoom: null,
                adjacentOnly: true
            },
            priority: Number.isFinite(mission.priority) ? mission.priority : 20,
            censusLocked: true
        };
    }
};
