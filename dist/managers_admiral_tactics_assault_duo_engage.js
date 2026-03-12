// managers_admiral_tactics_assault_duo_engage.js

const threat = require('managers_admiral_tactics_assault_common_threat');
const getHostilesInRoom = threat.getHostilesInRoom;
const filterOutAllies = threat.filterOutAllies;
const isAllyOwner = threat.isAllyOwner;

function toRoomPos(p) {
    if (!p) return null;
    if (p instanceof RoomPosition) return p;
    return new RoomPosition(p.x, p.y, p.roomName || (p.room && p.room.name));
}

function inAO(pos, ao) {
    if (!ao || !ao.centerPos) return true;

    var radius = Number(ao.radius) || 0;
    if (radius <= 0) return true; // radius=0 means "no AO constraint"

    var c = toRoomPos(ao.centerPos);
    if (!c) return true;
    if (!pos || pos.roomName !== c.roomName) return false;

    return c.getRangeTo(pos) <= radius;
}

function isSourceKeeperOwned(o) {
    var owner = o && o.owner;
    var u = owner && owner.username;
    return (typeof u === 'string') && (u.toLowerCase() === 'source keeper');
}

function getBodyPartsCount(creep, type) {
    if (!creep || !creep.body) return 0;

    var count = 0;
    for (var i = 0; i < creep.body.length; i++) {
        var part = creep.body[i];
        if (part.type === type && part.hits > 0) count += 1;
    }
    return count;
}

function findClosestByRangeSafe(creep, list) {
    if (!creep || !list || !list.length) return null;
    return creep.pos.findClosestByRange(list);
}

function selectTarget(creep, flags, ao) {
    if (!creep || !creep.room) return null;

    // HARD AO ROOM GATE
    if (ao && ao.centerPos && creep.room.name !== ao.centerPos.roomName) {
        return null;
    }

    // Hostile creeps in AO, excluding Source Keepers.
    var allHostiles = getHostilesInRoom(creep.room) || [];
    var hostiles = [];
    var i;
    var h;

    for (i = 0; i < allHostiles.length; i++) {
        h = allHostiles[i];
        if (!h) continue;
        if (isSourceKeeperOwned(h)) continue;
        if (!inAO(h.pos, ao)) continue;
        hostiles.push(h);
    }

    // 1) Armed hostiles first
    var armed = [];
    for (i = 0; i < hostiles.length; i++) {
        h = hostiles[i];
        if (getBodyPartsCount(h, ATTACK) > 0 || getBodyPartsCount(h, RANGED_ATTACK) > 0) {
            armed.push(h);
        }
    }
    if (armed.length > 0) {
        return findClosestByRangeSafe(creep, armed);
    }

    // 2) Healers second
    var healers = [];
    for (i = 0; i < hostiles.length; i++) {
        h = hostiles[i];
        if (getBodyPartsCount(h, HEAL) > 0) {
            healers.push(h);
        }
    }
    if (healers.length > 0) {
        return findClosestByRangeSafe(creep, healers);
    }

    // Prefer cache-hostileStructures if present (already filters allies)
    var hostileStructures = [];
    try {
        if (global.getRoomCache) {
            var cache = global.getRoomCache(creep.room);
            if (cache && Array.isArray(cache.hostileStructures)) {
                hostileStructures = cache.hostileStructures;
            }
        }
    } catch (e) {
        // ignore
    }

    // Filter structures safely
    var filteredStructures = [];
    var s;
    for (i = 0; i < hostileStructures.length; i++) {
        s = hostileStructures[i];
        if (!s) continue;
        if (s.structureType === STRUCTURE_CONTROLLER) continue;
        if (s.structureType === STRUCTURE_RAMPART) continue;
        if (s.structureType === STRUCTURE_WALL) continue;
        if (!inAO(s.pos, ao)) continue;
        filteredStructures.push(s);
    }
    hostileStructures = filteredStructures;

    // 3) Towers third
    var towers = [];
    for (i = 0; i < hostileStructures.length; i++) {
        s = hostileStructures[i];
        if (s.structureType === STRUCTURE_TOWER) towers.push(s);
    }
    if (towers.length > 0) {
        return findClosestByRangeSafe(creep, towers);
    }

    // 4) Other hostile creeps
    if (hostiles.length > 0) {
        return findClosestByRangeSafe(creep, hostiles);
    }

    // 5) Other hostile structures
    if (hostileStructures.length > 0) {
        return findClosestByRangeSafe(creep, hostileStructures);
    }

    // --- Fallback: attack weakest wall inside AO ---
    var walls = creep.room.find(FIND_STRUCTURES, {
        filter: function (st) {
            return st.structureType === STRUCTURE_WALL &&
                inAO(st.pos, ao);
        }
    });

    if (walls && walls.length > 0) {
        walls.sort(function (a, b) {
            return a.hits - b.hits;
        });
        return walls[0];
    }

    // Attack flag tile preference (only if inside AO too)
    if (flags &&
        flags.attackPos &&
        flags.attackPos.roomName === creep.room.name &&
        inAO(flags.attackPos, ao)) {

        var structuresAt = creep.room.lookForAt(
            LOOK_STRUCTURES,
            flags.attackPos.x,
            flags.attackPos.y
        );

        var filtered = [];
        if (structuresAt && structuresAt.length) {
            for (i = 0; i < structuresAt.length; i++) {
                s = structuresAt[i];
                if (!s) continue;
                if (s.structureType === STRUCTURE_CONTROLLER) continue;
                if (filterOutAllies([s]).length <= 0) continue;
                filtered.push(s);
            }
        }

        if (filtered.length > 0) return filtered[0];
    }

    // Near AO center fallback
    if (ao && ao.centerPos && ao.centerPos.roomName === creep.room.name) {
        var center = new RoomPosition(ao.centerPos.x, ao.centerPos.y, ao.centerPos.roomName);
        var nearby = center.findInRange(FIND_HOSTILE_STRUCTURES, 3, {
            filter: function (st) {
                return st.structureType !== STRUCTURE_CONTROLLER &&
                    !isAllyOwner(st.owner);
            }
        });

        if (nearby && nearby.length) {
            var nearbyFiltered = [];
            for (i = 0; i < nearby.length; i++) {
                s = nearby[i];
                if (!s) continue;
                if (!inAO(s.pos, ao)) continue;
                nearbyFiltered.push(s);
            }
            if (nearbyFiltered.length > 0) return nearbyFiltered[0];
        }
    }

    return null;
}

module.exports = { selectTarget: selectTarget };