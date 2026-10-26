// @ts-check
'use strict';

const roomData = require('../../services/roomData');
const ledger = require('../../services/ledger');
const requests = require('../../services/requests');
const flipGuard = require('../../services/flipGuard');
const cache = require('../../services/cache');
const board = require('../../services/requestBoard');
const labs = require('../../services/labs');
const market = require('../../services/market');

/**
 * Publishes `rc.requests` (docs/v2/LOGISTICS.md): what each store asks for or
 * offers, per resource, after counting what haulers already carry or have
 * committed to (services/ledger). Stores the flip guard has blocked
 * (services/flipGuard) and the core lane's targets (rc.lanes.core, filled by
 * the lane hauler alone) are left out. Runs after census and sense.lanes.
 *
 * Built on demand: `rc.requests` is a getter that builds the list the first
 * time it is read in a tick and reuses it after that. On most ticks nobody
 * reads it, and nothing is built. Actions, which get no ctx, read it through
 * services/requestBoard.
 */

/** @param {import('../../contracts/ctx').TickContext} ctx @param {import('../../contracts/ctx').RoomCtx} rc */
function buildFor(ctx, rc) {
    const room = rc.room;
    const intel = /** @type {import('../sense/intel').RoomIntel} */ (rc.intel);
    const stores = roomData.structures(room).filter(s => requests.BANDED.has(s.structureType) &&
        (/** @type {any} */ (s).my || s.structureType === STRUCTURE_CONTAINER));
    /** @type {Set<string>} */
    const miningContainers = new Set();
    for (const src of intel.sources) if (src.containerId) miningContainers.add(src.containerId);
    const l = ledger.build(/** @type {any} */ (rc.census).active);
    const labPlan = labs.current(rc.name);
    const latches = cache.store('logistics.latch');
    const stats = cache.store('logistics.builds');
    stats[rc.name] = (stats[rc.name] || 0) + 1;
    // Goods the market sells from this room are stocked in its terminal.
    const sellStock = market.stockFor(room, ctx.config.market);
    const tcfg = ctx.config.terminal;
    const roomT = (tcfg.rooms && tcfg.rooms[rc.name]) || {};
    const terminal = Object.keys(sellStock).length === 0 ? tcfg : Object.assign({}, tcfg, {
        rooms: Object.assign({}, tcfg.rooms, { [rc.name]: Object.assign({}, roomT, { stock: Object.assign({}, sellStock, roomT.stock || {}) }) })
    });
    return requests.build(stores, l, {
        terminal, roomName: rc.name, miningContainers, blocked: flipGuard.blocked(rc.name),
        controllerContainer: intel.controllerContainerId || null, hasBuffer: !!(room.storage && room.storage.my),
        exclude: (rc.lanes && rc.lanes.core) || undefined,
        labs: labPlan ? labPlan.roles : undefined, labCfg: labs.configFor(ctx.config.labs, rc.name)
    }, latches[rc.name] || (latches[rc.name] = {}));
}

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'sense.logistics',
    phase: 'SENSE',
    scope: 'room',
    kinds: ['owned'],
    tier: 'critical',
    priority: 45,
    run(ctx, rc) {
        if (!rc.census || !rc.intel) return;
        const name = rc.name;
        board.publish(name, () => buildFor(ctx, rc));
        Object.defineProperty(rc, 'requests', { get: () => board.get(name), configurable: true, enumerable: true });
    }
};
