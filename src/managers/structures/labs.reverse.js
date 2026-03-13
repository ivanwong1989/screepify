// labs.reverse.js
//
// Reverse lab support:
// - Pick/identify one or more "compound labs" to hold the product (auto-selected)
// - Haul product into each compound lab up to productTarget
// - Clear wrong minerals from any labs (including compound lab if needed)
// - Call reverseReaction() on other labs using compound labs as sources

function normalizeReverseSpec(cfg) {
    if (!cfg || !cfg.reverse) return null;
    const r = cfg.reverse;
    if (!r.product) return null;

    return {
        product: ('' + r.product).trim(),
        productTarget: Number(r.productTarget) || cfg.inputTarget || 2000,
        maxReactionsPerTick: Number(cfg.maxReactionsPerTick) || 3,
        maxSourceLabs: Number(r.maxSourceLabs) || 0
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

function dbg(cfg, msg) {
    if (!cfg || cfg.debug !== true) return;
    console.log(`[labs.reverse] ${msg}`);
}

// Find reagent pair (A,B) that produces the given product.
// Returns {a,b} or null if unknown.
function getReagentsForProduct(product) {
    if (!product || typeof REACTIONS !== 'object') return null;
    for (const a of Object.keys(REACTIONS)) {
        const row = REACTIONS[a];
        if (!row || typeof row !== 'object') continue;
        for (const b of Object.keys(row)) {
            if (row[b] === product) return { a, b };
        }
    }
    return null;
}

// Rank labs as reverse sources:
// 1) labs already holding product (more amount first)
// 2) empty labs (lower used store first)
// 3) other labs (lower mineral amount first)
function rankCompoundLabs(labs, product) {
    if (!Array.isArray(labs) || labs.length === 0) return null;

    const withProduct = [];
    const empty = [];
    const others = [];

    for (const lab of labs) {
        if (!lab || lab.structureType !== STRUCTURE_LAB) continue;
        if (lab.mineralType === product) withProduct.push(lab);
        else if (!lab.mineralType) empty.push(lab);
        else others.push(lab);
    }

    withProduct.sort((a, b) => (b.store[product] || 0) - (a.store[product] || 0));
    empty.sort((a, b) => {
        const ua = a.store.getUsedCapacity ? (a.store.getUsedCapacity() || 0) : 0;
        const ub = b.store.getUsedCapacity ? (b.store.getUsedCapacity() || 0) : 0;
        return ua - ub;
    });
    others.sort((a, b) => (a.store[a.mineralType] || 0) - (b.store[b.mineralType] || 0));

    return withProduct.concat(empty, others);
}

function chooseCompoundLabs(labs, product, maxSourcesHint) {
    if (!Array.isArray(labs) || labs.length < 3) return [];

    const ranked = rankCompoundLabs(labs, product);
    if (!ranked || ranked.length === 0) return [];

    const maxByLayout = Math.max(1, labs.length - 2); // always reserve 2 output labs
    const maxByHint = (Number(maxSourcesHint) > 0) ? Number(maxSourcesHint) : maxByLayout;
    const maxSources = Math.max(1, Math.min(maxByLayout, maxByHint));

    return ranked.slice(0, maxSources);
}

/**
 * Reverse logistics missions
 * - Ensure selected compound labs are (eventually) holding the product up to productTarget
 * - Clear wrong minerals from other labs (and from compound lab if it has the wrong mineral)
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
                minCount: 1,
                maxCount: 1,
                spawn: false
            },
            priority: cfg.transferPriority
        });
    };

    const sourcesHint = (spec.maxSourceLabs > 0)
        ? Math.min(spec.maxSourceLabs, spec.maxReactionsPerTick)
        : spec.maxReactionsPerTick;
    const compoundLabs = chooseCompoundLabs(labs, spec.product, sourcesHint);
    if (!compoundLabs || compoundLabs.length === 0) return missions;
    const compoundLabIds = new Set(compoundLabs.map(l => l.id));

    const reagents = getReagentsForProduct(spec.product);
    if (!reagents) {
        dbg(cfg, `room=${room.name} reverse product=${spec.product} has no known reagent pair (REACTIONS lookup failed)`);
        return missions;
    }

    dbg(cfg, `room=${room.name} reverse product=${spec.product} target=${spec.productTarget} sources=${compoundLabs.length} reagents=${reagents.a}+${reagents.b}`);

    // Ensure each compound/source lab is either cleared (if wrong mineral) or filled with product.
    for (const compoundLab of compoundLabs) {
        if (!compoundLab) continue;

        if (compoundLab.mineralType && compoundLab.mineralType !== spec.product) {
            const sink = chooseSink(room, compoundLab.mineralType);
            if (sink) {
                const label = `${missionPrefix}:reverse:clearCompound:${compoundLab.id}:${compoundLab.mineralType}`;
                enqueue(compoundLab.id, sink.id, compoundLab.mineralType, label);
                dbg(cfg, `room=${room.name} enqueue clearCompound lab=${compoundLab.id} mineral=${compoundLab.mineralType} -> ${sink.structureType}:${sink.id}`);
            }
            continue;
        }

        const current = compoundLab.store[spec.product] || 0;
        if (current < spec.productTarget) {
            const source = chooseSource(room, spec.product);
            if (source) {
                const label = `${missionPrefix}:reverse:fill:${compoundLab.id}:${spec.product}`;
                enqueue(source.id, compoundLab.id, spec.product, label);
                dbg(cfg, `room=${room.name} enqueue fill product=${spec.product} from=${source.structureType}:${source.id} -> lab=${compoundLab.id} cur=${current}/${spec.productTarget}`);
            } else {
                dbg(cfg, `room=${room.name} cannot fill product=${spec.product} (no source in storage/terminal)`);
            }
        }
    }

    // Clear wrong minerals from non-source labs (anything not reagent A/B).
    for (const lab of labs) {
        if (!lab) continue;
        if (compoundLabIds.has(lab.id)) continue;
        if (!lab.mineralType) continue;

        if (lab.mineralType === reagents.a) continue;
        if (lab.mineralType === reagents.b) continue;

        const sink = chooseSink(room, lab.mineralType);
        if (!sink) continue;

        const label = `${missionPrefix}:reverse:clear:${lab.id}:${lab.mineralType}`;
        enqueue(lab.id, sink.id, lab.mineralType, label);
        dbg(cfg, `room=${room.name} enqueue clear lab=${lab.id} mineral=${lab.mineralType} -> ${sink.structureType}:${sink.id}`);
    }

    return missions;
}

/**
 * Reverse runtime execution
 */
function runReverse(room, cfg, labs) {
    const spec = normalizeReverseSpec(cfg);
    if (!spec) return;
    if (spec.maxReactionsPerTick <= 0) return;

    const reagents = getReagentsForProduct(spec.product);
    if (!reagents) {
        dbg(cfg, `room=${room.name} runReverse product=${spec.product} no reagent pair; abort`);
        return;
    }

    const sourcesHint = (spec.maxSourceLabs > 0)
        ? Math.min(spec.maxSourceLabs, spec.maxReactionsPerTick)
        : spec.maxReactionsPerTick;
    const compoundLabs = chooseCompoundLabs(labs, spec.product, sourcesHint);
    if (!compoundLabs || compoundLabs.length === 0) return;
    const sourceIds = new Set(compoundLabs.map(l => l.id));

    // Output labs = labs not selected as sources.
    const outputLabs = labs.filter(l => l && !sourceIds.has(l.id));
    if (outputLabs.length < 2) {
        dbg(cfg, `room=${room.name} runReverse waiting: need at least 2 output labs (have ${outputLabs.length})`);
        return;
    }

    // Helper: whether a lab can accept a given reagent
    const canAccept = (lab, reagent) => {
        if (!lab) return false;
        if (lab.cooldown && lab.cooldown > 0) return false;
        if (lab.mineralType && lab.mineralType !== reagent) return false;
        const free = lab.store.getFreeCapacity(reagent);
        return !!free && free > 0;
    };

    // Prefer labs already dedicated to a reagent, then empty labs.
    const pickBest = (labsList, reagent, excludeId) => {
        let best = null;
        let bestScore = -1;
        for (const lab of labsList) {
            if (!lab) continue;
            if (excludeId && lab.id === excludeId) continue;
            if (!canAccept(lab, reagent)) continue;
            // score: dedicated reagent lab > empty lab, then more free space
            const dedicated = (lab.mineralType === reagent) ? 1 : 0;
            const free = lab.store.getFreeCapacity(reagent) || 0;
            const score = dedicated * 1e9 + free;
            if (score > bestScore) {
                bestScore = score;
                best = lab;
            }
        }
        return best;
    };

    // Prioritize source labs that are already loaded with product.
    const sources = compoundLabs
        .filter(l => l && l.mineralType === spec.product && (l.store[spec.product] || 0) > 0)
        .sort((a, b) => (b.store[spec.product] || 0) - (a.store[spec.product] || 0));

    dbg(cfg, `room=${room.name} runReverse sources=${sources.length}/${compoundLabs.length} outputs=${outputLabs.length} maxPerTick=${spec.maxReactionsPerTick} reagents=${reagents.a}+${reagents.b}`);

    let fired = 0;
    for (const sourceLab of sources) {
        if (fired >= spec.maxReactionsPerTick) break;
        if (sourceLab.cooldown && sourceLab.cooldown > 0) continue;

        const labA = pickBest(outputLabs, reagents.a, null);
        const labB = pickBest(outputLabs, reagents.b, labA ? labA.id : null);
        if (!labA || !labB) break;

        const res = sourceLab.reverseReaction(labA, labB);
        if (res === OK) {
            fired += 1;
            dbg(cfg, `OK reverseReaction source=${sourceLab.id} -> lab1=${labA.id}(${reagents.a}) lab2=${labB.id}(${reagents.b})`);
        } else {
            dbg(cfg, `ERR reverseReaction source=${sourceLab.id} -> lab1=${labA.id} lab2=${labB.id} code=${res}`);
        }
    }

    if (fired === 0) {
        dbg(cfg, `room=${room.name} runReverse fired=0 (most likely: source labs not ready/cooldown, no valid output pair, labs not in range, or reverseReaction returned ERR_*)`);
    }
}

module.exports = {
    getReverseLogisticsMissions,
    runReverse
};
