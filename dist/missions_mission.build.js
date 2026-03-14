/**
 * Purpose: maintain a shared-worker build mission for room construction demand.
 * Responsibilities: group build work into one mission per room.
 * Persistent state touched: Memory.missions build record.
 * Heap state: none.
 */

const registry = require('missions_registry');

function getRoomBuildCap(room) {
  const roomMemory = Memory.rooms && Memory.rooms[room.name] ? Memory.rooms[room.name] : null;
  const workforce = roomMemory && roomMemory.policy && roomMemory.policy.workforce ? roomMemory.policy.workforce : null;
  return workforce && workforce.buildMaxWorkers ? workforce.buildMaxWorkers : 2;
}

function run(room) {
  if (!room) return;

  const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
  const missionId = 'build:' + room.name + ':main';

  if (sites.length === 0) {
    registry.remove(missionId);
    return;
  }

  const cap = getRoomBuildCap(room);
  const desired = Math.min(cap, Math.max(1, Math.ceil(sites.length / 4)));
  const siteIds = [];
  for (let i = 0; i < sites.length && i < 20; i++) siteIds.push(sites[i].id);

  registry.upsert({
    id: missionId,
    type: 'build',
    roomName: room.name,
    priority: 60,
    desired: desired,
    status: 'active',
    data: {
      siteIds: siteIds,
      count: sites.length,
    },
  });
}

module.exports = { run };
