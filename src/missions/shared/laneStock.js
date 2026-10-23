// @ts-check
'use strict';

const config = require('../../config');
const terminalRules = require('../../services/terminal');

/**
 * Core lane side job: terminal stock (P11, v1 logisticsCoreV2 stock jobs).
 *
 * While the lane hauler is idle at the head, next to both storage and the
 * terminal, it moves one load per two ticks toward the terminal targets
 * (services/terminal.nextMove): withdraw from one, transfer to the other.
 * Lane deliveries always come first; a load picked up for stock is then
 * simply put back by the hauler's normal cargo handling.
 *
 * Creep memory: sj = {f: 'storage'|'terminal', r: resource} while carrying a
 * stock load; sn = tick before which there's no need to look for a move.
 */

const IDLE_RECHECK = 10;

/**
 * Runs one step. Returns true if it used the tick.
 * @param {Creep} creep
 * @param {Room} room
 */
function step(creep, room) {
    const mem = /** @type {any} */ (creep.memory);
    const storage = room.storage;
    const terminal = room.terminal;
    if (!storage || !terminal || !terminal.my || !creep.pos.isNearTo(storage) || !creep.pos.isNearTo(terminal)) {
        delete mem.sj;
        return false;
    }
    if (mem.sj) {
        const res = /** @type {ResourceConstant} */ (mem.sj.r);
        if ((creep.store[res] || 0) > 0) {
            const dest = mem.sj.f === 'storage' ? terminal : storage;
            if (creep.transfer(dest, res) === OK) return true;
        }
        delete mem.sj;
    }
    if (creep.store.getUsedCapacity() > 0) return false;
    if (mem.sn && Game.time < mem.sn) return false;
    const move = terminalRules.nextMove(storage, terminal, config.get().terminal, room.name);
    if (!move) {
        mem.sn = Game.time + IDLE_RECHECK;
        return false;
    }
    delete mem.sn;
    const src = move.from === 'storage' ? storage : terminal;
    const n = Math.min(move.amount, creep.store.getFreeCapacity());
    if (n <= 0 || creep.withdraw(src, move.res, n) !== OK) return false;
    mem.sj = { f: move.from, r: move.res };
    return true;
}

module.exports = { step };
