// @ts-check
'use strict';

const cache = require('../services/cache');
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
            const e = cache.store('logistics.requests')[room];
            if (!e) return `no request list for ${room}`;
            const lines = [`${room} @ ${e.t}${e.reqs.buffer ? `  buffer free ${e.reqs.buffer.free}` : '  no buffer'}`];
            for (const res of Object.keys(e.reqs.byRes).sort()) {
                const { req, off } = e.reqs.byRes[res];
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
