function getAllies() {
    if (!Array.isArray(Memory.allies)) return [];
    return Memory.allies.map(a => ('' + a).toLowerCase());
}

const DEFAULT_SCOUT_INTERVAL = 800;

function isAllyName(name, allies) {
    if (!name) return false;
    const normalized = ('' + name).toLowerCase();
    return allies.includes(normalized);
}

function getAdjacentRooms(roomName) {
    const exits = Game.map.describeExits(roomName);
    if (!exits) return [];
    return Object.values(exits).filter(r => r);
}

function getSponsorRemoteMemory(sponsorRoomName) {
    if (!Memory.rooms) Memory.rooms = {};
    const sponsorRoom = Game.rooms[sponsorRoomName];
    const sponsorMemory = sponsorRoom ? sponsorRoom.memory : (Memory.rooms[sponsorRoomName] = Memory.rooms[sponsorRoomName] || {});
    if (!sponsorMemory.overseer) sponsorMemory.overseer = {};
    if (!sponsorMemory.overseer.remote) sponsorMemory.overseer.remote = { rooms: {} };
    if (!sponsorMemory.overseer.remote.rooms) sponsorMemory.overseer.remote.rooms = {};
    if (!Array.isArray(sponsorMemory.overseer.remote.skipRooms)) sponsorMemory.overseer.remote.skipRooms = [];
    if (sponsorMemory.overseer.remote.enabled === undefined) sponsorMemory.overseer.remote.enabled = true;
    return sponsorMemory.overseer.remote;
}

function ensureRemoteRoomMemory(remoteMemory, adjacentRooms) {
    const remoteRooms = remoteMemory.rooms;
    adjacentRooms.forEach(name => {
        if (!remoteRooms[name]) remoteRooms[name] = { lastScout: 0 };
    });
    return remoteRooms;
}

function isOwnedRoomWithSpawn(room) {
    if (!room || !room.controller || !room.controller.my) return false;
    const spawns = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_SPAWN
    });
    return spawns.length > 0;
}

function addSkipRoom(remoteMemory, roomName) {
    if (!roomName) return;
    const list = remoteMemory.skipRooms;
    if (!list.includes(roomName)) list.push(roomName);
    if (remoteMemory.rooms && remoteMemory.rooms[roomName]) {
        delete remoteMemory.rooms[roomName];
    }
}

function selectScoutTarget(creep, scoutData, adjacentRooms, remoteRooms) {
    const currentTarget = scoutData.targetRoom;
    if (currentTarget && creep.room.name !== currentTarget) return currentTarget;

    const now = Game.time;
    const interval = Number.isFinite(scoutData.interval) ? scoutData.interval : DEFAULT_SCOUT_INTERVAL;
    const stale = adjacentRooms
        .map(name => ({ name, lastScout: (remoteRooms[name] && remoteRooms[name].lastScout) || 0 }))
        .filter(entry => (now - entry.lastScout) >= interval);

    if (stale.length > 0) {
        stale.sort((a, b) => a.lastScout - b.lastScout);
        return stale[0].name;
    }

    if (currentTarget && adjacentRooms.includes(currentTarget)) return currentTarget;

    if (adjacentRooms.length > 0) {
        const sorted = [...adjacentRooms].sort((a, b) => {
            const aLast = (remoteRooms[a] && remoteRooms[a].lastScout) || 0;
            const bLast = (remoteRooms[b] && remoteRooms[b].lastScout) || 0;
            return aLast - bLast;
        });
        return sorted[0];
    }

    return null;
}

function buildScoutMoveTask(creep, targetRoom) {
    if (creep.room.name === targetRoom) {
        return { action: 'move', targetPos: { x: 25, y: 25, roomName: targetRoom }, range: 20 };
    }

    const route = Game.map.findRoute(creep.room.name, targetRoom);
    if (route === ERR_NO_PATH || !Array.isArray(route) || route.length === 0) return null;

    const nextRoom = route[0].room;
    const exitDir = creep.room.findExitTo(nextRoom);
    if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return null;

    const exits = creep.room.find(exitDir);
    if (!exits || exits.length === 0) return null;

    const exitPos = creep.pos.findClosestByRange(exits);
    if (!exitPos) return null;

    return {
        action: 'move',
        targetPos: { x: exitPos.x, y: exitPos.y, roomName: exitPos.roomName },
        range: 0
    };
}

function ensureScoutTask(creep, task) {
    let scoutData = creep.memory.scout || (task && task.scout) || null;
    if (!scoutData) {
        const sponsorRoom = creep.memory.room || creep.room.name;
        scoutData = { sponsorRoom };
    }

    if (!scoutData.sponsorRoom) scoutData.sponsorRoom = creep.memory.room || creep.room.name;
    if (!Number.isFinite(scoutData.interval)) scoutData.interval = DEFAULT_SCOUT_INTERVAL;

    const adjacentRooms = (Array.isArray(scoutData.rooms) && scoutData.rooms.length > 0)
        ? scoutData.rooms
        : getAdjacentRooms(scoutData.sponsorRoom);
    const remoteMemory = getSponsorRemoteMemory(scoutData.sponsorRoom);
    const skipRooms = remoteMemory.skipRooms || [];
    const skipSet = new Set(skipRooms);
    const filteredRooms = adjacentRooms.filter(name => {
        if (skipSet.has(name)) return false;
        const room = Game.rooms[name];
        if (isOwnedRoomWithSpawn(room)) {
            addSkipRoom(remoteMemory, name);
            return false;
        }
        return true;
    });
    scoutData.rooms = filteredRooms;

    if (filteredRooms.length === 0) {
        creep.memory.scout = scoutData;
        return;
    }

    const remoteRooms = ensureRemoteRoomMemory(remoteMemory, filteredRooms);
    const targetRoom = selectScoutTarget(creep, scoutData, filteredRooms, remoteRooms);
    if (!targetRoom) {
        creep.memory.scout = scoutData;
        return;
    }

    scoutData.targetRoom = targetRoom;
    const moveTask = buildScoutMoveTask(creep, targetRoom);
    if (moveTask) {
        moveTask.scout = scoutData;
        creep.memory.task = moveTask;
    } else {
        delete scoutData.targetRoom;
    }
    creep.memory.scout = scoutData;
}

function recordRemoteIntel(creep, scoutData) {
    if (!scoutData || !scoutData.targetRoom || creep.room.name !== scoutData.targetRoom) return;
    const sponsorRoomName = scoutData.sponsorRoom || creep.memory.room;
    if (!sponsorRoomName) return;
    if (creep.room.name === sponsorRoomName) return;

    const remoteMemory = getSponsorRemoteMemory(sponsorRoomName);
    if (isOwnedRoomWithSpawn(creep.room)) {
        addSkipRoom(remoteMemory, creep.room.name);
        return;
    }

    const remoteRooms = ensureRemoteRoomMemory(remoteMemory, [creep.room.name]);
    const allies = getAllies();
    const controller = creep.room.controller;
    const owner = controller && controller.owner ? controller.owner.username : null;
    const reservation = controller && controller.reservation ? controller.reservation.username : null;
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS).filter(c => !isAllyName(c.owner && c.owner.username, allies) && (c.getActiveBodyParts(ATTACK) || c.getActiveBodyParts(RANGED_ATTACK)));
    const hostileStructures = creep.room.find(FIND_HOSTILE_STRUCTURES).filter(s => !isAllyName(s.owner && s.owner.username, allies));
    const sources = creep.room.find(FIND_SOURCES);
    const sourceCount = sources.length;
    const containers = creep.room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER
    });
    const terrain = creep.room.getTerrain();
    const sourcesInfo = sources.map(source => {
        const nearbyContainers = containers.filter(c => c.pos.inRangeTo(source.pos, 1));
        let availableSpaces = 0;
        for (let x = -1; x <= 1; x++) {
            for (let y = -1; y <= 1; y++) {
                if (x === 0 && y === 0) continue;
                const t = terrain.get(source.pos.x + x, source.pos.y + y);
                if (t !== TERRAIN_MASK_WALL) availableSpaces++;
            }
        }

        const container = nearbyContainers.length > 0 ? nearbyContainers[0] : null;
        return {
            id: source.id,
            x: source.pos.x,
            y: source.pos.y,
            roomName: source.pos.roomName,
            availableSpaces,
            hasContainer: !!container,
            containerId: container ? container.id : null,
            containerPos: container ? { x: container.pos.x, y: container.pos.y, roomName: container.pos.roomName } : null
        };
    });

    let status = 'empty';
    if (controller) {
        if (controller.my) status = 'owned';
        else if (owner) status = isAllyName(owner, allies) ? 'ally' : 'occupied';
        else if (reservation) {
            if (creep.owner && reservation === creep.owner.username) status = 'reserved';
            else status = isAllyName(reservation, allies) ? 'ally' : 'reserved';
        }
    }
    if (status === 'empty' && (hostiles.length > 0 || hostileStructures.length > 0)) status = 'hostile';

    const roomIntel = remoteRooms[creep.room.name] || {};
    remoteRooms[creep.room.name] = Object.assign(roomIntel, {
        lastScout: Game.time,
        lastSeen: Game.time,
        status: status,
        owner: owner,
        reservation: reservation,
        hostiles: hostiles.length,
        hostileStructures: hostileStructures.length,
        sources: sourceCount,
        sourcesInfo: sourcesInfo
    });
}

module.exports = {
    ensureScoutTask,
    recordRemoteIntel
};
