// @ts-check
'use strict';

const config = require('../config');
const terminalRules = require('../services/terminal');

/**
 * Terminal console commands (P11).
 *
 *   terminal.show()                          per room: terminal energy vs target, next stock move
 *   terminal.send(from, to, res, amount)     one manual send
 *
 * Targets are config: config.set('terminal.energy', 30000),
 * config.set('terminal.rooms.W1N1.stock.XGHO2', 3000), config.set('terminal.balance.enabled', false).
 */

function register() {
    const g = /** @type {any} */ (global);
    g.terminal = {
        show() {
            const cfg = config.get().terminal;
            const lines = [];
            for (const name of Object.keys(Game.rooms).sort()) {
                const room = Game.rooms[name];
                if (!room.terminal || !room.terminal.my) continue;
                const t = terminalRules.targets(cfg, name);
                const move = room.storage ? terminalRules.nextMove(room.storage, room.terminal, cfg, name) : null;
                lines.push(`${name}  energy ${room.terminal.store[RESOURCE_ENERGY] || 0}/${t.energy}  storage ${room.storage ? room.storage.store[RESOURCE_ENERGY] : 0}` +
                    `  cooldown ${room.terminal.cooldown}  next: ${move ? `${move.amount} ${move.res} from ${move.from}` : 'none'}`);
            }
            lines.push(`balance ${cfg.balance.enabled ? 'on' : 'off'}, batch ${cfg.balance.batch}`);
            return lines.join('\n');
        },
        /** @param {string} from @param {string} to @param {ResourceConstant} res @param {number} amount */
        send(from, to, res, amount) {
            const room = Game.rooms[from];
            if (!room || !room.terminal || !room.terminal.my) return `no terminal of mine in ${from}`;
            const fee = Game.market.calcTransactionCost(amount, from, to);
            const r = room.terminal.send(res, amount, to, 'console');
            return `send ${amount} ${res} ${from} → ${to}: ${r} (fee ${fee} energy)`;
        }
    };
}

module.exports = { register };
