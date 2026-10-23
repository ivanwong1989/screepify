// @ts-check
'use strict';

/**
 * Terminal energy balancing between rooms (P11, v1 zeadmin's energy balancer).
 * Pure. Terminal stock (storage ↔ terminal) is not here: the terminal's bands
 * (services/bands) put it in the logistics request list like any other store.
 *
 * Balance (terminal → terminal, act.terminal): a room whose storage+terminal
 * energy is above its policy stockpile target × (1 + hysteresis) sends to the
 * room furthest below its own target, at most `batch` per send.
 */

/**
 * @typedef {{energy: number, energyMargin?: number, stock: Record<string, number>, flushUntargeted: boolean,
 *            rooms: Record<string, {energy?: number, stock?: Record<string, number>}>,
 *            balance: {enabled: boolean, batch: number}}} TerminalConfig
 */

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

module.exports = { balance };
