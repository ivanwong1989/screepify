function getAllies() {
    if (!Array.isArray(Memory.allies)) return [];
    return Memory.allies.map(a => ('' + a).toLowerCase());
}

const STATIC_REFRESH_TICKS = 200;
const SITES_REFRESH_TICKS = 25;
const REPAIRS_REFRESH_TICKS = 50;

function isAllyName(name, allies) {
    if (!name) return false;
    const normalized = ('' + name).toLowerCase();
    return allies.includes(normalized);
}

function getMyUsername(room) {
    if (room && room.controller && room.controller.my && room.controller.owner) {
        return room.controller.owner.username;
    }
    const spawns = room ? room.find(FIND_MY_SPAWNS) : [];
    if (spawns && spawns.length > 0 && spawns[0].owner) return spawns[0].owner.username;
    return null;
}

function ensureRemoteMemory(room) {
    if (!room.memory.overseer) room.memory.overseer = {};
    if (!room.memory.overseer.remote) room.memory.overseer.remote = { rooms: {} };
    if (!room.memory.overseer.remote.rooms) room.memory.overseer.remote.rooms = {};
    if (!Array.isArray(room.memory.overseer.remote.skipRooms)) room.memory.overseer.remote.skipRooms = [];
    if (room.memory.overseer.remote.enabled === undefined) room.memory.overseer.remote.enabled = true;
    return room.memory.overseer.remote;
}

function computeStatus(room, allies, myUser) {
    const controller = room.controller;
    const owner = controller && controller.owner ? controller.owner.username : null;
    const reservation = controller && controller.reservation ? controller.reservation.username : null;

    let status = 'empty';
    if (controller) {
        if (controller.my) status = 'owned';
        else if (owner) status = isAllyName(owner, allies) ? 'ally' : 'occupied';
        else if (reservation) {
            if (myUser && reservation === myUser) status = 'reserved';
            else status = isAllyName(reservation, allies) ? 'ally' : 'reserved';
        }
    }
    return { status, owner, reservation };
}

function updateEntryFromVision(entry, visibleRoom, myUser, allies) {
    const hostiles = visibleRoom.find(FIND_HOSTILE_CREEPS).filter(c => !isAllyName(c.owner && c.owner.username, allies) && (c.getActiveBodyparts(ATTACK) || c.getActiveBodyparts(RANGED_ATTACK)));
    const hostileStructures = visibleRoom.find(FIND_HOSTILE_STRUCTURES).filter(s => !isAllyName(s.owner && s.owner.username, allies));
    const statusInfo = computeStatus(visibleRoom, allies, myUser);

    const now = Game.time;
    let staticStale = !entry.lastStatic || (now - entry.lastStatic) >= STATIC_REFRESH_TICKS || !Array.isArray(entry.sourcesInfo);
    if (!staticStale && entry.sourcesInfo && entry.sourcesInfo.length > 0) {
        staticStale = entry.sourcesInfo.some(info => info.containerId && !Game.getObjectById(info.containerId));
    }

    if (staticStale) {
        const sources = visibleRoom.find(FIND_SOURCES);
        const containers = visibleRoom.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_CONTAINER
        });
        const terrain = visibleRoom.getTerrain();
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

        entry.sources = sources.length;
        entry.sourcesInfo = sourcesInfo;
        entry.lastStatic = now;
    }

    if (!entry.lastSites || (now - entry.lastSites) >= SITES_REFRESH_TICKS) {
        const sites = visibleRoom.find(FIND_CONSTRUCTION_SITES);
        entry.sites = sites.map(site => ({
            id: site.id,
            x: site.pos.x,
            y: site.pos.y,
            roomName: site.pos.roomName,
            structureType: site.structureType,
            progress: site.progress,
            progressTotal: site.progressTotal
        }));
        entry.lastSites = now;
    }

    if (!entry.lastRepairs || (now - entry.lastRepairs) >= REPAIRS_REFRESH_TICKS) {
        const repairables = visibleRoom.find(FIND_STRUCTURES, {
            filter: s => (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) &&
                s.hits < s.hitsMax
        });
        const MAX_REMOTE_REPAIR_CACHE = 25;
        entry.repairs = repairables
            .sort((a, b) => {
                const aRatio = a.hitsMax > 0 ? (a.hits / a.hitsMax) : 1;
                const bRatio = b.hitsMax > 0 ? (b.hits / b.hitsMax) : 1;
                return aRatio - bRatio;
            })
            .slice(0, MAX_REMOTE_REPAIR_CACHE)
            .map(s => ({
                id: s.id,
                x: s.pos.x,
                y: s.pos.y,
                roomName: s.pos.roomName,
                structureType: s.structureType,
                hits: s.hits,
                hitsMax: s.hitsMax
            }));
        entry.lastRepairs = now;
    }

    entry.lastSeen = now;
    entry.hostiles = hostiles.length;
    entry.hostileStructures = hostileStructures.length;
    entry.status = statusInfo.status;
    entry.owner = statusInfo.owner;
    entry.reservation = statusInfo.reservation;
}

function isEligible(entry, myUser, maxScoutAge) {
    if (!entry) return false;
    const status = entry.status;
    if (!status) return false;
    if (status !== 'reserved') return false;
    if (!entry.reservation || !myUser || entry.reservation !== myUser) return false;
    if ((entry.hostiles || 0) > 0 || (entry.hostileStructures || 0) > 0) return false;
    const lastScout = Number.isFinite(entry.lastScout) ? entry.lastScout : 0;
    if (maxScoutAge && lastScout > 0 && (Game.time - lastScout) > maxScoutAge) return false;
    const sourceCount = Array.isArray(entry.sourcesInfo) ? entry.sourcesInfo.length : (entry.sources || 0);
    if (sourceCount <= 0) return false;
    return true;
}

function getRemoteContext(room, options = {}) {
    if (room._remoteContext && room._remoteContext.time === Game.time) {
        return room._remoteContext.entries || [];
    }

    const remoteMemory = ensureRemoteMemory(room);
    const entries = [];
    const myUser = getMyUsername(room);
    const allies = getAllies();
    const maxScoutAge = Number.isFinite(options.maxScoutAge) ? options.maxScoutAge : 4000;
    const state = options.state || null;
    const skipRooms = new Set(remoteMemory.skipRooms || []);

    const stateOk = state !== 'EMERGENCY';
    const globalEnabled = Memory.remoteMissionsEnabled !== false;
    const roomEnabled = remoteMemory.enabled !== false;
    const remoteEnabled = globalEnabled && roomEnabled;

    for (const name of Object.keys(remoteMemory.rooms || {})) {
        if (skipRooms.has(name)) continue;
        const entry = remoteMemory.rooms[name];
        if (!entry) continue;
        const visible = Game.rooms[name];
        if (visible) updateEntryFromVision(entry, visible, myUser, allies);

        const eligible = isEligible(entry, myUser, maxScoutAge);
        const enabled = stateOk && eligible && remoteEnabled;

        entry.enabled = enabled;
        entries.push({ name, entry, room: visible, enabled });
    }

    room._remoteContext = { time: Game.time, entries };
    return entries;
}

function getRemoteEconomicContext(room, options = {}) {
    return getRemoteContext(room, options);
}

module.exports = {
    ensureRemoteMemory,
    getRemoteContext,
    getRemoteEconomicContext
};
