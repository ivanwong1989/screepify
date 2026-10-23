// @ts-check
'use strict';

const labs = require('../../services/labs');

/**
 * Runs the planned reaction (P12): each output lab off cooldown reacts from
 * the two input labs when they hold the planned reagents. Filling and
 * emptying labs is the lab hauler's job (missions/labHaul, logistics bands).
 */

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'act.labs',
    phase: 'ACT',
    scope: 'room',
    kinds: ['owned'],
    tier: 'low',
    priority: 70,
    run(ctx, rc) {
        const p = labs.current(rc.name);
        if (!p || !p.reagents || p.inputs.length < 2) return;
        const a = /** @type {StructureLab|null} */ (Game.getObjectById(/** @type {any} */ (p.inputs[0])));
        const b = /** @type {StructureLab|null} */ (Game.getObjectById(/** @type {any} */ (p.inputs[1])));
        if (!a || !b) return;
        const ra = /** @type {ResourceConstant} */ (p.reagents[0]);
        const rb = /** @type {ResourceConstant} */ (p.reagents[1]);
        if ((a.store[ra] || 0) < LAB_REACTION_AMOUNT || (b.store[rb] || 0) < LAB_REACTION_AMOUNT) return;
        for (const id of p.outputs) {
            const out = /** @type {StructureLab|null} */ (Game.getObjectById(/** @type {any} */ (id)));
            if (!out || out.cooldown > 0) continue;
            out.runReaction(a, b);
        }
    }
};
