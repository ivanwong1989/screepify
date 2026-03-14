/**
 * Purpose: execute shared worker behavior for active missions.
 * Responsibilities: fetch energy when empty and perform mission-specific work.
 * Persistent state touched: creep.memory.missionId, creep.memory.working, creep.memory.energyTargetId, creep.memory.workTargetId.
 * Heap state: reads room query cache via heap_roomCache.
 */

const roomCache = require('heap_roomCache');

function getObject(id) {
  if (!id) return null;
  return Game.getObjectById(id);
}

function isEnergySink(structure) {
  if (!structure) return false;
  if (structure.structureType !== STRUCTURE_SPAWN && structure.structureType !== STRUCTURE_EXTENSION) return false;
  return structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
}

function closestByPathFromIds(creep, ids, validator) {
  const objects = roomCache.getObjectsByIds(ids);
  const candidates = validator ? objects.filter(validator) : objects;
  if (candidates.length === 0) return null;
  return creep.pos.findClosestByPath(candidates);
}

function findEnergyTarget(creep) {
  const room = creep.room;

  const storeIds = roomCache.getCachedIds(room, 'energyStores', 0, function buildStores(r) {
    return r.find(FIND_STRUCTURES, {
      filter: function filterStore(s) {
        return (
          (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
          s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
        );
      },
    });
  });
  const storeTarget = closestByPathFromIds(creep, storeIds, function validStore(s) {
    return s.store && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
  });
  if (storeTarget) return storeTarget;

  const droppedIds = roomCache.getCachedIds(room, 'droppedEnergy', 0, function buildDropped(r) {
    return r.find(FIND_DROPPED_RESOURCES, {
      filter: function filterDropped(res) {
        return res.resourceType === RESOURCE_ENERGY && res.amount >= 30;
      },
    });
  });
  const droppedTarget = closestByPathFromIds(creep, droppedIds, function validDrop(res) {
    return res.amount > 0;
  });
  if (droppedTarget) return droppedTarget;

  const sourceIds = roomCache.getCachedIds(room, 'activeSources', 0, function buildSources(r) {
    return r.find(FIND_SOURCES_ACTIVE);
  });
  return closestByPathFromIds(creep, sourceIds, null);
}

function fetchEnergy(creep) {
  let target = getObject(creep.memory.energyTargetId);

  if (target && target.store && target.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) target = null;
  if (target && target.resourceType && target.amount <= 0) target = null;

  if (!target) {
    target = findEnergyTarget(creep);
    creep.memory.energyTargetId = target ? target.id : null;
  }

  if (!target) return;

  if (target.store) {
    const result = creep.withdraw(target, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) creep.moveTo(target, { reusePath: 10 });
    if (result === OK || result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_INVALID_TARGET) {
      delete creep.memory.energyTargetId;
    }
    return;
  }

  if (target.resourceType) {
    const pickup = creep.pickup(target);
    if (pickup === ERR_NOT_IN_RANGE) creep.moveTo(target, { reusePath: 10 });
    if (pickup === OK || pickup === ERR_INVALID_TARGET) delete creep.memory.energyTargetId;
    return;
  }

  const harvest = creep.harvest(target);
  if (harvest === ERR_NOT_IN_RANGE) creep.moveTo(target, { reusePath: 10 });
}

function findRefillTarget(creep) {
  if (creep.memory.workTargetId) {
    const saved = getObject(creep.memory.workTargetId);
    if (isEnergySink(saved)) return saved;
  }

  const sinkIds = roomCache.getCachedIds(creep.room, 'refillSinks', 0, function buildSinks(room) {
    return room.find(FIND_MY_STRUCTURES, {
      filter: isEnergySink,
    });
  });

  const target = closestByPathFromIds(creep, sinkIds, isEnergySink);
  creep.memory.workTargetId = target ? target.id : null;
  return target;
}

function runRefill(creep) {
  const target = findRefillTarget(creep);
  if (!target) {
    delete creep.memory.workTargetId;
    return;
  }

  const result = creep.transfer(target, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) creep.moveTo(target, { reusePath: 10 });
  if (result === OK || result === ERR_FULL || result === ERR_INVALID_TARGET) {
    delete creep.memory.workTargetId;
  }
}

function runBuild(creep) {
  let site = getObject(creep.memory.workTargetId);
  if (!site) {
    const siteIds = roomCache.getCachedIds(creep.room, 'mySites', 0, function buildSites(room) {
      return room.find(FIND_MY_CONSTRUCTION_SITES);
    });
    site = closestByPathFromIds(creep, siteIds, null);
    creep.memory.workTargetId = site ? site.id : null;
  }

  if (!site) {
    delete creep.memory.workTargetId;
    return;
  }

  const result = creep.build(site);
  if (result === ERR_NOT_IN_RANGE) creep.moveTo(site, { reusePath: 10 });
  if (result === OK || result === ERR_INVALID_TARGET) {
    if (!Game.getObjectById(site.id)) delete creep.memory.workTargetId;
  }
}

function run(creep) {
  const missionId = creep.memory.missionId;
  const mission = missionId && Memory.missions ? Memory.missions[missionId] : null;

  if (!mission || mission.status !== 'active') {
    delete creep.memory.missionId;
    delete creep.memory.workTargetId;
    return;
  }

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = false;
  } else if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = true;
  }

  if (!creep.memory.working) {
    fetchEnergy(creep);
    return;
  }

  if (mission.type === 'refill') {
    runRefill(creep);
    return;
  }

  if (mission.type === 'build') {
    runBuild(creep);
    return;
  }

  delete creep.memory.workTargetId;
}

module.exports = { run };
