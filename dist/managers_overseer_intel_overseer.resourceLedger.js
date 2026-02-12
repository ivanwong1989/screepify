/**
 * Overseer Resource Ledger
 * Builds a per-room resource snapshot (totals + per-structure-type totals).
 */

function packStore(store) {
    const out = {};
    if (!store) return out;
    for (const resourceType in store) {
        const amount = store[resourceType];
        if (amount > 0) out[resourceType] = amount;
    }
    return out;
}

function addToTotals(totals, store) {
    if (!store) return;
    for (const resourceType in store) {
        totals[resourceType] = (totals[resourceType] || 0) + store[resourceType];
    }
}

function addStoreEntry(ledger, structure, typeOverride) {
    if (!structure || !structure.store) return;
    const type = typeOverride || structure.structureType;
    const packed = packStore(structure.store);
    const capacity = structure.store.getCapacity();

    addToTotals(ledger.totals, packed);

    if (!ledger.byType[type]) {
        ledger.byType[type] = { totals: {}, capacity: 0, count: 0 };
    }
    addToTotals(ledger.byType[type].totals, packed);
    ledger.byType[type].capacity += capacity;
    ledger.byType[type].count += 1;

    ledger.stores.push({
        id: structure.id,
        type: type,
        capacity: capacity,
        store: packed
    });
}

const overseerResourceLedger = {
    /**
     * Build a per-room resource snapshot.
     * @param {Room} room
     * @param {Object} intel
     */
    gather: function(room, intel) {
        const cache = global.getRoomCache(room);
        const structuresByType = cache.structuresByType || {};

        const ledger = {
            room: room.name,
            time: Game.time,
            totals: {},
            byType: {},
            stores: [],
            energy: {},
            has: {}
        };

        addStoreEntry(ledger, room.storage, STRUCTURE_STORAGE);
        addStoreEntry(ledger, room.terminal, STRUCTURE_TERMINAL);
        (structuresByType[STRUCTURE_CONTAINER] || []).forEach(s => addStoreEntry(ledger, s, STRUCTURE_CONTAINER));
        (structuresByType[STRUCTURE_LAB] || []).forEach(s => addStoreEntry(ledger, s, STRUCTURE_LAB));
        (structuresByType[STRUCTURE_FACTORY] || []).forEach(s => addStoreEntry(ledger, s, STRUCTURE_FACTORY));
        (structuresByType[STRUCTURE_POWER_SPAWN] || []).forEach(s => addStoreEntry(ledger, s, STRUCTURE_POWER_SPAWN));
        (structuresByType[STRUCTURE_NUKER] || []).forEach(s => addStoreEntry(ledger, s, STRUCTURE_NUKER));
        (structuresByType[STRUCTURE_LINK] || []).forEach(s => addStoreEntry(ledger, s, STRUCTURE_LINK));

        const getEnergy = (type) => {
            return (ledger.byType[type] && ledger.byType[type].totals[RESOURCE_ENERGY]) || 0;
        };

        ledger.energy.total = ledger.totals[RESOURCE_ENERGY] || 0;
        ledger.energy.storage = getEnergy(STRUCTURE_STORAGE);
        ledger.energy.terminal = getEnergy(STRUCTURE_TERMINAL);
        ledger.energy.containers = getEnergy(STRUCTURE_CONTAINER);
        ledger.energy.labs = getEnergy(STRUCTURE_LAB);
        ledger.energy.links = getEnergy(STRUCTURE_LINK);
        ledger.energy.other = ledger.energy.total
            - ledger.energy.storage
            - ledger.energy.terminal
            - ledger.energy.containers
            - ledger.energy.labs
            - ledger.energy.links;

        ledger.has.storage = !!room.storage;
        ledger.has.terminal = !!room.terminal;

        return ledger;
    }
};

module.exports = overseerResourceLedger;
