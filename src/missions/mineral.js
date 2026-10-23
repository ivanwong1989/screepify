// @ts-check
'use strict';

const config = require('../config');
const roomData = require('../services/roomData');
const policyRules = require('../services/policyRules');
const state = require('./shared/state');
const matcher = require('../services/matcher');

/**
 * Mineral mining (port of v1 mission.mineral + role.mineralMiner).
 *
 * mineral:<id>  one miner (archetype mineralMiner, worker body) per mineral
 *               with an extractor. It harvests until full, carries the load
 *               where the logistics request list wants it and comes back.
 *
 * When (v1): phase STORAGE or later, not CRITICAL / RECOVER / SIEGE, mineral
 * not depleted.
 *
 * Differences from v1:
 * - Stock cap: no mining while storage + terminal already hold
 *   `config.minerals.maxStock` of that mineral, or storage has less than
 *   `minStorageFree` space (minerals must not crowd out the energy stockpile).
 * - Loads go where the logistics request list wants them (a terminal stock
 *   target, else storage), not to the terminal first.
 */

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, policy } = plan;
    const cfg = config.get().minerals;
    const room = rc.room;
    const storage = room.storage;
    if (!cfg.enabled || !storage || !policyRules.atLeast(policy, 'STORAGE')) return;
    if (policy && (policy.state === 'CRITICAL' || policy.state === 'RECOVER' || policy.state === 'SIEGE')) return;
    if (storage.store.getFreeCapacity() < cfg.minStorageFree) return;
    const extractors = roomData.myByType(room, STRUCTURE_EXTRACTOR);
    for (const mineral of roomData.minerals(room)) {
        if (mineral.mineralAmount <= 0) continue;
        if (!extractors.some(e => e.pos.isEqualTo(mineral.pos))) continue;
        const type = mineral.mineralType;
        const held = (storage.store[type] || 0) + (room.terminal ? room.terminal.store[type] || 0 : 0);
        if (held >= cfg.maxStock) continue;
        out.push({
            id: `mineral:${mineral.id}`, type: 'mineral', home: rc.name, room: rc.name, archetype: 'mineralMiner',
            demand: { minCreeps: 1, maxCreeps: 1 }, spawn: 'mission',
            targetId: mineral.id, pos: mineral.pos,
            data: { resourceType: type },
            priority: 40
        });
    }
}

/** @type {import('../contracts/mission').MissionType['nextTask']} */
function nextTask(creep, m, rc) {
    const mineral = /** @type {Mineral|null} */ (state.obj(m.targetId));
    const depleted = !mineral || mineral.mineralAmount <= 0;
    // Same "full" test as the harvest action, so a finished harvest goes straight to delivery.
    const full = creep.store.getFreeCapacity() <= creep.getActiveBodyparts(WORK) * HARVEST_POWER;
    if (creep.store.getUsedCapacity() > 0 && (full || depleted)) {
        const res = /** @type {ResourceConstant} */ (Object.keys(creep.store).find(r => (creep.store[/** @type {ResourceConstant} */ (r)] || 0) > 0));
        // Where it goes is the request list's call (a terminal stock target,
        // else storage); storage then terminal only when nothing wants it.
        const room = creep.room;
        const asked = rc.requests ? matcher.redirect(rc.requests, res, creep.store[res] || 0) : null;
        const dest = asked || ([room.storage, room.terminal].find(s => s && s.store.getFreeCapacity(res) > 0) || {}).id;
        return dest ? { a: 'transfer', i: dest, r: res } : null;
    }
    if (depleted) return null;
    return { a: 'harvest', i: /** @type {Mineral} */ (mineral).id };
}

module.exports = { type: 'mineral', generate, nextTask };
