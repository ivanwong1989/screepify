// @ts-check
'use strict';

const log = require('../../services/log');
const terminalRules = require('../../services/terminal');

/**
 * Energy balancing between owned rooms through their terminals (P11; v1 did
 * this in zeadmin's energy balancer). Rules: services/terminal.balance.
 *
 * One send per run: from the room with the most energy above its policy
 * stockpile target to the room furthest below its own. A receiving terminal
 * that ends up above its energy target is emptied into storage by the lane
 * hauler (missions/shared/laneStock).
 */

/** @param {number} amount @param {string} from @param {string} to */
function cost(amount, from, to) {
    return Game.market.calcTransactionCost(amount, from, to);
}

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'act.terminal',
    phase: 'ACT',
    scope: 'shard',
    tier: 'low',
    priority: 80,
    every: 50,
    run(ctx) {
        const cfg = ctx.config.terminal;
        if (!cfg.balance.enabled) return;
        const targets = ctx.config.policy.stockpileTargets;
        /** @type {import('../../services/terminal').BalanceRoom[]} */
        const rooms = [];
        for (const rc of ctx.roomList) {
            const room = rc.room;
            if (rc.kind !== 'owned' || !room || !room.storage || !room.terminal || !room.terminal.my) continue;
            if (room.terminal.cooldown > 0) continue;
            const t = targets[String(room.controller ? room.controller.level : 0)] || 0;
            if (t <= 0) continue;
            const terminalEnergy = room.terminal.store[RESOURCE_ENERGY] || 0;
            rooms.push({ name: rc.name, energy: (room.storage.store[RESOURCE_ENERGY] || 0) + terminalEnergy, target: t, terminalEnergy });
        }
        if (rooms.length < 2) return;
        const send = terminalRules.balance(rooms, ctx.config.policy.stockpileHysteresis, cfg.balance.batch, cost);
        if (!send) return;
        const r = Game.rooms[send.from].terminal.send(RESOURCE_ENERGY, send.amount, send.to, 'balance');
        log.info(`[terminal] balance ${send.from} → ${send.to}: ${send.amount} energy (${r})`);
    }
};
