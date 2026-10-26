// @ts-check
'use strict';

const log = require('../services/log');

/**
 * Memory schema and migrations (DESIGN §7).
 *
 * `Memory.v` holds the schema version. Migrations run in order, each bringing
 * Memory from `to - 1` to `to`. Checking the version is one property read, so
 * the kernel does it every tick (it also catches a manual Memory wipe).
 */

const SCHEMA_VERSION = 3;

/**
 * @typedef {Object} Migration
 * @property {number} to
 * @property {string} name
 * @property {(mem: any) => void} run
 */

/** @type {Migration[]} */
const MIGRATIONS = [
    {
        to: 2,
        name: 'v1 → v2: fresh start (colony restart accepted, DESIGN D4)',
        run(mem) {
            for (const key of Object.keys(mem)) {
                if (key !== 'config') delete mem[key];
            }
            mem.creeps = {};
            mem.rooms = {};
            mem.flags = {};
            mem.spawns = {};
        }
    },
    {
        to: 3,
        name: 'shard-level state: Memory.e (market spending ledger, price anchors)',
        run(mem) {
            if (!mem.e || typeof mem.e !== 'object') mem.e = {};
        }
    }
];

/**
 * Brings Memory up to SCHEMA_VERSION. Returns the names of migrations that ran.
 * @param {any} [mem]
 * @returns {string[]}
 */
function migrate(mem = Memory) {
    const ran = [];
    let version = typeof mem.v === 'number' ? mem.v : 1;
    if (version > SCHEMA_VERSION) {
        log.throttled('memory.future', 1000, () =>
            log.error(`Memory.v=${version} is newer than this code (${SCHEMA_VERSION}); not migrating`));
        return ran;
    }
    for (const m of MIGRATIONS) {
        if (m.to <= version) continue;
        m.run(mem);
        version = m.to;
        mem.v = version;
        ran.push(m.name);
        log.info(`[memory] migrated → v${version}: ${m.name}`);
    }
    if (mem.v !== SCHEMA_VERSION) mem.v = SCHEMA_VERSION;
    ensureShape(mem);
    return ran;
}

/** @param {any} mem */
function ensureShape(mem) {
    if (!mem.creeps) mem.creeps = {};
    if (!mem.rooms) mem.rooms = {};
    if (!mem.e) mem.e = {};
}

/** @param {any} [mem] */
function isCurrent(mem = Memory) {
    return mem.v === SCHEMA_VERSION;
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, migrate, isCurrent };
