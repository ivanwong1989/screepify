/**
 * BoostGate (flag-driven, manual, deterministic, non-infinite)
 *
 * Flag convention:
 *   - For squadKey "W" => boost flag is "Wb"
 *   - If flag does not exist => skip boosting entirely (opt-in only)
 *
 * Memory:
 *   creep.memory.boostGateDoneFor = "W"
 *
 * Contract:
 *   runBoostGate(creep, squadKey) -> boolean
 *     true  => boost phase finished (caller may proceed to assembly/combat)
 *     false => still boosting (caller must skip mission logic this tick)
 */

function getBoostFlagName(squadKey) {
    return `${squadKey}b`;
}

function isLabEligible(lab) {
    if (!lab || lab.structureType !== STRUCTURE_LAB) return false;
    if (!lab.my) return false;
    if (!lab.mineralType) return false;
    if (lab.mineralAmount < 30) return false;
    if (lab.energy < 20) return false;
    if (lab.cooldown && lab.cooldown > 0) return false;
    return true;
}

function creepHasBoostablePartsForCompound(creep, compound) {
    // BOOSTS[partType][compound] exists if that compound boosts that body part
    // Only boost body parts that are not already boosted.
    for (const part of creep.body) {
        if (part.boost) continue;
        const partType = part.type;
        const boostsForPart = BOOSTS[partType];
        if (!boostsForPart) continue;
        if (boostsForPart[compound]) return true;
    }
    return false;
}

function markDone(creep, squadKey) {
    creep.memory.boostGateDoneFor = squadKey;
}

function alreadyDone(creep, squadKey) {
    return creep.memory.boostGateDoneFor === squadKey;
}

function runBoostGate(creep, squadKey) {
    if (!creep || !squadKey) return true;

    const boostFlagName = getBoostFlagName(squadKey);
    const boostFlag = Game.flags[boostFlagName];

    // Opt-in only. No flag => no boost phase.
    if (!boostFlag) return true;

    // Per-creep completion latch.
    if (alreadyDone(creep, squadKey)) return true;

    // Not in boost room yet => go there.
    if (creep.pos.roomName !== boostFlag.pos.roomName) {
        creep.moveTo(boostFlag.pos, { reusePath: 25 });
        return false;
    }

    // In boost room => find eligible labs.
    const labs = creep.room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_LAB
    });

    if (!labs || labs.length === 0) {
        markDone(creep, squadKey);
        return true;
    }

    // Only labs with resources and not on cooldown.
    let eligible = labs.filter(isLabEligible);

    if (eligible.length === 0) {
        markDone(creep, squadKey);
        return true;
    }

    // Only labs that can apply to *some* remaining unboosted body part.
    eligible = eligible.filter(lab => creepHasBoostablePartsForCompound(creep, lab.mineralType));

    if (eligible.length === 0) {
        // Either fully boosted (for available chems) or nothing applicable.
        markDone(creep, squadKey);
        return true;
    }

    // 1) Try to boost from any labs already in range (multi-chemical in one tick).
    // 2) If some eligible labs remain but none are in range => walk to the closest one.
    let didAnyBoost = false;
    let anyHardFail = false;

    // Boost from all labs in range 1 (attempt all eligible chems).
    for (const lab of eligible) {
        if (!creep.pos.inRangeTo(lab.pos, 1)) continue;

        const rc = lab.boostCreep(creep);

        if (rc === OK) {
            didAnyBoost = true;
            continue;
        }

        // Non-OK outcomes: per spec, treat "errors etc." as a clean termination trigger.
        // BUT we still allow other labs this tick; we just note that something failed.
        if (rc !== ERR_NOT_IN_RANGE) {
            anyHardFail = true;
        }
    }

    // After attempting in-range boosts, re-check if anything still applicable.
    // (cheap pass, avoids infinite loops)
    const remainingEligible = eligible.filter(lab => creepHasBoostablePartsForCompound(creep, lab.mineralType));

    if (remainingEligible.length === 0) {
        markDone(creep, squadKey);
        return true;
    }

    // If we boosted something this tick, we can keep boosting next tick.
    // But if we hit any "hard fail" (not enough resources, invalid, busy, etc.) => terminate cleanly.
    if (anyHardFail) {
        markDone(creep, squadKey);
        return true;
    }

    // If none were in range, move to the closest remaining eligible lab.
    // (No deadlock: each creep independently walks and boosts; no coordination needed.)
    let closest = null;
    let bestRange = Infinity;
    for (const lab of remainingEligible) {
        const r = creep.pos.getRangeTo(lab.pos);
        if (r < bestRange) {
            bestRange = r;
            closest = lab;
        }
    }

    if (!closest) {
        markDone(creep, squadKey);
        return true;
    }

    if (bestRange > 1) {
        creep.moveTo(closest.pos, { reusePath: 15 });
        return false;
    }

    // We are in range but didn't boost (likely due to an odd rc); terminate to avoid looping.
    if (!didAnyBoost) {
        markDone(creep, squadKey);
        return true;
    }

    return false;
}

module.exports = {
    runBoostGate
};