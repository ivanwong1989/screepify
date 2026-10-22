// @ts-check
'use strict';

/**
 * Tick context (DESIGN §6). Types only — no runtime code.
 *
 * Ownership rule: every field has exactly one writer process (named below).
 * Every other process only reads it.
 *
 * @typedef {'owned'|'bootstrap'|'remote'|'claiming'|'target'|'scouted'} RoomKind
 *
 * @typedef {Object} RoomCtx
 * @property {string} name
 * @property {Room} room
 * @property {RoomKind} kind              writer: kernel/context (from Memory.rooms[n].k)
 * @property {Object} [intel]             writer: sense.intel        (phase 1)
 * @property {import('./mission').Mission[]} [missions]  writer: plan.missions (phase 1)
 * @property {Object} [census]            writer: sense.census       (phase 1)
 * @property {Object} [reservations]      writer: act.* via reservation service (phase 1)
 * @property {import('./spawn').SpawnRequest[]} [spawnQueue]  writer: plan.spawnPlanner (phase 1)
 * @property {Object} [state]             writer: sense.threat / plan.missions (phase 1)
 *
 * @typedef {Object} KernelInfo
 * @property {boolean} burstPending       writer: kernel — a burst job is waiting for bucket
 * @property {number} softLimit           writer: kernel — this tick's CPU target
 *
 * @typedef {Object} TickContext
 * @property {number} time
 * @property {string} shard
 * @property {{limit: number, bucket: number, tickLimit: number}} cpu
 * @property {import('../config').Config} config
 * @property {Record<string, RoomCtx>} rooms
 * @property {RoomCtx[]} roomList         tracked rooms, sorted by name for determinism
 * @property {KernelInfo} kernel
 */

module.exports = {};
