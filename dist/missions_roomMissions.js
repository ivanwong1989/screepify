/**
 * Purpose: execute all mission discovery/validation modules for one room.
 * Responsibilities: run refill and build mission modules in deterministic order.
 * Persistent state touched: Memory.missions via called modules.
 * Heap state: none.
 */

const refillMission = require('missions_mission.refill');
const buildMission = require('missions_mission.build');

function runRoom(room, context) {
  refillMission.run(room, context);
  buildMission.run(room, context);
}

module.exports = { runRoom };
