/**
 * Manager for Rampart structures.
 * Default public, but flip to private if any hostile is within range.
 */
const managerRamparts = {
    run: function(room) {
        const cache = global.getRoomCache(room);
        const ramparts = cache.myStructuresByType[STRUCTURE_RAMPART] || [];
        if (ramparts.length === 0) return;

        const hostiles = cache.hostiles || [];

        // If no hostiles, make all ramparts public.
        if (hostiles.length === 0) {
            for (const rampart of ramparts) {
                if (rampart.isPublic !== true) rampart.setPublic(true);
            }
            return;
        }

        for (const rampart of ramparts) {
            const enemyNearby = hostiles.some(h => h.pos.inRangeTo(rampart.pos, 5));
            const shouldBePublic = !enemyNearby;
            if (rampart.isPublic !== shouldBePublic) rampart.setPublic(shouldBePublic);
        }
    }
};

module.exports = managerRamparts;
