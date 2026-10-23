// @ts-check
'use strict';

const laneClaims = require('../../services/laneClaims');

/**
 * Publishes which targets the lane haulers own this tick (`rc.lanes`, see
 * services/laneClaims). Runs after census and policy, which it depends on.
 */

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'sense.lanes',
    phase: 'SENSE',
    scope: 'room',
    kinds: ['owned', 'bootstrap'],
    tier: 'critical',
    priority: 40,
    run(ctx, rc) {
        rc.lanes = { core: laneClaims.core(rc), mining: laneClaims.mining(rc) };
    }
};
