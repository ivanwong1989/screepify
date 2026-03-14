/**
 * Purpose: maintain a shared-worker refill mission for spawn/extension energy.
 * Responsibilities: discover refill demand, upsert mission, remove when satisfied.
 * Persistent state touched: Memory.missions refill record.
 * Heap state: reads room query cache via heap_roomCache.
 */

const registry = require('missions_registry');
const roomCache = require('heap_roomCache');

function getRoomRefillCap(room) {
  const roomMemory = Memory.rooms && Memory.rooms[room.name] ? Memory.rooms[room.name] : null;
  const workforce = roomMemory && roomMemory.policy && roomMemory.policy.workforce ? roomMemory.policy.workforce : null;
  return workforce && workforce.refillMaxWorkers ? workforce.refillMaxWorkers : 2;
}

function getRefillTargets(room) {
  return roomCache.getCachedObjects(room, 'refillTargetsDiscovery', 0, function buildTargets(r) {
    return r.find(FIND_MY_STRUCTURES, {
      filter: function filterStructure(structure) {
        if (structure.structureType !== STRUCTURE_SPAWN && structure.structureType !== STRUCTURE_EXTENSION) {
          return false;
        }
        return structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      },
    });
  });
}

function run(room) {
  if (!room) return;

  const targets = getRefillTargets(room);
  const missionId = 'refill:' + room.name + ':main';
  if (targets.length === 0) {
    registry.remove(missionId);
    return;
  }

  const cap = getRoomRefillCap(room);
  const desired = Math.min(cap, Math.max(1, Math.ceil(targets.length / 3)));
  const targetIds = [];
  for (let i = 0; i < targets.length; i++) targetIds.push(targets[i].id);

  registry.upsert({
    id: missionId,
    type: 'refill',
    roomName: room.name,
    priority: 100,
    desired: desired,
    status: 'active',
    data: {
      targetIds: targetIds,
      missingCount: targets.length,
    },
  });
}

module.exports = { run };
