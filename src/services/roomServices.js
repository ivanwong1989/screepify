/**
 * Purpose: execute all service discovery/validation modules for one room.
 * Responsibilities: call stable service modules with deterministic order.
 * Persistent state touched: Memory.services via called modules.
 * Heap state: none.
 */

const harvestService = require('services_service.harvest');
const upgradeStaticService = require('services_service.upgradeStatic');

function runRoom(room, context) {
  harvestService.run(room, context);
  upgradeStaticService.run(room, context);
}

module.exports = { runRoom };
