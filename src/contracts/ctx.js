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
 * @property {import('../processes/sense/intel').RoomIntel} [intel]   writer: sense.intel
 * @property {import('../processes/sense/intel').RoomState} [state]   writer: sense.intel
 * @property {import('../processes/sense/census').Census} [census]    writer: sense.census
 *                                         (census.reserved is also updated by mission
 *                                          types when they hand out gather tasks)
 * @property {import('../processes/sense/policy').RoomPolicy} [policy]  writer: sense.policy
 * @property {import('../services/laneClaims').LaneClaims} [lanes]    writer: sense.lanes
 * @property {import('../services/requests').Requests} [requests]    writer: sense.logistics
 *                                         (services/matcher commits taken jobs into it)
 * @property {import('./mission').Mission[]} [missions]               writer: plan.missions
 * @property {Record<string, import('./mission').Mission>} [missionsById]  writer: plan.missions
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
