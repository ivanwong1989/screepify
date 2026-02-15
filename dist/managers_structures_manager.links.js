/**
 * Manager for Link structures.
 * Handles energy transfers between source links and receiver links (controller/spawn/storage).
 */
const managerLinks = {
    run: function(room) {
        const cache = global.getRoomCache(room);
        const links = cache.myStructuresByType[STRUCTURE_LINK] || [];
        if (links.length < 2) return;

        const sources = cache.sources || [];
        if (sources.length === 0) return;

        const isSourceLink = (link) => sources.some(source => link.pos.inRangeTo(source.pos, 2));
        const sourceLinks = links.filter(isSourceLink);
        if (sourceLinks.length === 0) return;

        const nonSourceLinks = links.filter(link => !sourceLinks.includes(link));
        if (nonSourceLinks.length === 0) return;

        const controller = room.controller;
        const spawns = cache.myStructuresByType[STRUCTURE_SPAWN] || [];

        const controllerLinks = controller
            ? nonSourceLinks.filter(link => link.pos.inRangeTo(controller.pos, 3))
            : [];
        const spawnLinks = spawns.length > 0
            ? nonSourceLinks.filter(link => spawns.some(spawn => link.pos.inRangeTo(spawn.pos, 3)))
            : [];

        let receivers = controllerLinks.length > 0 ? controllerLinks
            : (spawnLinks.length > 0 ? spawnLinks : nonSourceLinks);

        receivers = receivers.filter(link => link.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
        if (receivers.length === 0) return;

        receivers.sort((a, b) =>
            b.store.getFreeCapacity(RESOURCE_ENERGY) - a.store.getFreeCapacity(RESOURCE_ENERGY)
        );

        const senders = sourceLinks
            .filter(link => link.cooldown === 0 && link.store[RESOURCE_ENERGY] > 0)
            .sort((a, b) => b.store[RESOURCE_ENERGY] - a.store[RESOURCE_ENERGY]);

        if (senders.length === 0) return;

        for (const sender of senders) {
            const receiver = receivers.find(link => link.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            if (!receiver) break;

            const amount = Math.min(
                sender.store[RESOURCE_ENERGY],
                receiver.store.getFreeCapacity(RESOURCE_ENERGY)
            );
            if (amount <= 0) continue;

            const result = sender.transferEnergy(receiver, amount);
            if (result === OK) {
                if (typeof debug === 'function') {
                    debug(
                        'structures.links',
                        `[Links] ${room.name} ${sender.id} -> ${receiver.id} `
                    );
                }
            }
        }
    }
};

module.exports = managerLinks;
