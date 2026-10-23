// @ts-check
'use strict';

const roomData = require('../../services/roomData');
const towerMissions = require('../../missions/tower');

/**
 * Towers (port of v1 tasker tower assignment + role.tower).
 *
 * Every tower takes the highest-priority tower mission (defense > heal > repair):
 * - attack: quick kills (≤ 3 shots) first, then the healer keeping an
 *   unkillable target alive, then the fastest kill, else closest
 * - heal/repair: closest target with remaining deficit, deficits shared
 *   across towers so they don't all overheal one target
 *
 * Tower missions are worked out fresh here every tick (missions/tower), not
 * read from the planned list, which is refreshed every 2 ticks and can be
 * skipped under CPU pressure: a hostile that just entered gets shot at once.
 */

/**
 * @param {string} action
 * @param {number} range
 */
function effectAt(action, range) {
    const base = action === 'heal' ? TOWER_POWER_HEAL : action === 'repair' ? TOWER_POWER_REPAIR : TOWER_POWER_ATTACK;
    const r = Math.max(1, Math.min(range, 50));
    if (r <= TOWER_OPTIMAL_RANGE) return base;
    if (r >= TOWER_FALLOFF_RANGE) return base * (1 - TOWER_FALLOFF);
    return base * (1 - TOWER_FALLOFF * ((r - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE)));
}

/** @param {Creep} c */
function healPower(c) {
    let total = 0;
    for (const p of c.body) {
        if (p.type !== HEAL || p.hits <= 0) continue;
        const b = p.boost && BOOSTS[HEAL] && BOOSTS[HEAL][p.boost];
        total += 12 * ((b && /** @type {any} */ (b).heal) || 1);
    }
    return total;
}

/**
 * @param {StructureTower} tower
 * @param {any[]} targets
 */
function attackTarget(tower, targets) {
    const creeps = targets.filter(t => t instanceof Creep);
    if (creeps.length === 0) return tower.pos.findClosestByRange(targets);
    const healers = creeps.filter(c => c.getActiveBodyparts(HEAL) > 0);
    const stats = creeps.map(t => {
        const r = tower.pos.getRangeTo(t);
        let healing = 0;
        for (const h of healers) if (h.pos.inRangeTo(t.pos, 3)) healing += healPower(h);
        const net = effectAt('attack', r) - healing;
        return { t, r, net, shots: net > 0 ? Math.ceil(t.hits / net) : Infinity, heal: healers.indexOf(t) !== -1 ? healPower(t) : 0 };
    });
    const quick = stats.filter(s => s.shots <= 3).sort((a, b) => (a.shots - b.shots) || (a.r - b.r));
    if (quick.length) return quick[0].t;
    const unkillable = stats.filter(s => s.net <= 0);
    if (unkillable.length && healers.length) {
        const blockers = stats.filter(s => s.heal > 0 && unkillable.some(u => s.t.pos.inRangeTo(u.t.pos, 3)))
            .sort((a, b) => (b.heal - a.heal) || (a.r - b.r));
        if (blockers.length) return blockers[0].t;
    }
    const killable = stats.filter(s => s.shots !== Infinity).sort((a, b) => (a.shots - b.shots) || (a.r - b.r));
    if (killable.length) return killable[0].t;
    return tower.pos.findClosestByRange(creeps);
}

/** @type {import('../../contracts/process').Process & Record<string, any>} */
module.exports = {
    id: 'act.towers',
    phase: 'ACT',
    scope: 'room',
    kinds: ['owned', 'bootstrap'],
    tier: 'critical',
    priority: 20,
    run(ctx, rc) {
        const towers = roomData.myByType(rc.room, STRUCTURE_TOWER);
        if (towers.length === 0) return;
        /** @type {import('../../contracts/mission').Mission[]} */
        let list = [];
        if (rc.intel && rc.state) {
            towerMissions.generate(/** @type {any} */ ({ rc, intel: rc.intel, state: rc.state }), list);
        } else if (rc.missions) {
            list = rc.missions;
        }
        const mission = list
            .filter(m => m.type === 'tower_attack' || m.type === 'tower_heal' || m.type === 'tower_repair')
            .sort((a, b) => b.priority - a.priority)[0];
        if (!mission) return;
        const targets = (mission.targetIds || []).map(id => /** @type {any} */ (Game.getObjectById(/** @type {any} */ (id)))).filter(Boolean);
        if (targets.length === 0) return;
        const action = mission.type === 'tower_attack' ? 'attack' : mission.type === 'tower_heal' ? 'heal' : 'repair';
        /** @type {Record<string, number>} */
        const deficit = {};
        for (const t of targets) deficit[t.id] = Math.max(0, (t.hitsMax || 0) - (t.hits || 0));

        for (const tower of towers) {
            if (tower.store[RESOURCE_ENERGY] < TOWER_ENERGY_COST) continue;
            if (action === 'attack') {
                const t = attackTarget(tower, targets);
                if (t) tower.attack(t);
                continue;
            }
            let best = null;
            let bestR = Infinity;
            for (const t of targets) {
                if ((deficit[t.id] || 0) <= 0) continue;
                const r = tower.pos.getRangeTo(t);
                if (r < bestR) {
                    bestR = r;
                    best = t;
                }
            }
            if (!best) continue;
            deficit[best.id] -= effectAt(action, bestR);
            if (action === 'heal') tower.heal(best);
            else tower.repair(best);
        }
    },
    effectAt,
    attackTarget
};
