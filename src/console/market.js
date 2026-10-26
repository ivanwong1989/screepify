// @ts-check
'use strict';

const config = require('../config');
const market = require('../services/market');

/**
 * Market console commands (docs/v2/MARKET.md).
 *
 *   market.show()                              orders, surplus per room, floors
 *   market.sell(res, keep, mode?, minPrice?)   sell `res` above `keep` ('order' default, or 'deal')
 *   market.stop(res)                           stop selling `res` (an open order stays; cancel it in game)
 *   market.on() / market.off()
 */

function register() {
    const g = /** @type {any} */ (global);
    g.market = {
        show() {
            const cfg = config.get().market;
            const lines = [`market ${cfg.enabled ? 'ON' : 'OFF'}  floor ${cfg.floorFactor} × recent avg (${cfg.historyDays} days)`];
            const rooms = Object.values(Game.rooms).filter(r => r.controller && r.controller.my && r.terminal);
            for (const res of Object.keys(cfg.sell || {})) {
                const spec = cfg.sell[res];
                if (!spec) continue;
                const avg = market.avgPrice(Game.market.getHistory(/** @type {any} */ (res)) || [], cfg.historyDays);
                const fl = market.floor(spec, avg, cfg.floorFactor);
                const surplus = rooms.map(r => `${r.name} ${Math.max(0, market.roomStock(r, res) - spec.keep)}`).join(', ');
                lines.push(`${res}  ${spec.mode} keep ${spec.keep}  avg ${avg === null ? '-' : avg.toFixed(3)}  floor ${fl === null ? 'none (not selling)' : fl.toFixed(3)}  surplus: ${surplus}`);
            }
            for (const o of Object.values(Game.market.orders || {})) {
                lines.push(`  order ${o.type} ${o.resourceType} @ ${o.price}  left ${o.remainingAmount}/${o.totalAmount}  ${o.roomName}  ${o.active ? 'active' : 'inactive'}`);
            }
            return lines.join('\n');
        },
        /** @param {string} res @param {number} keep @param {'order'|'deal'} [mode] @param {number} [minPrice] */
        sell(res, keep, mode, minPrice) {
            const spec = { mode: mode || 'order', keep };
            if (Number.isFinite(minPrice)) Object.assign(spec, { minPrice });
            config.set(`market.sell.${res}`, spec);
            return `selling ${res} above ${keep} (${spec.mode})`;
        },
        /** @param {string} res */
        stop(res) {
            // null, not delete: Memory.config is merged over the defaults, so a
            // deleted default (KO, O, K) would come back.
            config.set(`market.sell.${res}`, null);
            return `stopped selling ${res}; cancel any open order in game if you want it gone`;
        },
        on() {
            config.set('market.enabled', true);
            return 'market on';
        },
        off() {
            config.set('market.enabled', false);
            return 'market off';
        }
    };
}

module.exports = { register };
