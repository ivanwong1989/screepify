/**
 * Purpose: dedicated static upgrader execution.
 * Responsibilities: safe conservative upgrader behavior.
 * Persistent state touched: creep.memory.serviceId.
 * Heap state: reads room query cache via heap_roomCache.
 */

const roomCache = require('heap_roomCache');

function closestByPathFromIds(creep, ids, validator) {
  const objects = roomCache.getObjectsByIds(ids);
  const candidates = validator ? objects.filter(validator) : objects;
  if (candidates.length === 0) return null;
  return creep.pos.findClosestByPath(candidates);
}

function findEnergySource(creep) {
  const room = creep.room;

  const structureIds = roomCache.getCachedIds(room, 'upgraderEnergyStores', 0, function buildStores(r) {
    return r.find(FIND_STRUCTURES, {
      filter: function filterSource(s) {
        return (
          (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
          s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
        );
      },
    });
  });
  const structure = closestByPathFromIds(creep, structureIds, function validStore(s) {
    return s.store && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
  });
  if (structure) return structure;

  const droppedIds = roomCache.getCachedIds(room, 'upgraderDroppedEnergy', 0, function buildDropped(r) {
    return r.find(FIND_DROPPED_RESOURCES, {
      filter: function filterDropped(res) {
        return res.resourceType === RESOURCE_ENERGY && res.amount >= 30;
      },
    });
  });
  const dropped = closestByPathFromIds(creep, droppedIds, function validDrop(res) {
    return res.amount > 0;
  });
  if (dropped) return dropped;

  const sourceIds = roomCache.getCachedIds(room, 'upgraderActiveSources', 0, function buildSources(r) {
    return r.find(FIND_SOURCES_ACTIVE);
  });
  return closestByPathFromIds(creep, sourceIds, null);
}

function run(creep) {
  if (!creep.room || !creep.room.controller) return;

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    const source = findEnergySource(creep);
    if (!source) return;

    if (source.store) {
      const withdraw = creep.withdraw(source, RESOURCE_ENERGY);
      if (withdraw === ERR_NOT_IN_RANGE) creep.moveTo(source, { reusePath: 10 });
      return;
    }

    if (source.resourceType) {
      const pickup = creep.pickup(source);
      if (pickup === ERR_NOT_IN_RANGE) creep.moveTo(source, { reusePath: 10 });
      return;
    }

    const harvest = creep.harvest(source);
    if (harvest === ERR_NOT_IN_RANGE) creep.moveTo(source, { reusePath: 10 });
    return;
  }

  const result = creep.upgradeController(creep.room.controller);
  if (result === ERR_NOT_IN_RANGE) creep.moveTo(creep.room.controller, { reusePath: 10 });
}

module.exports = { run };
