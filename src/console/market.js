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
            const value = market.valuer(cfg);
            const lines = [`market ${cfg.enabled ? 'ON' : 'OFF'}  floor = max(minPrice, ${cfg.floorFactor} × reference, reagents), ` +
                `falls ≤ ${cfg.maxDropPerDay * 100}%/day`];
            const rooms = Object.values(Game.rooms).filter(r => r.controller && r.controller.my && r.terminal);
            for (const res of Object.keys(cfg.sell || {})) {
                const spec = cfg.sell[res];
                if (!spec) continue;
                const ref = market.reference(market.historyOf(res), cfg);
                const intr = market.intrinsic(res, value);
                const raw = market.rawFloor(spec, ref.ref, intr, cfg.floorFactor);
                const f = (/** @type {number|null} */ n) => (n === null ? '-' : n.toFixed(3));
                lines.push(`${res}  ${spec.mode}, keep ${spec.keep}`);
                lines.push(`   trades ${ref.trades} in ${cfg.longDays}d (${ref.liquid ? 'liquid' : 'THIN: no market price'}), ` +
                    `recent ${f(ref.recent)}, median ${f(ref.median)} → reference ${f(ref.ref)}; reagents ${f(intr)}; floor ${raw === null ? 'none (not selling)' : f(raw)}`);
                for (const r of rooms) {
                    const mk = (Memory.rooms[r.name] && /** @type {any} */ (Memory.rooms[r.name]).mk) || {};
                    const surplus = Math.max(0, market.roomStock(r, res) - spec.keep);
                    if (surplus > 0 || mk[res]) lines.push(`   ${r.name}: surplus ${surplus}${mk[res] ? `, floor anchor ${mk[res].p.toFixed(3)} @ ${mk[res].t}` : ''}`);
                }
                const all = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: /** @type {any} */ (res) });
                const clean = market.cleanBook(all, ref.ref, {
                    bandLow: cfg.bandLow, bandHigh: cfg.bandHigh, minAmount: Math.max(cfg.minListing, Math.floor(cfg.orderSize * 0.1)),
                    mine: new Set(Object.keys(Game.market.orders || {}))
                });
                lines.push(`   sell listings ${all.length}, ${all.length - clean.length} ignored (spam/bait/duplicate), ` +
                    `depth price for ${cfg.orderSize}: ${f(market.depthPrice(clean, cfg.orderSize))}`);
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
