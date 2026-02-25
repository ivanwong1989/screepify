// labs.reverse.js
//
// Reverse lab support:
// - Pick/identify a "compound lab" to hold the product (auto-selected if not already present)
// - Haul product into compound lab up to productTarget
// - Clear wrong minerals from any labs (including compound lab if needed)
// - Call reverseReaction() on other labs using the compound lab as source

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

/**
 * Pick a compound lab deterministically.
 *
 * Priority:
 *  1) Any lab already holding the product (prefer the fullest)
 *  2) Any empty lab (prefer the emptiest store total)
 *  3) Otherwise, the lab with the smallest amount of mineral (least disruptive to clear)
 */
function chooseCompoundLab(labs, product) {
    if (!Array.isArray(labs) || labs.length === 0) return null;

    // 1) Already holding product
    let best = null;
    let bestAmt = -1;
    for (const lab of labs) {
        if (!lab || lab.structureType !== STRUCTURE_LAB) continue;
        if (lab.mineralType !== product) continue;
        const amt = lab.store[product] || 0;
        if (amt > bestAmt) {
            best = lab;
            bestAmt = amt;
        }
    }
    if (best) return best;

    // 2) Empty labs
    let emptyBest = null;
    let emptyScore = Infinity; // lower is better
    for (const lab of labs) {
        if (!lab || lab.structureType !== STRUCTURE_LAB) continue;
        if (lab.mineralType) continue;
        // prefer labs that are already empty in store too
        const used = lab.store.getUsedCapacity ? (lab.store.getUsedCapacity() || 0) : 0;
        if (used < emptyScore) {
            emptyScore = used;
            emptyBest = lab;
        }
    }
    if (emptyBest) return emptyBest;

    // 3) Least disruptive to clear
    let least = null;
    let leastAmt2 = Infinity;
    for (const lab of labs) {
        if (!lab || lab.structureType !== STRUCTURE_LAB) continue;
        const mt = lab.mineralType;
        if (!mt) {
            // should have been caught above, but just in case
            return lab;
        }
        const amt = lab.store[mt] || 0;
        if (amt < leastAmt2) {
            leastAmt2 = amt;
            least = lab;
        }
    }
    return least || labs[0] || null;
}

/**
 * Reverse logistics missions
 * - Ensure compound lab is (eventually) holding the product up to productTarget
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
                count: 1,
                spawn: false
            },
            priority: cfg.transferPriority
        });
    };

    const compoundLab = chooseCompoundLab(labs, spec.product);
    if (!compoundLab) return missions;

    const reagents = getReagentsForProduct(spec.product);
    if (!reagents) {
        dbg(cfg, `room=${room.name} reverse product=${spec.product} has no known reagent pair (REACTIONS lookup failed)`);
        return missions;
    }

    dbg(cfg, `room=${room.name} reverse product=${spec.product} target=${spec.productTarget} compoundLab=${compoundLab.id} mt=${compoundLab.mineralType || 'none'} amt=${compoundLab.mineralType ? (compoundLab.store[compoundLab.mineralType] || 0) : 0} reagents=${reagents.a}+${reagents.b}`);

    // If compound lab currently holds a different mineral, clear it first
    if (compoundLab.mineralType && compoundLab.mineralType !== spec.product) {
        const sink = chooseSink(room, compoundLab.mineralType);
        if (sink) {
            const label = `${missionPrefix}:reverse:clearCompound:${compoundLab.id}:${compoundLab.mineralType}`;
            enqueue(compoundLab.id, sink.id, compoundLab.mineralType, label);
            dbg(cfg, `room=${room.name} enqueue clearCompound lab=${compoundLab.id} mineral=${compoundLab.mineralType} -> ${sink.structureType}:${sink.id}`);
        }
        // Don't schedule fill until it's cleared.
        return missions;
    }

    // Ensure compound lab filled to target
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

    // Clear wrong minerals from other labs (anything not reagent A/B)
    for (const lab of labs) {
        if (!lab) continue;
        if (lab.id === compoundLab.id) continue;
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

    const compoundLab = chooseCompoundLab(labs, spec.product);
    if (!compoundLab) return;

    const reagents = getReagentsForProduct(spec.product);
    if (!reagents) {
        dbg(cfg, `room=${room.name} runReverse product=${spec.product} no reagent pair; abort`);
        return;
    }

    // Only run reverse once the compound lab actually has product in it
    if (compoundLab.mineralType !== spec.product) {
        dbg(cfg, `room=${room.name} runReverse waiting: compoundLab mt=${compoundLab.mineralType || 'none'} (need ${spec.product})`);
        return;
    }
    if ((compoundLab.store[spec.product] || 0) <= 0) {
        dbg(cfg, `room=${room.name} runReverse waiting: compoundLab has 0 ${spec.product}`);
        return;
    }

    dbg(cfg, `room=${room.name} runReverse compoundLab=${compoundLab.id} amt=${compoundLab.store[spec.product] || 0} maxPerTick=${spec.maxReactionsPerTick} reagents=${reagents.a}+${reagents.b}`);

    // reverseReaction is executed by the *source* lab (compoundLab) and requires
    // TWO target labs (lab1, lab2) to receive the reagents.
    // If the source lab is on cooldown, nothing can happen this tick.
    if (compoundLab.cooldown && compoundLab.cooldown > 0) {
        dbg(cfg, `room=${room.name} skip: compoundLab cooldown=${compoundLab.cooldown}`);
        return;
    }

    // Output labs = labs not holding compound
    const outputLabs = labs.filter(l => l && l.id !== compoundLab.id);

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

    let fired = 0;

    // reverseReaction consumes 1 action of the source lab per tick.
    // We still keep maxReactionsPerTick for future extension (multiple compound labs),
    // but for a single compoundLab, we will stop once it becomes tired.
    while (fired < spec.maxReactionsPerTick) {
        const labA = pickBest(outputLabs, reagents.a, null);
        const labB = pickBest(outputLabs, reagents.b, labA ? labA.id : null);

        if (!labA || !labB) {
            dbg(cfg, `room=${room.name} runReverse no valid pair: need ${reagents.a}+${reagents.b} (check output labs minerals/cooldowns/capacity)`);
            break;
        }

        const res = compoundLab.reverseReaction(labA, labB);
        if (res === OK) {
            fired += 1;
            dbg(cfg, `OK reverseReaction source=${compoundLab.id} -> lab1=${labA.id}(${reagents.a}) lab2=${labB.id}(${reagents.b})`);
        } else {
            dbg(cfg, `ERR reverseReaction source=${compoundLab.id} -> lab1=${labA.id} lab2=${labB.id} code=${res}`);
            // Most errors won't resolve by retrying in the same tick.
            break;
        }

        if (compoundLab.cooldown && compoundLab.cooldown > 0) break;
    }

    if (fired === 0) {
        dbg(cfg, `room=${room.name} runReverse fired=0 (most likely: no valid output pair, labs not in range, or reverseReaction returned ERR_*)`);
    }
}

module.exports = {
    getReverseLogisticsMissions,
    runReverse
};
