/**
 * Purpose: execute dedicated static miner behavior.
 * Responsibilities: resolve source and work position once, then harvest indefinitely.
 * Persistent state touched: creep.memory.serviceId and service.data.workPos.
 * Heap state: optional cached work position by service id.
 */

const positions = require('utils_positions');

function findWorkingPos(source) {
  const terrain = Game.map.getRoomTerrain(source.pos.roomName);

  const deltas = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];

  for (let i = 0; i < deltas.length; i++) {
    const x = source.pos.x + deltas[i][0];
    const y = source.pos.y + deltas[i][1];
    if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
      return new RoomPosition(x, y, source.pos.roomName);
    }
  }

  return source.pos;
}

function getSourceFromService(creep) {
  const serviceId = creep.memory.serviceId;
  if (!serviceId || !Memory.services || !Memory.services[serviceId]) return null;
  const service = Memory.services[serviceId];
  if (!service.data || !service.data.sourceId) return null;

  const source = Game.getObjectById(service.data.sourceId);
  if (!source) return null;

  if (!service.data.workPos) {
    const workPos = findWorkingPos(source);
    service.data.workPos = positions.serializePos(workPos);
  }

  return {
    source: source,
    service: service,
    workPos: positions.deserializePos(service.data.workPos),
  };
}

function run(creep) {
  const resolved = getSourceFromService(creep);
  if (!resolved) return;

  const workPos = resolved.workPos;
  if (workPos && !creep.pos.isEqualTo(workPos)) {
    creep.moveTo(workPos, { reusePath: 20, visualizePathStyle: { stroke: '#ffaa00' } });
    return;
  }

  const harvestResult = creep.harvest(resolved.source);
  if (harvestResult === ERR_NOT_IN_RANGE) {
    creep.moveTo(resolved.source, { reusePath: 20, visualizePathStyle: { stroke: '#ffaa00' } });
  }
}

module.exports = { run };
