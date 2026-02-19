// src/task/hooks/runFreeActions.js
'use strict';

const actionArbiter = require('task_core_actionArbiter');

function isAlly(username) {
  if (!username) return false;
  const allies = Memory.allies || [];
  return allies.includes(username);
}

function pickInjuredMyCreepInRange(creep, range) {
  const injured = creep.pos.findInRange(FIND_MY_CREEPS, range, {
    filter: c => c.hits < c.hitsMax
  });
  if (!injured || injured.length === 0) return null;
  // prefer lowest hits ratio
  injured.sort((a,b) => (a.hits/a.hitsMax) - (b.hits/b.hitsMax));
  return injured[0];
}

function pickHostileInRange(creep, range) {
  const hostiles = creep.pos.findInRange(FIND_HOSTILE_CREEPS, range, {
    filter: h => h.owner && !isAlly(h.owner.username)
  });
  if (!hostiles || hostiles.length === 0) return null;
  // prefer closest
  hostiles.sort((a,b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
  return hostiles[0];
}

module.exports = function runFreeActions(creep, context = {}) {
  try {
    const settings = (Memory.settings && Memory.settings.taskRefactor) || {};
    const enabled = !!settings.enabled;
    const hooksOnly = !!settings.hooksOnly;

    // Phase 2A: hooks can run when hooksOnly OR enabled (future phases)
    if (!enabled && !hooksOnly) return;

    const state = creep._actionState;
    if (!state) return;

    // -------------------------
    // A) COMBAT FREE ACTIONS
    // -------------------------

    // 1) HEAL (self > ally in range1), then rangedHeal (ally in range3)
    if (creep.getActiveBodyparts(HEAL) > 0) {
      // self heal
      if (creep.hits < creep.hitsMax && actionArbiter.canUse(state, actionArbiter.SLOTS.heal)) {
        actionArbiter.claim(state, actionArbiter.SLOTS.heal);
        creep.heal(creep);
      } else {
        const nearInjured = pickInjuredMyCreepInRange(creep, 1);
        if (nearInjured && actionArbiter.canUse(state, actionArbiter.SLOTS.heal)) {
          actionArbiter.claim(state, actionArbiter.SLOTS.heal);
          creep.heal(nearInjured);
        } else {
          const farInjured = pickInjuredMyCreepInRange(creep, 3);
          if (farInjured && actionArbiter.canUse(state, actionArbiter.SLOTS.rangedHeal)) {
            actionArbiter.claim(state, actionArbiter.SLOTS.rangedHeal);
            creep.rangedHeal(farInjured);
          }
        }
      }
    }

    let didOffense = false;
    // 2) RANGED ATTACK / ATTACK (opportunistic)
    // Prefer rangedAttack if available; do not block melee attackers.
    if (creep.getActiveBodyparts(RANGED_ATTACK) > 0 && actionArbiter.canUse(state, actionArbiter.SLOTS.rangedAttack)) {
      const hostile = pickHostileInRange(creep, 3);
      if (hostile) {
        actionArbiter.claim(state, actionArbiter.SLOTS.rangedAttack);
        creep.rangedAttack(hostile);
        didOffense = true;
      }
    }

    if (!didOffense && creep.getActiveBodyparts(ATTACK) > 0 && actionArbiter.canUse(state, actionArbiter.SLOTS.attack)) {
      const hostile = pickHostileInRange(creep, 1);
      if (hostile) {
        actionArbiter.claim(state, actionArbiter.SLOTS.attack);
        creep.attack(hostile);
        didOffense = true;
      }
    }

    // -------------------------
    // B) UTILITY FREE ACTIONS (Phase 2A optional; keep minimal)
    // -------------------------
    // Intentionally skipped for now to avoid behavior drift:
    // - pickup on tile
    // - opportunistic withdraw/transfer

  } catch (e) {
    // must fail silently (hooks must never break the tick)
    // optional debug:
    // const taskDebug = require('task_core_debug'); taskDebug.incGlobal('errors');
  }
};
