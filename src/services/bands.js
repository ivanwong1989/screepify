// @ts-check
'use strict';

/**
 * Store bands (docs/v2/LOGISTICS.md §2.1). For each (structure, resource):
 * min ≤ target ≤ max. Below min the store requests up to target; above max it
 * offers down to target; in between nothing moves. Storage is the buffer and
 * has no band. Pure: reads the structure and config only.
 *
 * @typedef {{min: number, target: number, max: number}} Band
 * @typedef {{terminal: import('./terminal').TerminalConfig, roomName: string,
 *            miningContainers: Set<string>, controllerContainer?: string|null, hasBuffer?: boolean,
 *            blocked?: Set<string>, exclude?: Set<string>,
 *            labs?: Record<string, import('./labs').LabRole>, labCfg?: import('./labs').LabConfig}} BandInfo
 *   labs: role per lab id (services/labs plan); labs without a role offer everything
 *   blocked: `${id}:${res}` left out by services/flipGuard
 *   exclude: stores another hauler owns outright (the core lane's targets)
 */

const TOWER_MIN = 0.7;
const CONTAINER_MIN = 0.5;

/** @param {number} min @param {number} target @param {number} max @returns {Band} */
function mk(min, target, max) {
    const t = Math.max(0, target);
    return { min: Math.min(Math.max(0, min), t), target: t, max: Math.max(max, t) };
}

/** Offer everything (mining containers, unwanted cargo). */
const OFFER_ALL = mk(0, 0, 0);

/** v1 deadband: 5% of the target, between 50 and 2000. @param {number} target */
function deadband(target) {
    return Math.max(50, Math.min(2000, Math.ceil(target * 0.05)));
}

/** True when this structure is the room's buffer (storage). @param {any} s */
function isBuffer(s) {
    return s.structureType === STRUCTURE_STORAGE;
}

/**
 * The band for one resource in one store, or null when the store takes no part
 * for that resource (it neither asks for it nor gives it away).
 * @param {any} s  structure with a store
 * @param {ResourceConstant} res
 * @param {BandInfo} info
 * @returns {Band|null}
 */
function band(s, res, info) {
    const cap = s.store.getCapacity(res) || 0;
    switch (s.structureType) {
        case STRUCTURE_SPAWN:
        case STRUCTURE_EXTENSION:
            return res === RESOURCE_ENERGY ? mk(cap, cap, cap) : null;
        case STRUCTURE_TOWER:
            return res === RESOURCE_ENERGY ? mk(Math.floor(cap * TOWER_MIN), cap, cap) : null;
        case STRUCTURE_CONTAINER:
            // Mining containers give everything. With storage, only the
            // controller container asks for energy; any other container is
            // emptied into storage. Without storage they are the room's buffer.
            if (info.miningContainers.has(s.id)) return OFFER_ALL;
            if (res !== RESOURCE_ENERGY) return OFFER_ALL;
            if (info.hasBuffer && s.id !== info.controllerContainer) return OFFER_ALL;
            return mk(Math.floor(cap * CONTAINER_MIN), cap, cap);
        case STRUCTURE_TERMINAL: {
            const cfg = info.terminal;
            const room = (cfg.rooms && cfg.rooms[info.roomName]) || {};
            if (res === RESOURCE_ENERGY) {
                const t = Number.isFinite(room.energy) ? /** @type {number} */ (room.energy) : cfg.energy;
                const m = cfg.energyMargin || 0;
                return mk(t - m, t, t + m);
            }
            const stock = Object.assign({}, cfg.stock || {}, room.stock || {});
            const t = Math.max(0, Number(stock[res]) || 0);
            if (t > 0) {
                const d = deadband(t);
                return mk(t - d, t, t + d);
            }
            return cfg.flushUntargeted ? OFFER_ALL : null;
        }
        case STRUCTURE_LAB: {
            // Energy in a lab is for boosting; it isn't moved here.
            if (res === RESOURCE_ENERGY) return null;
            const role = info.labs && info.labs[s.id];
            const held = labMineral(s);
            if (role && res === role.res) {
                // A lab holds one mineral: ask only once the old one is gone
                // (it is offered meanwhile: "empty but wrong mineral", v1).
                if (held && held !== res) return null;
                const c = /** @type {import('./labs').LabConfig} */ (info.labCfg);
                if (role.kind === 'in') return mk(Math.floor(c.inputTarget / 2), c.inputTarget, LAB_MINERAL_CAPACITY);
                if (role.kind === 'boost') return mk(Math.floor(c.boostTarget / 2), c.boostTarget, LAB_MINERAL_CAPACITY);
                return mk(0, 0, c.outputMax);
            }
            return OFFER_ALL;
        }
        default:
            return null;
    }
}

/** The mineral a lab holds, or null. @param {any} s */
function labMineral(s) {
    for (const r of Object.keys(s.store)) if (r !== RESOURCE_ENERGY && (s.store[r] || 0) > 0) return r;
    return null;
}

/**
 * Resources a store has a band for: everything it holds, plus what it may ask for.
 * @param {any} s
 * @param {BandInfo} info
 * @returns {ResourceConstant[]}
 */
function resourcesOf(s, info) {
    // Energy-only stores: no walk over the store's keys (costly in game).
    if (s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_TOWER) {
        return [RESOURCE_ENERGY];
    }
    const out = new Set(/** @type {ResourceConstant[]} */ (Object.keys(s.store).filter(r => (s.store[r] || 0) > 0)));
    if (s.structureType !== STRUCTURE_CONTAINER || band(s, RESOURCE_ENERGY, info) !== OFFER_ALL) out.add(RESOURCE_ENERGY);
    if (s.structureType === STRUCTURE_LAB) {
        out.delete(RESOURCE_ENERGY);
        const role = info.labs && info.labs[s.id];
        if (role) out.add(/** @type {ResourceConstant} */ (role.res));
        return Array.from(out);
    }
    if (s.structureType === STRUCTURE_TERMINAL) {
        const cfg = info.terminal;
        const room = (cfg.rooms && cfg.rooms[info.roomName]) || {};
        for (const r of Object.keys(Object.assign({}, cfg.stock || {}, room.stock || {}))) out.add(/** @type {ResourceConstant} */ (r));
    }
    return Array.from(out);
}

module.exports = { band, resourcesOf, isBuffer, deadband, mk, OFFER_ALL };
