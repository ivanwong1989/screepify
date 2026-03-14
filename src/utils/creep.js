/**
 * Purpose: creep classification and naming helpers.
 * Responsibilities: detect service/shared creeps and parse standardized names.
 * Persistent state touched: none.
 * Heap state: none.
 */

function parseCreepName(name) {
  if (!name || typeof name !== 'string') return null;
  const parts = name.split('_');
  if (parts.length < 3) return null;

  return {
    role: parts[0],
    roomName: parts[1],
    anchorOrMission: parts[2],
    token: parts.length > 3 ? parts.slice(3).join('_') : '',
  };
}

function isServiceCreep(creep) {
  if (!creep || !creep.memory) return false;
  return !!creep.memory.serviceId;
}

function isSharedCreep(creep) {
  if (!creep || !creep.memory) return false;
  return creep.memory.role === 'worker' && !creep.memory.serviceId;
}

module.exports = {
  parseCreepName,
  isServiceCreep,
  isSharedCreep,
};
