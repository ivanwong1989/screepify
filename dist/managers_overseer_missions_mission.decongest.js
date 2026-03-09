function isPassableParkingTile(room, x, y) {
    if (x < 1 || x > 48 || y < 1 || y > 48) return false;

    const terrain = room.getTerrain().get(x, y);
    if (terrain === TERRAIN_MASK_WALL) return false;

    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    for (const s of structures) {
        if (!OBSTACLE_OBJECT_TYPES.includes(s.structureType)) continue;
        if (s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic)) continue;
        return false;
    }

    const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
    for (const site of sites) {
        if (!OBSTACLE_OBJECT_TYPES.includes(site.structureType)) continue;
        if (site.structureType === STRUCTURE_RAMPART) continue;
        return false;
    }

    return true;
}

function pushRingSlots(room, center, radius, slots) {
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const x = center.x + dx;
            const y = center.y + dy;
            if (!isPassableParkingTile(room, x, y)) continue;
            slots.push({ x, y, roomName: center.roomName });
        }
    }
}

function buildParkingSlots(room, flags) {
    const slots = [];
    const used = new Set();

    for (const flag of flags) {
        for (let radius = 1; radius <= 3; radius++) {
            const before = slots.length;
            pushRingSlots(room, flag.pos, radius, slots);
            for (let i = before; i < slots.length; i++) {
                const p = slots[i];
                const key = `${p.roomName}:${p.x}:${p.y}`;
                if (used.has(key)) {
                    slots[i] = null;
                    continue;
                }
                used.add(key);
            }
        }
    }

    return slots.filter(Boolean);
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
