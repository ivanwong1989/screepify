/**
 * Purpose: deterministic body builders for service and shared creeps.
 * Responsibilities: choose body layouts by room economy, policy mode, and current deficit.
 * Persistent state touched: none.
 * Heap state: none.
 */

function bodyCost(body) {
  return _.sum(body, function partCost(part) {
    return BODYPART_COST[part] || 0;
  });
}

function capBody(body, room) {
  const maxCost = room ? room.energyCapacityAvailable : 300;
  if (bodyCost(body) <= maxCost) return body;
  if (maxCost >= 300) return [WORK, CARRY, MOVE];
  return [MOVE, CARRY];
}

function chooseTier(maxTier, deficit, policy, options) {
  const opts = options || {};
  const roleType = opts.roleType || 'generic';
  let tier = maxTier;

  if (deficit >= 3) tier -= 2;
  else if (deficit >= 2) tier -= 1;

  if (policy && policy.econMode === 'bootstrap' && roleType !== 'miner') {
    tier -= 1;
  }

  return Math.max(1, Math.min(maxTier, tier));
}

function getMinerBodyByTier(tier) {
  if (tier >= 4) return [WORK, WORK, WORK, WORK, WORK, MOVE];
  if (tier === 3) return [WORK, WORK, WORK, WORK, MOVE];
  if (tier === 2) return [WORK, WORK, WORK, MOVE, MOVE];
  return [WORK, WORK, MOVE];
}

function getUpgraderBodyByTier(tier) {
  if (tier >= 4) return [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE];
  if (tier === 3) return [WORK, WORK, CARRY, CARRY, MOVE, MOVE];
  if (tier === 2) return [WORK, WORK, CARRY, MOVE, MOVE];
  return [WORK, CARRY, MOVE];
}

function getWorkerBodyByTier(tier) {
  if (tier >= 4) return [WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE];
  if (tier === 3) return [WORK, WORK, CARRY, CARRY, MOVE, MOVE];
  if (tier === 2) return [WORK, CARRY, CARRY, MOVE, MOVE];
  return [WORK, CARRY, MOVE];
}

function getMaxTierFromCapacity(capacity) {
  if (capacity >= 800) return 4;
  if (capacity >= 550) return 3;
  if (capacity >= 400) return 2;
  return 1;
}

function getBodyForService(serviceRecord, room, context) {
  if (!serviceRecord || !room) return [WORK, CARRY, MOVE];

  const meta = context || {};
  const deficit = meta.deficit || 1;
  const policy = meta.policy || null;
  const maxTier = getMaxTierFromCapacity(room.energyCapacityAvailable);

  if (serviceRecord.role === 'minerStatic') {
    const tier = chooseTier(maxTier, deficit, policy, { roleType: 'miner' });
    return capBody(getMinerBodyByTier(tier), room);
  }

  if (serviceRecord.role === 'upgraderStatic') {
    const tier = chooseTier(maxTier, deficit, policy, { roleType: 'upgrader' });
    return capBody(getUpgraderBodyByTier(tier), room);
  }

  return capBody([WORK, CARRY, MOVE], room);
}

function getBodyForSharedRole(roleName, room, context) {
  if (!room) return [WORK, CARRY, MOVE];

  const meta = context || {};
  const deficit = meta.deficit || 1;
  const policy = meta.policy || null;
  const maxTier = getMaxTierFromCapacity(room.energyCapacityAvailable);

  if (roleName === 'worker') {
    const tier = chooseTier(maxTier, deficit, policy, { roleType: 'worker' });
    return capBody(getWorkerBodyByTier(tier), room);
  }

  return capBody([WORK, CARRY, MOVE], room);
}

module.exports = {
  getBodyForService,
  getBodyForSharedRole,
};
