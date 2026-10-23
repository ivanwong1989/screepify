// @ts-check
'use strict';

/**
 * Terminal rules (P11, port of v1 manager.terminal stock targets + the
 * core lane's terminal stock jobs, and v1 zeadmin's energy balancer).
 * Pure: they read stores and config and say what to move.
 *
 * Stock (storage ↔ terminal, done by the core lane hauler):
 * - energy: keep `config.terminal.energy` in the terminal (exact, as v1).
 * - other resources: `config.terminal.stock[res]`, overridden per room by
 *   `config.terminal.rooms[room].stock`, held within a deadband of 5% of the
 *   target (50 – 2000), as v1. Resources with no target stay where they are
 *   unless `flushUntargeted` (v1 always moved them back to storage).
 *
 * Balance (terminal → terminal, act.terminal): a room whose storage+terminal
 * energy is above its policy stockpile target × (1 + hysteresis) sends to the
 * room furthest below its own target, at most `batch` per send.
 */

/**
 * @typedef {{energy: number, stock: Record<string, number>, flushUntargeted: boolean,
 *            rooms: Record<string, {energy?: number, stock?: Record<string, number>}>,
 *            balance: {enabled: boolean, batch: number}}} TerminalConfig
 * @typedef {{from: 'storage'|'terminal', res: ResourceConstant, amount: number}} StockMove
 */

/**
 * Terminal targets for a room.
 * @param {TerminalConfig} cfg
 * @param {string} roomName
 * @returns {{energy: number, stock: Record<string, number>}}
 */
function targets(cfg, roomName) {
    const room = (cfg.rooms && cfg.rooms[roomName]) || {};
    const energy = Number.isFinite(room.energy) ? /** @type {number} */ (room.energy) : cfg.energy;
    return { energy: Math.max(0, energy || 0), stock: Object.assign({}, cfg.stock || {}, room.stock || {}) };
}

/** v1 deadband: 5% of the target, between 50 and 2000. @param {number} target */
function deadband(target) {
    return Math.max(50, Math.min(2000, Math.ceil(target * 0.05)));
}

/**
 * The most useful single move between storage and terminal, or null.
 * Energy first, then the resource furthest from its target.
 * @param {StructureStorage} storage
 * @param {StructureTerminal} terminal
 * @param {TerminalConfig} cfg
 * @param {string} roomName
 * @returns {StockMove|null}
 */
function nextMove(storage, terminal, cfg, roomName) {
    const t = targets(cfg, roomName);
    const termE = terminal.store[RESOURCE_ENERGY] || 0;
    if (termE < t.energy) {
        const n = Math.min(t.energy - termE, storage.store[RESOURCE_ENERGY] || 0, terminal.store.getFreeCapacity(RESOURCE_ENERGY));
        if (n > 0) return { from: 'storage', res: RESOURCE_ENERGY, amount: n };
    } else if (termE > t.energy) {
        const n = Math.min(termE - t.energy, storage.store.getFreeCapacity(RESOURCE_ENERGY));
        if (n > 0) return { from: 'terminal', res: RESOURCE_ENERGY, amount: n };
    }

    /** @type {StockMove|null} */
    let best = null;
    const consider = (/** @type {StockMove} */ m) => { if (m.amount > 0 && (!best || m.amount > best.amount)) best = m; };
    const keys = new Set(Object.keys(t.stock).concat(Object.keys(terminal.store)));
    for (const k of keys) {
        if (k === RESOURCE_ENERGY) continue;
        const res = /** @type {ResourceConstant} */ (k);
        const have = terminal.store[res] || 0;
        const target = Math.max(0, Number(t.stock[res]) || 0);
        if (target > 0) {
            const band = deadband(target);
            if (have < target - band) {
                consider({ from: 'storage', res, amount: Math.min(target - have, storage.store[res] || 0, terminal.store.getFreeCapacity(res)) });
            } else if (have > target + band) {
                consider({ from: 'terminal', res, amount: Math.min(have - target, storage.store.getFreeCapacity(res)) });
            }
        } else if (have > 0 && cfg.flushUntargeted) {
            consider({ from: 'terminal', res, amount: Math.min(have, storage.store.getFreeCapacity(res)) });
        }
    }
    return best;
}

/**
 * @typedef {{name: string, energy: number, target: number, terminalEnergy: number}} BalanceRoom
 * @typedef {{from: string, to: string, amount: number}} BalanceSend
 */

/**
 * One energy send from the room with the most surplus to the room furthest
 * below its target, or null.
 * @param {BalanceRoom[]} rooms
 * @param {number} hysteresis       policy stockpile hysteresis (0.1)
 * @param {number} batch
 * @param {(amount: number, from: string, to: string) => number} cost  energy the send costs
 * @returns {BalanceSend|null}
 */
function balance(rooms, hysteresis, batch, cost) {
    let donor = null;
    let surplus = 0;
    let receiver = null;
    let deficit = 0;
    for (const r of rooms) {
        const s = r.energy - Math.round(r.target * (1 + hysteresis));
        if (s > surplus) {
            surplus = s;
            donor = r;
        }
        const d = r.target - r.energy;
        if (d > deficit) {
            deficit = d;
            receiver = r;
        }
    }
    if (!donor || !receiver || donor === receiver) return null;
    let amount = Math.floor(Math.min(batch, surplus, deficit));
    // The terminal pays the fee in energy too.
    while (amount > 0 && amount + cost(amount, donor.name, receiver.name) > donor.terminalEnergy) amount = Math.floor(amount / 2);
    if (amount < 1000) return null;
    return { from: donor.name, to: receiver.name, amount };
}

module.exports = { targets, deadband, nextMove, balance };
