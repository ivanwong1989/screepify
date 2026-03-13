// managers_admiral_tactics_assault_duo_engage.js

const threat = require('managers_admiral_tactics_assault_common_threat');
const getHostilesInRoom = threat.getHostilesInRoom;
const filterOutAllies = threat.filterOutAllies;
const isAllyOwner = threat.isAllyOwner;

var WHITELISTED_STRUCTURE_TARGETS = {};
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_TOWER] = true;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_SPAWN] = true;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_EXTENSION] = true;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_STORAGE] = false;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_TERMINAL] = false;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_FACTORY] = false;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_LAB] = true;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_NUKER] = true;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_POWER_SPAWN] = true;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_LINK] = true;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_OBSERVER] = true;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_EXTRACTOR] = true;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_CONTAINER] = true;
WHITELISTED_STRUCTURE_TARGETS[STRUCTURE_ROAD] = false;

function isWhitelistedStructureTarget(structure) {
    if (!structure || !structure.structureType) return false;
    return !!WHITELISTED_STRUCTURE_TARGETS[structure.structureType];
}

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

function findWeakestByHits(list) {
    if (!list || !list.length) return null;
    list.sort(function (a, b) {
        return a.hits - b.hits;
    });
    return list[0];
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

    if (!hostileStructures || hostileStructures.length === 0) {
        hostileStructures = filterOutAllies(creep.room.find(FIND_HOSTILE_STRUCTURES) || []);
    }

    // Filter structures safely
    var filteredStructures = [];
    var ramparts = [];
    var walls = [];
    var s;
    for (i = 0; i < hostileStructures.length; i++) {
        s = hostileStructures[i];
        if (!s) continue;
        if (s.structureType === STRUCTURE_CONTROLLER) continue;
        if (!inAO(s.pos, ao)) continue;
        if (s.structureType === STRUCTURE_RAMPART) {
            ramparts.push(s);
            continue;
        }
        if (s.structureType === STRUCTURE_WALL) {
            walls.push(s);
            continue;
        }
        if (!isWhitelistedStructureTarget(s)) continue;
        filteredStructures.push(s);
    }
    hostileStructures = filteredStructures;

    // 3) Other hostile creeps (non-dangerous) before structure bashing
    if (hostiles.length > 0) {
        return findClosestByRangeSafe(creep, hostiles);
    }

    // 4) Enemy ramparts next (breach priority once no hostile creeps remain)
    if (ramparts.length > 0) {
        return findWeakestByHits(ramparts);
    }

    // 5) Towers next
    var towers = [];
    for (i = 0; i < hostileStructures.length; i++) {
        s = hostileStructures[i];
        if (s.structureType === STRUCTURE_TOWER) towers.push(s);
    }
    if (towers.length > 0) {
        return findClosestByRangeSafe(creep, towers);
    }

    // 6) Other hostile structures
    if (hostileStructures.length > 0) {
        return findClosestByRangeSafe(creep, hostileStructures);
    }

    // 7) Fallback: attack weakest wall inside AO
    if (walls && walls.length > 0) {
        return findWeakestByHits(walls);
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
