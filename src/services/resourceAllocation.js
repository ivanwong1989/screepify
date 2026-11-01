// @ts-check
'use strict';

/** Resource commitments shared by hauling, production and export. */

/** @param {string} room @param {string} res */
function sellCommitment(room, res) {
    if (!Game.market) return 0;
    return Object.values(Game.market.orders || {}).filter(o => o.type === ORDER_SELL && o.roomName === room && o.resourceType === res)
        .reduce((n, o) => n + Math.max(0, o.remainingAmount || 0), 0);
}

/**
 * Unmanaged terminal goods may supply a real lab request, but not consume an
 * outstanding sale. Explicit terminal targets are handled by their own bands.
 * @param {any} terminal @param {string} res @param {number} available @param {number} need @param {string} roomName
 */
function labSupply(terminal, res, available, need, roomName) {
    return Math.max(0, Math.min(need, available - sellCommitment(roomName, res), terminal.store[res] || 0));
}

module.exports = { sellCommitment, labSupply };
