// @ts-check
'use strict';

/**
 * Mission contracts (DESIGN §8). Types only — implemented in phase 1.
 *
 * @typedef {Object} Demand
 * @property {number} [work]
 * @property {number} [carry]
 * @property {number} [claim]
 * @property {number} minCreeps
 * @property {number} maxCreeps
 *
 * @typedef {Object} Mission
 * @property {string} id            stable, e.g. 'harvest:W1N1:<sourceId>'
 * @property {string} type          MissionType key
 * @property {string} home          owning room (spawns + owns the creeps)
 * @property {string} room          room where the work happens (may differ from home)
 * @property {string} [shardTarget] cross-shard missions only (DESIGN §18.3)
 * @property {number} priority      higher = more important
 * @property {Demand} demand
 * @property {string} archetype     body recipe key
 * @property {Object} [data]        type-specific, owned by the MissionType
 *
 * @typedef {Object} MissionType
 * @property {string} type
 * @property {number} every         planning cadence
 * @property {(r: import('./ctx').RoomCtx, ctx: import('./ctx').TickContext) => Mission[]} generate
 * @property {(creep: Creep, m: Mission, r: import('./ctx').RoomCtx) => import('./task').Task|null} nextTask
 * @property {(budget: number, m: Mission) => BodyPartConstant[]} body
 * @property {(creep: Creep, m: Mission) => number} [fitness]
 */

module.exports = {};
