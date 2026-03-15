const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');

function tileIndex(x, y) {
    return (y * 50) + x;
}

function isPassableParkingTile(terrain, blockedTiles, x, y) {
    if (x < 1 || x > 48 || y < 1 || y > 48) return false;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
    if (blockedTiles.has(tileIndex(x, y))) return false;
    return true;
}

function pushRingSlots(center, radius, slotMap, terrain, blockedTiles) {
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const x = center.x + dx;
            const y = center.y + dy;
            if (!isPassableParkingTile(terrain, blockedTiles, x, y)) continue;
            const idx = tileIndex(x, y);
            if (slotMap.has(idx)) continue;
            slotMap.set(idx, { x, y, roomName: center.roomName });
        }
    }
}

function buildParkingSlots(room, flags) {
    const terrain = room.getTerrain();
    const blockedTiles = new Set();
    const slotMap = new Map();

    const structures = room.find(FIND_STRUCTURES);
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (!s || !OBSTACLE_OBJECT_TYPES.includes(s.structureType)) continue;
        if (s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic)) continue;
        blockedTiles.add(tileIndex(s.pos.x, s.pos.y));
    }

    const sites = room.find(FIND_CONSTRUCTION_SITES);
    for (let i = 0; i < sites.length; i++) {
        const site = sites[i];
        if (!site || !OBSTACLE_OBJECT_TYPES.includes(site.structureType)) continue;
        if (site.structureType === STRUCTURE_RAMPART) continue;
        blockedTiles.add(tileIndex(site.pos.x, site.pos.y));
    }

    for (let i = 0; i < flags.length; i++) {
        const flag = flags[i];
        for (let radius = 1; radius <= 3; radius++) {
            pushRingSlots(flag.pos, radius, slotMap, terrain, blockedTiles);
        }
    }

    return Array.from(slotMap.values());
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeDecongestKey(context.sponsorRoom, 'parking');
    },

    create(context) {
        const now = Game.time;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'decongest',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : -200,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: null,
            assigned: { primary: [], support: [] },
            demand: { role: 'worker', count: 0, bodyProfile: 'worker' },
            progress: { stage: 'parking' },
            meta: {
                legacyName: 'decongest:parking'
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[mission.sponsorRoom];
        if (!room || !room.controller || !room.controller.my) return false;
        const flags = room.find(FIND_FLAGS, { filter: f => f.name && f.name.startsWith('Parking') });
        return flags.length > 0;
    },

    refresh(mission, runtimeCtx) {
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[mission.sponsorRoom];
        if (!room) return;

        const parkingFlags = room.find(FIND_FLAGS, { filter: f => f.name && f.name.startsWith('Parking') });
        const slotPositions = buildParkingSlots(room, parkingFlags);
        const maxCount = slotPositions.length;

        mission.meta = mission.meta || {};
        mission.meta.legacyName = mission.meta.legacyName || 'decongest:parking';
        mission.requirements = {
            minCount: 0,
            maxCount,
            spawn: false,
            spawnFromFleet: false
        };
        mission.data = {
            slotPositions
        };
        mission.targetNames = parkingFlags.map(f => f.name);
        mission.demand = {
            role: 'worker',
            count: 0,
            bodyProfile: 'worker'
        };
    },

    isComplete() {
        return false;
    },

    toLegacyMission(mission) {
        const req = mission.requirements || {};
        return {
            name: mission.meta && mission.meta.legacyName ? mission.meta.legacyName : 'decongest:parking',
            type: 'decongest',
            targetNames: mission.targetNames || [],
            data: mission.data || { slotPositions: [] },
            requirements: {
                minCount: Number.isFinite(req.minCount) ? req.minCount : 0,
                maxCount: Number.isFinite(req.maxCount) ? req.maxCount : 0,
                spawn: false,
                spawnFromFleet: false
            },
            priority: Number.isFinite(mission.priority) ? mission.priority : -200
        };
    }
};
