// @ts-check
'use strict';

const roomData = require('../services/roomData');
const scanner = require('../services/repairScan');

/**
 * Tower missions (port of v1 mission.tower, without the defender-assist
 * evaluation, which only fed the shelved military code).
 *
 * tower:defense  focus the hostile with the best (net damage × 2 − hits + healer bias),
 *                only if towers out-damage its healing
 * tower:heal     my damaged creeps
 * tower:repair   only critical (≤ 5%) non-wall structures; walls/fortify during defense;
 *                gated on energy (storage ≥ 10k while UPGRADING, or extensions ≥ 80% full)
 */

/** @param {number} range */
function towerDamage(range) {
    if (range <= 5) return 600;
    if (range >= 20) return 150;
    return 600 - (range - 5) * 30;
}

/**
 * @param {string|undefined} boost
 * @param {boolean} ranged
 */
function healPerPart(boost, ranged) {
    const base = ranged ? 4 : 12;
    if (boost && BOOSTS[HEAL] && BOOSTS[HEAL][boost]) {
        const b = /** @type {any} */ (BOOSTS[HEAL][boost]);
        return base * ((ranged ? b.rangedHeal : b.heal) || 1);
    }
    return base;
}

/**
 * Healing a hostile would receive at its position from nearby hostiles.
 * @param {Creep} target
 * @param {Creep[]} hostiles
 */
function incomingHeal(target, hostiles) {
    let total = 0;
    for (const h of hostiles) {
        const r = h.id === target.id ? 0 : Math.max(Math.abs(h.pos.x - target.pos.x), Math.abs(h.pos.y - target.pos.y));
        if (r > 3) continue;
        for (const part of h.body) {
            if (part.type !== HEAL || part.hits <= 0) continue;
            total += healPerPart(part.boost, r > 1);
        }
    }
    return total;
}

/**
 * Raw damage scaled by the average TOUGH boost multiplier across live parts.
 * @param {number} raw
 * @param {Creep} hostile
 */
function vsTough(raw, hostile) {
    let sum = 0;
    let n = 0;
    for (const part of hostile.body) {
        if (part.hits <= 0) continue;
        n++;
        if (part.type === TOUGH && part.boost && BOOSTS[TOUGH] && BOOSTS[TOUGH][part.boost]) {
            sum += /** @type {any} */ (BOOSTS[TOUGH][part.boost]).damage || 1;
        } else {
            sum += 1;
        }
    }
    return n > 0 ? raw * (sum / n) : raw;
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, intel, state: rs } = plan;
    const room = rc.room;
    const towers = roomData.myByType(room, STRUCTURE_TOWER).filter(t => t.store[RESOURCE_ENERGY] >= 10);
    const base = { home: rc.name, room: rc.name, demand: { minCreeps: 0 }, spawn: /** @type {false} */ (false) };

    if (intel.hostiles.length > 0 && towers.length > 0) {
        let best = null;
        let bestScore = -Infinity;
        let bestEff = 0;
        for (const h of intel.hostiles) {
            let raw = 0;
            for (const t of towers) raw += towerDamage(t.pos.getRangeTo(h));
            const eff = vsTough(raw, h) - incomingHeal(h, intel.hostiles);
            let healAt1 = 0;
            for (const part of h.body) if (part.type === HEAL && part.hits > 0) healAt1 += healPerPart(part.boost, false);
            const score = eff * 2 - h.hits + healAt1 * 5;
            if (score > bestScore) {
                bestScore = score;
                best = h;
                bestEff = eff;
            }
        }
        if (best && bestEff > 0) {
            out.push(Object.assign({ id: 'tower:defense', type: 'tower_attack', targetIds: [best.id], priority: 1000 }, base));
        }
    }

    const damaged = intel.myCreeps.filter(c => c.hits < c.hitsMax).map(c => c.id);
    if (damaged.length > 0) {
        out.push(Object.assign({ id: 'tower:heal', type: 'tower_heal', targetIds: damaged, priority: 950 }, base));
    }

    const inDefense = intel.hostiles.length > 0;
    const allowRepair = inDefense || (room.storage
        ? (rs.economy === 'UPGRADING' && intel.storageEnergy >= 10000)
        : intel.energyAvailable > intel.energyCapacityAvailable * 0.8);
    if (!allowRepair) return;

    const scan = scanner.get(room.name);
    const ids = new Set();
    for (const id of scan.repairIds) {
        const st = /** @type {any} */ (Game.getObjectById(/** @type {any} */ (id)));
        if (!st || !st.hitsMax) continue;
        if (scanner.isFort(st)) {
            if (inDefense) ids.add(id);
        } else if (st.hits <= st.hitsMax * 0.05) {
            ids.add(id);
        }
    }
    if (inDefense) for (const id of scan.fortifyIds) if (Game.getObjectById(/** @type {any} */ (id))) ids.add(id);
    if (ids.size > 0) {
        out.push(Object.assign({ id: 'tower:repair', type: 'tower_repair', targetIds: Array.from(ids), priority: 40 }, base));
    }
}

module.exports = { type: 'tower', generate, towerDamage };
