// @ts-check
'use strict';

/**
 * Mission contracts (DESIGN §8). Types only.
 *
 * A mission says what work is needed. The assignment process fills it with
 * creeps, the spawner fills the gap with new creeps, and the mission type's
 * `nextTask` turns it into one task at a time for each assigned creep.
 *
 * @typedef {Object} Demand
 * @property {number} [work]       WORK parts wanted (v1 requiredWork)
 * @property {number} [carry]      CARRY parts wanted (v1 requiredCarry)
 * @property {number} [claim]      CLAIM parts wanted
 * @property {number} minCreeps    v1 minCount
 * @property {number} [maxCreeps]  v1 maxCount (undefined = no cap)
 *
 * How the spawner treats a mission (v1 spawn contract bind modes):
 * - 'pool':    adds its headcount to the home room's pool for this archetype
 * - 'slots':   one creep per slot key (e.g. harvest positions)
 * - 'mission': creeps bound to this mission id
 * - false:     never spawns for it (filled by existing creeps only)
 * @typedef {'pool'|'slots'|'mission'|false} SpawnMode
 *
 * @typedef {Object} Mission
 * @property {string} id            stable, e.g. 'harvest:<sourceId>' (v1 mission name)
 * @property {string} type          MissionType key ('harvest', 'transfer', 'upgrade', ...)
 * @property {string} home          owning room (spawns + owns the creeps)
 * @property {string} room          room where the work happens (may differ from home)
 * @property {string} [shardTarget] cross-shard missions only (DESIGN §18.3)
 * @property {number} priority      higher = more important
 * @property {string} [archetype]   creep body class required (miner, hauler, worker, ...)
 * @property {Demand} demand
 * @property {SpawnMode} spawn
 * @property {string[]} [slots]     spawn: 'slots' only
 * @property {number} [leadTicks]   pre-spawn replacements this many ticks early
 * @property {{mode?: string, maxCarry?: number}} [bodyOpts]
 * @property {string} [targetId]
 * @property {string[]} [targetIds]
 * @property {RoomPosition} [pos]   used to pick the closest mission among equals
 * @property {Object} [data]        type-specific, owned by the MissionType
 *
 * @typedef {Object} PlanContext
 * @property {import('./ctx').RoomCtx} rc
 * @property {import('./ctx').TickContext} ctx
 * @property {import('../processes/sense/intel').RoomIntel} intel
 * @property {import('../processes/sense/intel').RoomState} state
 * @property {import('../processes/sense/policy').RoomPolicy|undefined} policy
 * @property {number} budget                  energy budget for body estimates
 * @property {Set<string>} efficientSources
 * @property {(missionId: string) => {count: number, work: number, carry: number}} census
 *
 * @typedef {Object} MissionType
 * @property {string} type
 * @property {(creep: Creep, m: Mission, rc: import('./ctx').RoomCtx, ctx: import('./ctx').TickContext) => import('./task').Task|null} nextTask
 *           Returns the creep's next task, or null to release it from the mission.
 */

module.exports = {};
