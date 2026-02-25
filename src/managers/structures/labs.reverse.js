// labs.reverse.js

function normalizeReverseSpec(cfg) {
    if (!cfg || !cfg.reverse) return null;
    const r = cfg.reverse;
    if (!r.product) return null;

    return {
        product: ('' + r.product).trim(),
        productTarget: Number(r.productTarget) || cfg.inputTarget || 2000,
        maxReactionsPerTick: Number(cfg.maxReactionsPerTick) || 3
    };
}

function chooseSource(room, resourceType) {
    if (room.storage && (room.storage.store[resourceType] || 0) > 0) {
        return room.storage;
    }
    if (room.terminal && (room.terminal.store[resourceType] || 0) > 0) {
        return room.terminal;
    }
    return null;
}

function chooseSink(room, resourceType) {
    if (room.storage && room.storage.store.getFreeCapacity(resourceType) > 0) {
        return room.storage;
    }
    if (room.terminal && room.terminal.store.getFreeCapacity(resourceType) > 0) {
        return room.terminal;
    }
    return null;
}

/**
 * Reverse logistics missions
 * - Fill compound lab
 * - Clear output labs if wrong mineral
 */
function getReverseLogisticsMissions(room, cfg, labs) {
    const missions = [];
    const spec = normalizeReverseSpec(cfg);
    if (!spec) return missions;

    const missionPrefix = `labhaul:${room.name}`;
    const seen = new Set();

    const enqueue = (sourceId, targetId, resourceType, label) => {
        if (!targetId || !resourceType || !label) return;
        if (seen.has(label)) return;
        seen.add(label);

        missions.push({
            name: label,
            type: 'transfer',
            archetype: 'hauler',
            targetId: targetId,
            data: {
                resourceType,
                sourceId: sourceId || null
            },
            requirements: {
                archetype: 'hauler',
                count: 1,
                spawn: false
            },
            priority: cfg.transferPriority
        });
    };

    // Find compound lab (first lab containing product)
    const compoundLab = labs.find(
        l => l.mineralType === spec.product
    );

    if (!compoundLab) return missions;

    // Ensure compound lab filled to target
    const current = compoundLab.store[spec.product] || 0;
    if (current < spec.productTarget) {
        const source = chooseSource(room, spec.product);
        if (source) {
            const label = `${missionPrefix}:reverse:fill:${compoundLab.id}:${spec.product}`;
            enqueue(source.id, compoundLab.id, spec.product, label);
        }
    }

    // Clear wrong minerals from other labs
    for (const lab of labs) {
        if (lab.id === compoundLab.id) continue;
        if (!lab.mineralType) continue;
        if (lab.mineralType === spec.product) continue;

        const sink = chooseSink(room, lab.mineralType);
        if (!sink) continue;

        const label = `${missionPrefix}:reverse:clear:${lab.id}:${lab.mineralType}`;
        enqueue(lab.id, sink.id, lab.mineralType, label);
    }

    return missions;
}

/**
 * Reverse runtime execution
 */
function runReverse(room, cfg, labs) {
    const spec = normalizeReverseSpec(cfg);
    if (!spec) return;

    const compoundLab = labs.find(
        l => l.mineralType === spec.product &&
             (l.store[spec.product] || 0) > 0
    );

    if (!compoundLab) return;

    // Output labs = labs not holding compound
    const outputLabs = labs.filter(
        l => l.id !== compoundLab.id
    );

    let fired = 0;

    for (const lab of outputLabs) {
        if (fired >= spec.maxReactionsPerTick) break;
        if (lab.cooldown > 0) continue;
        if (lab.store.getFreeCapacity() <= 0) continue;

        const result = lab.reverseReaction(compoundLab);
        if (result === OK) fired++;
    }
}

module.exports = {
    getReverseLogisticsMissions,
    runReverse
};