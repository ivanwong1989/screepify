/**
 * Purpose: maintain stable harvest services for each owned room source.
 * Responsibilities: discover sources once, upsert durable records, remove stale ones.
 * Persistent state touched: Memory.services harvest records.
 * Heap state: optional runtime source metadata cache (not required initially).
 */

const registry = require('services_registry');

function countOpenTiles(source) {
  const terrain = Game.map.getRoomTerrain(source.pos.roomName);
  let open = 0;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = source.pos.x + dx;
      const y = source.pos.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      if (terrain.get(x, y) !== TERRAIN_MASK_WALL) open++;
    }
  }

  return Math.max(1, open);
}

function getDesiredForSource(room, source) {
  const roomMemory = Memory.rooms && Memory.rooms[room.name] ? Memory.rooms[room.name] : null;
  const policy = roomMemory && roomMemory.policy ? roomMemory.policy : null;
  const workforce = policy && policy.workforce ? policy.workforce : null;

  const targetPerSource = workforce && workforce.harvestersPerSource ? workforce.harvestersPerSource : 1;

  const serviceId = 'harvest:' + room.name + ':' + source.id;
  const existing = Memory.services && Memory.services[serviceId] ? Memory.services[serviceId] : null;
  let openTiles = existing && existing.data ? existing.data.openTiles : null;

  if (typeof openTiles !== 'number' || openTiles < 1) {
    openTiles = countOpenTiles(source);
  }

  return {
    desired: Math.max(1, Math.min(targetPerSource, openTiles)),
    openTiles: openTiles,
  };
}

function run(room) {
  if (!room) return;

  const sources = room.find(FIND_SOURCES);
  const seen = {};

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const serviceId = 'harvest:' + room.name + ':' + source.id;
    const demand = getDesiredForSource(room, source);
    seen[serviceId] = true;

    registry.upsert({
      id: serviceId,
      type: 'harvest',
      roomName: room.name,
      anchorId: source.id,
      role: 'minerStatic',
      desired: demand.desired,
      mode: 'static',
      data: {
        sourceId: source.id,
        openTiles: demand.openTiles,
      },
    });
  }

  const roomServices = registry.getByRoom(room.name);
  for (let i = 0; i < roomServices.length; i++) {
    const record = roomServices[i];
    if (record.type !== 'harvest') continue;
    if (!seen[record.id]) {
      registry.remove(record.id);
    }
  }
}

module.exports = { run };
