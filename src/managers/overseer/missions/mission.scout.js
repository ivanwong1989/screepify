module.exports = {
    generate: function(room, intel, context, missions) {
        const SCOUT_INTERVAL = 1450;
        if (context.state === 'EMERGENCY') return;

        const exits = Game.map.describeExits(room.name);
        if (!exits) return;

        const adjacent = Object.values(exits).filter(r => r);
        if (adjacent.length === 0) return;

        if (!room.memory.overseer) room.memory.overseer = {};
        if (!room.memory.overseer.remote) room.memory.overseer.remote = { rooms: {} };
        if (!room.memory.overseer.remote.rooms) room.memory.overseer.remote.rooms = {};
        if (!Array.isArray(room.memory.overseer.remote.skipRooms)) room.memory.overseer.remote.skipRooms = [];

        const remoteMemory = room.memory.overseer.remote;
        const remoteRooms = remoteMemory.rooms;
        const skipSet = new Set(remoteMemory.skipRooms || []);

        const isOwnedRoomWithSpawn = (candidate) => {
            if (!candidate || !candidate.controller || !candidate.controller.my) return false;
            const spawns = candidate.find(FIND_MY_STRUCTURES, {
                filter: s => s.structureType === STRUCTURE_SPAWN
            });
            return spawns.length > 0;
        };

        const addSkipRoom = (name) => {
            if (!name) return;
            if (!remoteMemory.skipRooms.includes(name)) remoteMemory.skipRooms.push(name);
            if (remoteRooms[name]) delete remoteRooms[name];
        };

        const available = [];
        adjacent.forEach(name => {
            if (skipSet.has(name)) return;
            const visible = Game.rooms[name];
            if (isOwnedRoomWithSpawn(visible)) {
                addSkipRoom(name);
                return;
            }
            available.push(name);
        });

        if (available.length === 0) return;

        available.forEach(name => {
            if (!remoteRooms[name]) remoteRooms[name] = { lastScout: 0 };
        });

        const now = Game.time;
        const dueRooms = available.filter(name => {
            const lastScout = (remoteRooms[name] && remoteRooms[name].lastScout) || 0;
            return (now - lastScout) >= SCOUT_INTERVAL;
        });

        if (dueRooms.length === 0) return;

        const missionName = `scout:${room.name}`;

        const creepList = Object.values(Game.creeps);
        const assigned = creepList.filter(c =>
            c.memory && c.memory.role === 'scout' && c.memory.room === room.name
        );
        const census = {
            count: assigned.length,
            workParts: assigned.reduce((sum, c) => sum + c.getActiveBodyparts(WORK), 0),
            carryParts: assigned.reduce((sum, c) => sum + c.getActiveBodyparts(CARRY), 0)
        };

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
                rooms: dueRooms,
                interval: SCOUT_INTERVAL
            },
            priority: 20,
            census: census,
            censusLocked: true
        });
    }
};
