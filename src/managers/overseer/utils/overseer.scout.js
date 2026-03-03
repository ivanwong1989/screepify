function getAllies() {
    if (!Array.isArray(Memory.allies)) return [];
    return Memory.allies.map(a => ('' + a).toLowerCase());
}

function isAllyName(name, allies) {
    if (!name) return false;
    const normalized = ('' + name).toLowerCase();
    return Array.isArray(allies) && allies.includes(normalized);
}

function getSponsorScoutMemory(sponsorRoomName) {
    if (!Memory.rooms) Memory.rooms = {};

    const sponsorRoom = Game.rooms[sponsorRoomName];
    const sponsorMemory = sponsorRoom
        ? sponsorRoom.memory
        : (Memory.rooms[sponsorRoomName] = Memory.rooms[sponsorRoomName] || {});

    if (!sponsorMemory.overseer) sponsorMemory.overseer = {};
    if (!sponsorMemory.overseer.scout) sponsorMemory.overseer.scout = {};
    const scoutMem = sponsorMemory.overseer.scout;

    if (scoutMem.enabled === undefined) scoutMem.enabled = true;
    if (!Array.isArray(scoutMem.skipRooms)) scoutMem.skipRooms = [];
    if (!scoutMem.rooms) scoutMem.rooms = {};

    return scoutMem;
}

function isOwnedRoomWithSpawn(room) {
    if (!room || !room.controller || !room.controller.my) return false;
    const spawns = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
    return spawns.length > 0;
}

function addSkipRoom(scoutMem, roomName) {
    if (!scoutMem || !roomName) return;
    if (!scoutMem.skipRooms.includes(roomName)) scoutMem.skipRooms.push(roomName);
    if (scoutMem.rooms && scoutMem.rooms[roomName]) delete scoutMem.rooms[roomName];
}

function computeSourcesInfo(room) {
    const sources = room.find(FIND_SOURCES);
    const containers = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
    const terrain = room.getTerrain();

    return sources.map(source => {
        const nearbyContainers = containers.filter(c => c.pos.inRangeTo(source.pos, 1));
        let availableSpaces = 0;

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const x = source.pos.x + dx;
                const y = source.pos.y + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                const t = terrain.get(x, y);
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
}

function classifyRoomStatus(room, allies) {
    const controller = room.controller;
    const owner = controller && controller.owner ? controller.owner.username : null;
    const reservation = controller && controller.reservation ? controller.reservation.username : null;

    let status = 'empty';
    if (controller) {
        if (controller.my) status = 'owned';
        else if (owner) status = isAllyName(owner, allies) ? 'ally' : 'occupied';
        else if (reservation) status = isAllyName(reservation, allies) ? 'ally' : 'reserved';
    }

    return { status, owner, reservation };
}

function computeThreat(hostiles, hostileAttackers, hostileStructures) {
    let level = 0;
    if (hostiles > 0) level = 1;
    if (hostileAttackers > 0) level = 2;
    if (level >= 2 && hostileStructures > 0) level = 3;
    return level;
}

/**
 * Record intel snapshot for an observed (adjacent) room into the sponsor room memory.
 *
 * @param {string} sponsorRoomName
 * @param {Room} observedRoom
 * @param {{ setLastScout?: boolean }} [opts]
 */
function recordScoutIntel(sponsorRoomName, observedRoom, opts) {
    if (!sponsorRoomName || !observedRoom) return;
    if (observedRoom.name === sponsorRoomName) return;

    const scoutMem = getSponsorScoutMemory(sponsorRoomName);
    if (scoutMem.enabled === false) return;

    if (isOwnedRoomWithSpawn(observedRoom)) {
        addSkipRoom(scoutMem, observedRoom.name);
        return;
    }

    const roomsMem = scoutMem.rooms || (scoutMem.rooms = {});
    const entry = roomsMem[observedRoom.name] || (roomsMem[observedRoom.name] = { lastScout: 0, lastSeen: 0 });

    const allies = getAllies();
    const { status, owner, reservation } = classifyRoomStatus(observedRoom, allies);

    const hostileCreeps = observedRoom.find(FIND_HOSTILE_CREEPS).filter(c => !isAllyName(c.owner && c.owner.username, allies));
    const hostileAttackers = hostileCreeps.filter(c => (c.getActiveBodyparts(ATTACK) || c.getActiveBodyparts(RANGED_ATTACK)));

    const hostileStructures = observedRoom.find(FIND_HOSTILE_STRUCTURES).filter(s => !isAllyName(s.owner && s.owner.username, allies));

    const sources = observedRoom.find(FIND_SOURCES);
    const sourcesInfo = computeSourcesInfo(observedRoom);

    let snapshotStatus = status;
    if (snapshotStatus === 'empty' && (hostileCreeps.length > 0 || hostileStructures.length > 0)) snapshotStatus = 'hostile';

    const now = Game.time;
    entry.lastSeen = now;
    if (opts && opts.setLastScout) entry.lastScout = now;

    entry.status = snapshotStatus;
    entry.owner = owner;
    entry.reservation = reservation;

    entry.hostiles = hostileCreeps.length;
    entry.hostileAttackers = hostileAttackers.length;
    entry.hostileStructures = hostileStructures.length;

    entry.sources = sources.length;
    entry.sourcesInfo = sourcesInfo;

    if (!entry.threat) entry.threat = { level: 0, lastHostileSeen: 0, lastAttackerSeen: 0 };
    entry.threat.level = computeThreat(entry.hostiles, entry.hostileAttackers, entry.hostileStructures);
    if (entry.hostiles > 0) entry.threat.lastHostileSeen = now;
    if (entry.hostileAttackers > 0) entry.threat.lastAttackerSeen = now;
}

module.exports = {
    recordScoutIntel
};
