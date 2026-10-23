// @ts-check
'use strict';

const cache = require('../../services/cache');
const roomData = require('../../services/roomData');
const { PHASES, STATES, rank, atLeast } = require('../../services/policyRules');

/**
 * Room policy: phase + state (port of v1 overseer/policy, dev_make_missions_missions).
 *
 * Phase says how far the room's infrastructure has come, and decides which
 * logistics/harvest style fits. State says what the room should put first
 * right now. Mission generators read `rc.policy`; nothing else writes it.
 *
 * Phase (highest that matches):
 *   LABS        any lab
 *   TERMINAL    terminal
 *   LINKS       storage + ≥2 links, one at a source or the controller
 *   STORAGE     storage
 *   BASIC_INFRA ≥75% of sources have a container + one non-mining container
 *   EARLY       any source or non-mining container
 *   BOOTSTRAP   otherwise (also: no spawn or no sources)
 *
 * State (first that matches):
 *   SIEGE       console override only (no combat layer in v2 yet)
 *   DEFENSIVE   hostile creeps with combat/work/claim parts in the room
 *   CRITICAL    no creeps, no miners, or < 300 energy with < 2 creeps
 *   RECOVER     ≤ 2 creeps, no haulers, or spawn energy < max(250, 35% cap)
 *   STOCKPILE   storage energy below the RCL target (±10% hysteresis)
 *   GROW        healthy
 *
 * Differences from v1:
 * - Creep counts come from census archetypes, not roles (haulers = hauler +
 *   miningHauler + laneHauler).
 * - DEFENSIVE ignores hostiles with no ATTACK/RANGED_ATTACK/HEAL/WORK/CLAIM
 *   (scouts passing through no longer stop upgrading).
 * - RECOVER's spawn-energy check only counts once the room has extensions,
 *   so a 300-capacity room isn't stuck in RECOVER after every spawn.
 * - Phase BOOTSTRAP alone is not RECOVER: a drop-mining room with a healthy
 *   workforce keeps upgrading (v2's early economy depends on it).
 * - Previous state is kept in Memory.rooms[n].ps; override with
 *   Memory.rooms[n].po = 'GROW' | ... (console: policy.set(room, state)).
 */

/** @typedef {'BOOTSTRAP'|'EARLY'|'BASIC_INFRA'|'STORAGE'|'LINKS'|'TERMINAL'|'LABS'} Phase */
/** @typedef {'CRITICAL'|'RECOVER'|'GROW'|'STOCKPILE'|'DEFENSIVE'|'SIEGE'} PolicyState */
/** @typedef {{phase: Phase, state: PolicyState, reasons: string[]}} RoomPolicy */

/** @type {string[]} */
const THREAT_PARTS = [ATTACK, RANGED_ATTACK, HEAL, WORK, CLAIM];

/**
 * Inputs the rules need, gathered once so the rules stay pure and testable.
 * @typedef {Object} PolicyFacts
 * @property {boolean} hasSpawn
 * @property {number} sourceCount
 * @property {number} sourceContainers  sources with a container
 * @property {number} sourceLinks       sources with a link
 * @property {number} otherContainers   containers that aren't at a source
 * @property {number} links
 * @property {boolean} controllerLink   link within range 3 of the controller
 * @property {number} labs
 * @property {number} extensions
 * @property {boolean} hasStorage
 * @property {boolean} hasTerminal
 * @property {number} rcl
 * @property {number} storageEnergy
 * @property {number} energyAvailable
 * @property {number} energyCapacity
 * @property {number} creeps            creeps homed here (incl. spawning)
 * @property {number} miners
 * @property {number} haulers
 * @property {number} threats           hostile creeps that can hurt us
 */

/**
 * @param {PolicyFacts} f
 * @returns {Phase}
 */
function derivePhase(f) {
    if (!f.hasSpawn || f.sourceCount <= 0) return 'BOOTSTRAP';
    if (f.labs > 0) return 'LABS';
    if (f.hasTerminal) return 'TERMINAL';
    const linksReady = f.links >= 2 && (f.sourceLinks > 0 || f.controllerLink);
    if (f.hasStorage && linksReady) return 'LINKS';
    if (f.hasStorage) return 'STORAGE';
    const majorCoverage = f.sourceContainers >= Math.max(1, Math.ceil(f.sourceCount * 0.75));
    if (majorCoverage && f.otherContainers > 0) return 'BASIC_INFRA';
    if (f.sourceContainers > 0 || f.otherContainers > 0) return 'EARLY';
    return 'BOOTSTRAP';
}

/**
 * @param {PolicyFacts} f
 * @param {string|undefined} prev     last tick's state (for stockpile hysteresis)
 * @param {{stockpileTargets: Record<string, number>, stockpileHysteresis: number}} cfg
 * @param {string[]} reasons          filled with why the state was chosen
 * @returns {PolicyState}
 */
function deriveState(f, prev, cfg, reasons) {
    if (f.threats > 0) {
        reasons.push(`${f.threats} hostile threat(s) -> DEFENSIVE`);
        return 'DEFENSIVE';
    }
    if (f.creeps <= 0) {
        reasons.push('no creeps -> CRITICAL');
        return 'CRITICAL';
    }
    if (f.sourceCount > 0 && f.miners <= 0) {
        reasons.push('no miners -> CRITICAL');
        return 'CRITICAL';
    }
    if (f.energyAvailable < 300 && f.creeps < 2) {
        reasons.push('spawn energy < 300 and < 2 creeps -> CRITICAL');
        return 'CRITICAL';
    }

    const spawnEnergyLow = f.extensions > 0 &&
        f.energyAvailable < Math.max(250, Math.floor(f.energyCapacity * 0.35));
    if (f.creeps <= 2 || f.haulers <= 0 || spawnEnergyLow) {
        const why = f.creeps <= 2 ? `${f.creeps} creeps` : f.haulers <= 0 ? 'no haulers'
            : `spawn energy ${f.energyAvailable}/${f.energyCapacity}`;
        reasons.push(`${why} -> RECOVER`);
        return 'RECOVER';
    }

    const target = cfg.stockpileTargets[f.rcl] || 0;
    if (f.hasStorage && target > 0) {
        const lower = Math.round(target * (1 - cfg.stockpileHysteresis));
        const upper = Math.round(target * (1 + cfg.stockpileHysteresis));
        if (prev === 'STOCKPILE') {
            if (f.storageEnergy < upper) {
                reasons.push(`storage ${f.storageEnergy} < ${upper} (target ${target}) -> STOCKPILE`);
                return 'STOCKPILE';
            }
            reasons.push(`storage ${f.storageEnergy} >= ${upper} -> GROW`);
            return 'GROW';
        }
        if (f.storageEnergy <= lower) {
            reasons.push(`storage ${f.storageEnergy} <= ${lower} (target ${target}) -> STOCKPILE`);
            return 'STOCKPILE';
        }
    }
    reasons.push('healthy -> GROW');
    return 'GROW';
}

/** @param {Creep} c */
function isThreat(c) {
    return c.body.some(p => p.hits > 0 && THREAT_PARTS.indexOf(p.type) !== -1);
}

/**
 * @param {Room} room
 * @param {import('./intel').RoomIntel} intel
 * @param {import('./census').Census|undefined} census
 * @returns {PolicyFacts}
 */
function facts(room, intel, census) {
    const ctrl = room.controller;
    const links = roomData.myByType(room, STRUCTURE_LINK);
    const containers = roomData.byType(room, STRUCTURE_CONTAINER);
    const byArch = (census && census.byArchetype) || {};
    return {
        hasSpawn: roomData.myByType(room, STRUCTURE_SPAWN).length > 0,
        sourceCount: intel.sources.length,
        sourceContainers: intel.sources.filter(s => s.containerId).length,
        sourceLinks: intel.sources.filter(s => s.linkId).length,
        otherContainers: containers.filter(c => !intel.miningContainerIds.has(c.id)).length,
        links: links.length,
        controllerLink: !!ctrl && links.some(l => l.pos.getRangeTo(ctrl) <= 3),
        labs: roomData.myByType(room, STRUCTURE_LAB).length,
        extensions: roomData.myByType(room, STRUCTURE_EXTENSION).length,
        hasStorage: !!room.storage,
        hasTerminal: !!room.terminal,
        rcl: ctrl ? ctrl.level : 0,
        storageEnergy: intel.storageEnergy,
        energyAvailable: intel.energyAvailable,
        energyCapacity: intel.energyCapacityAvailable,
        creeps: census ? census.creeps.length : intel.myCreeps.length,
        miners: (byArch.miner || []).length,
        haulers: (byArch.hauler || []).length + (byArch.miningHauler || []).length + (byArch.laneHauler || []).length,
        threats: intel.hostiles.filter(isThreat).length
    };
}

/**
 * @param {Room} room
 * @param {import('./intel').RoomIntel} intel
 * @param {import('./census').Census|undefined} census
 * @param {import('../../config').Config['policy']} cfg
 * @returns {RoomPolicy}
 */
function evaluate(room, intel, census, cfg) {
    const mem = /** @type {any} */ (Memory.rooms[room.name] || (Memory.rooms[room.name] = {}));
    const f = facts(room, intel, census);
    const phase = derivePhase(f);
    /** @type {string[]} */
    const reasons = [];
    const override = typeof mem.po === 'string' ? mem.po.trim().toUpperCase() : '';
    /** @type {PolicyState} */
    let state;
    if (STATES.indexOf(/** @type {PolicyState} */ (override)) !== -1) {
        state = /** @type {PolicyState} */ (override);
        reasons.push(`override -> ${state}`);
    } else {
        state = deriveState(f, mem.ps, cfg, reasons);
    }
    mem.ps = state;
    return { phase, state, reasons };
}

/** @type {import('../../contracts/process').Process & Record<string, any>} */
module.exports = {
    id: 'sense.policy',
    phase: 'SENSE',
    scope: 'room',
    kinds: ['owned', 'bootstrap'],
    tier: 'critical',
    priority: 30,
    run(ctx, rc) {
        if (!rc.intel) return;
        rc.policy = evaluate(rc.room, rc.intel, rc.census, ctx.config.policy);
        // Last result per room, for the console (policy.show()).
        cache.store('policy.last')[rc.name] = rc.policy;
    },
    PHASES,
    STATES,
    rank,
    atLeast,
    derivePhase,
    deriveState,
    facts,
    evaluate
};
