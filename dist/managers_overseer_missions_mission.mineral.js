module.exports = {
    generate: function(room, intel, context, missions) {
        const { state } = context;
        if (state === 'EMERGENCY') return;
        if (!intel.minerals || intel.minerals.length === 0) return;

        intel.minerals.forEach(mineral => {
            if (!mineral.hasExtractor) return;
            if (mineral.mineralAmount <= 0) return;
            if (mineral.ticksToRegeneration && mineral.ticksToRegeneration > 0) return;
            if (mineral.availableSpaces <= 0) return;

            debug('mission.mineral', `[Mineral] ${room.name} ${mineral.id} type=${mineral.mineralType} ` +
                `amount=${mineral.mineralAmount} regen=${mineral.ticksToRegeneration || 0} container=${!!mineral.containerId}`);

            missions.push({
                name: `mineral:${mineral.id}`,
                type: 'mineral',
                archetype: 'mineral_miner',
                mineralId: mineral.id,
                pos: mineral.pos,
                requirements: {
                    archetype: 'mineral_miner',
                    count: 1
                },
                spawnSlots: [
                    `mineral:${room.name}:${mineral.id}:0`
                ],
                data: {
                    containerId: mineral.containerId,
                    extractorId: mineral.extractorId,
                    resourceType: mineral.mineralType
                },
                priority: 40
            });
        });
    }
};
