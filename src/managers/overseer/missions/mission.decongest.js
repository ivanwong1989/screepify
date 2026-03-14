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
    for (const s of structures) {
        if (!OBSTACLE_OBJECT_TYPES.includes(s.structureType)) continue;
        if (s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic)) continue;
        blockedTiles.add(tileIndex(s.pos.x, s.pos.y));
    }

    const sites = room.find(FIND_CONSTRUCTION_SITES);
    for (const site of sites) {
        if (!OBSTACLE_OBJECT_TYPES.includes(site.structureType)) continue;
        if (site.structureType === STRUCTURE_RAMPART) continue;
        blockedTiles.add(tileIndex(site.pos.x, site.pos.y));
    }

    for (const flag of flags) {
        for (let radius = 1; radius <= 3; radius++) {
            pushRingSlots(flag.pos, radius, slotMap, terrain, blockedTiles);
        }
    }

    return Array.from(slotMap.values());
}

module.exports = {
    generate: function(room, intel, context, missions) {
        const parkingFlags = intel.flags.filter(f => f.name.startsWith('Parking'));
        if (parkingFlags.length === 0) return;

        const slotPositions = buildParkingSlots(room, parkingFlags);
        const maxCount = slotPositions.length;
        if (maxCount <= 0) return;

        debug(
            'mission.decongest',
            `[Decongest] ${room.name} parkingFlags=${parkingFlags.length} slots=${maxCount}`
        );

        missions.push({
            name: 'decongest:parking',
            type: 'decongest',
            targetNames: parkingFlags.map(f => f.name),
            data: { slotPositions: slotPositions },
            requirements: {
                minCount: 0,
                maxCount: maxCount,
                spawn: false,
                spawnFromFleet: false
            },
            // Must be lower priority than idle:upgrade (-100).
            priority: -200
        });
    }
};
