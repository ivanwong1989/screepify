module.exports = {
    generate: function(room, intel, context, missions) {
        // Full mission-driven adjacent-room scouting.
        // Mission owns: target selection + scheduling. Creep just executes move/hold and records intel via executor/utils.

        const DEFAULT_SCOUT_INTERVAL = 500;
        const MIN_SCOUT_INTERVAL = 25;
        const DEFAULT_HOLD_TIME = 10;

        if (context && context.opState === 'EMERGENCY') return;
        if (!room || !room.controller || room.controller.level < 3) return;

        // If remote missions are disabled globally, do not auto-gen scouts.
        if (Memory.remoteMissionsEnabled === false) return;

        const exits = Game.map.describeExits(room.name);
        if (!exits) return;

        const adjacent = Object.values(exits).filter(r => r);
        if (adjacent.length === 0) return;

        if (!room.memory.overseer) room.memory.overseer = {};
        if (!room.memory.overseer.scout) room.memory.overseer.scout = {};

        const scoutMem = room.memory.overseer.scout;

        const memInterval = Number.isFinite(scoutMem.interval) ? scoutMem.interval : null;
        const interval = Math.max(
            MIN_SCOUT_INTERVAL,
            memInterval !== null ? memInterval : DEFAULT_SCOUT_INTERVAL
        );

        const holdTime = Number.isFinite(scoutMem.holdTime) ? scoutMem.holdTime : DEFAULT_HOLD_TIME;

        if (scoutMem.enabled === undefined) scoutMem.enabled = true;
        if (scoutMem.enabled === false) return;

        if (!Array.isArray(scoutMem.skipRooms)) scoutMem.skipRooms = [];
        if (!scoutMem.rooms) scoutMem.rooms = {};

        const skipSet = new Set(scoutMem.skipRooms || []);
        const roomsMem = scoutMem.rooms;

        const isOwnedRoomWithSpawn = (candidateRoom) => {
            if (!candidateRoom || !candidateRoom.controller || !candidateRoom.controller.my) return false;
            const spawns = candidateRoom.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
            return spawns.length > 0;
        };

        const addSkipRoom = (name) => {
            if (!name) return;
            if (!scoutMem.skipRooms.includes(name)) scoutMem.skipRooms.push(name);
            if (roomsMem && roomsMem[name]) delete roomsMem[name];
            skipSet.add(name);
        };

        const available = [];
        for (const name of adjacent) {
            if (!name) continue;
            if (skipSet.has(name)) continue;

            // Auto-skip adjacent owned rooms (w/ spawn) if visible.
            const visible = Game.rooms[name];
            if (visible && isOwnedRoomWithSpawn(visible)) {
                addSkipRoom(name);
                continue;
            }

            available.push(name);
        }

        if (available.length === 0) return;

        // Ensure memory entries exist for available rooms.
        for (const name of available) {
            if (!roomsMem[name]) roomsMem[name] = { lastScout: 0, lastSeen: 0 };
        }

        const now = Game.time;

        // Pick next target only when due, otherwise scout idles at home.
        const due = available
            .map(name => ({ name, lastScout: (roomsMem[name] && roomsMem[name].lastScout) || 0 }))
            .filter(e => (now - e.lastScout) >= interval);

        let targetRoom = null;
        if (due.length > 0) {
            due.sort((a, b) => {
                if (a.lastScout !== b.lastScout) return a.lastScout - b.lastScout;
                // stable tie-break
                return ('' + a.name).localeCompare('' + b.name);
            });
            targetRoom = due[0].name;
        }

        // Census (assigned scouts for sponsor room)
        const creepList = Object.values(Game.creeps);
        const assigned = creepList.filter(c =>
            c.memory && c.memory.role === 'scout' && c.memory.room === room.name
        );

        const census = {
            count: assigned.length,
            workParts: assigned.reduce((sum, c) => sum + c.getActiveBodyparts(WORK), 0),
            carryParts: assigned.reduce((sum, c) => sum + c.getActiveBodyparts(CARRY), 0)
        };

        const missionName = `scout:${room.name}`;

        missions.push({
            name: missionName,
            type: 'scout',
            archetype: 'scout',
            requirements: {
                archetype: 'scout',
                count: 1
            },
            data: {
                sponsorRoom: room.name,
                rooms: available,
                interval: interval,
                holdTime: holdTime,
                targetRoom: targetRoom,
                adjacentOnly: true
            },
            priority: 20,
            census: census,
            censusLocked: true
        });
    }
};
