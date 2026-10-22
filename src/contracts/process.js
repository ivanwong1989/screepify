// @ts-check
'use strict';

/**
 * Process contract (DESIGN §5.1). Types only — no runtime code.
 *
 * @typedef {'SENSE'|'PLAN'|'ACT'|'REPORT'} Phase
 *
 * Tiers decide shedding under CPU pressure (DESIGN §5.2):
 * - critical: always runs, even over budget
 * - normal:   runs if it fits the budget
 * - low:      runs if it fits the budget and the bucket is >= 1,000
 * - burst:    runs on its own (one per tick, after ACT) when `pending()` is true
 *             and the bucket is >= `bucketNeeded`; not counted against the budget
 * @typedef {'critical'|'normal'|'low'|'burst'} Tier
 *
 * @typedef {Object} Process
 * @property {string} id                 unique, e.g. 'report.stats'
 * @property {Phase} phase
 * @property {'room'|'shard'} scope      room: once per tracked room; shard: once per tick
 * @property {Tier} tier
 * @property {number} [priority]         lower runs first within a phase (default 100)
 * @property {number} [every]            cadence in ticks, staggered (default 1)
 * @property {import('./ctx').RoomKind[]} [kinds]  room scope only: room kinds to run on
 *                                       (default: all tracked rooms)
 * @property {number} [bucketNeeded]     burst only: minimum bucket before it may run
 * @property {(ctx: import('./ctx').TickContext) => boolean} [pending]
 *                                       burst only: true while it still has work
 * @property {(ctx: import('./ctx').TickContext) => void} [init]   once per VM boot
 * @property {(ctx: import('./ctx').TickContext, room: import('./ctx').RoomCtx) => void} run
 *                                       `room` is undefined for shard-scope processes
 */

module.exports = {};
