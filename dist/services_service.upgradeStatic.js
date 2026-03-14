/**
 * Purpose: maintain optional stable static upgrader service.
 * Responsibilities: create/remove single upgrader service from room policy.
 * Persistent state touched: Memory.services upgradeStatic records.
 * Heap state: none.
 */

const registry = require('services_registry');

function run(room) {
  if (!room || !room.controller) return;

  const roomMemory = Memory.rooms && Memory.rooms[room.name] ? Memory.rooms[room.name] : null;
  const policy = roomMemory && roomMemory.policy ? roomMemory.policy : null;

  const policyAllowsUpgrade = !!(policy && policy.upgrade && policy.upgrade.enabled);
  const bootstrapBlocked = !!(policy && policy.econMode === 'bootstrap');
  const enabled = policyAllowsUpgrade && !bootstrapBlocked;

  const serviceId = 'upgradeStatic:' + room.name + ':' + room.controller.id;

  if (!enabled) {
    registry.remove(serviceId);
    return;
  }

  registry.upsert({
    id: serviceId,
    type: 'upgradeStatic',
    roomName: room.name,
    anchorId: room.controller.id,
    role: 'upgraderStatic',
    desired: policy.upgrade.maxWorkers || 1,
    mode: 'static',
    data: {
      controllerId: room.controller.id,
    },
  });
}

module.exports = { run };
