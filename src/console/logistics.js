// @ts-check
'use strict';

const cache = require('../services/cache');
const board = require('../services/requestBoard');
const flipGuard = require('../services/flipGuard');

/**
 * Logistics console commands (docs/v2/LOGISTICS.md).
 *
 *   logistics.show(room)   this tick's requests and offers per resource, and
 *                          stores the flip guard has blocked
 */

/** @param {string} id */
function label(id) {
    const o = /** @type {any} */ (Game.getObjectById(/** @type {any} */ (id)));
    return o ? `${o.structureType}@${o.pos.x},${o.pos.y}` : id;
}

function register() {
    const g = /** @type {any} */ (global);
    g.logistics = {
        /** @param {string} room */
        show(room) {
            const reqs = board.get(room);
            if (!reqs) return `no request list for ${room} this tick`;
            const builds = cache.store('logistics.builds')[room] || 0;
            const lines = [`${room} @ ${Game.time}${reqs.buffer ? `  buffer free ${reqs.buffer.free}` : '  no buffer'}  (built ${builds}× since reset)`];
            for (const res of Object.keys(reqs.byRes).sort()) {
                const { req, off } = reqs.byRes[res];
                for (const r of req) lines.push(`  ${res}  wants ${r.amount}  ${label(r.id)}  (prio ${r.prio})`);
                for (const o of off) lines.push(`  ${res}  gives ${o.amount}  ${label(o.id)}  (prio ${o.prio})`);
            }
            const blocked = Array.from(flipGuard.blocked(room));
            if (blocked.length) lines.push(`  blocked (flipping): ${blocked.map(k => { const [id, r] = k.split(':'); return `${r} ${label(id)}`; }).join(', ')}`);
            return lines.join('\n');
        }
    };
}

module.exports = { register };
