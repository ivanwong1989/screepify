// @ts-check
'use strict';

/**
 * Pure room-policy rules (no tick state). `sense.policy` decides the phase and
 * state; missions and processes read `rc.policy` and ask these helpers what it
 * means, so they don't import the policy process itself.
 *
 * @typedef {import('../processes/sense/policy').Phase} Phase
 * @typedef {import('../processes/sense/policy').PolicyState} PolicyState
 * @typedef {import('../processes/sense/policy').RoomPolicy} RoomPolicy
 */

/** @type {Phase[]} */
const PHASES = ['BOOTSTRAP', 'EARLY', 'BASIC_INFRA', 'STORAGE', 'LINKS', 'TERMINAL', 'LABS'];
/** @type {PolicyState[]} */
const STATES = ['CRITICAL', 'RECOVER', 'GROW', 'STOCKPILE', 'DEFENSIVE', 'SIEGE'];

/** @param {string} p */
function rank(p) {
    const i = PHASES.indexOf(/** @type {Phase} */ (p));
    return i < 0 ? 0 : i;
}

/**
 * True when the room has reached `phase` or later.
 * @param {{phase: string}|undefined} policy
 * @param {Phase} phase
 */
function atLeast(policy, phase) {
    return !!policy && rank(policy.phase) >= rank(phase);
}

/**
 * Fortifying (walls/ramparts above critical) by room policy (v1 rules):
 * always under threat; off while CRITICAL / STOCKPILE; no new spawns while
 * RECOVER (spawn energy dips after every big spawn, so existing fortifiers
 * keep going); otherwise only once the room has storage.
 * Critical forts are repairs and are always allowed.
 * @param {RoomPolicy|undefined} policy
 * @returns {'on'|'noSpawn'|'off'}
 */
function fortifyMode(policy) {
    if (!policy) return 'on';
    if (policy.state === 'DEFENSIVE' || policy.state === 'SIEGE') return 'on';
    if (policy.state === 'CRITICAL' || policy.state === 'STOCKPILE') return 'off';
    if (!atLeast(policy, 'STORAGE')) return 'off';
    return policy.state === 'RECOVER' ? 'noSpawn' : 'on';
}

module.exports = { PHASES, STATES, rank, atLeast, fortifyMode };
