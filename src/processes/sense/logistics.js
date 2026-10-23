// @ts-check
'use strict';

const roomData = require('../../services/roomData');
const ledger = require('../../services/ledger');
const requests = require('../../services/requests');

/**
 * Publishes `rc.requests` (docs/v2/LOGISTICS.md): what each store asks for or
 * offers, per resource, after counting what haulers already carry or have
 * committed to (services/ledger). Runs after census, every tick: the list is
 * only valid for the tick it was built in.
 */

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'sense.logistics',
    phase: 'SENSE',
    scope: 'room',
    kinds: ['owned'],
    tier: 'critical',
    priority: 40,
    run(ctx, rc) {
        if (!rc.census || !rc.intel) return;
        const room = rc.room;
        const stores = roomData.structures(room).filter(s => /** @type {any} */ (s).store &&
            (/** @type {any} */ (s).my || s.structureType === STRUCTURE_CONTAINER));
        /** @type {Set<string>} */
        const miningContainers = new Set();
        for (const src of rc.intel.sources) if (src.containerId) miningContainers.add(src.containerId);
        const l = ledger.build(rc.census.active);
        rc.requests = requests.build(stores, l, { terminal: ctx.config.terminal, roomName: rc.name, miningContainers });
    }
};
