/**
 * Purpose: convert service and mission demand into spawn actions.
 * Responsibilities: prioritize essential service creeps and then shared workers.
 * Persistent state touched: creep memory on spawn, optional room spawnQueue.
 * Heap state: none.
 */

const serviceRegistry = require('services_registry');
const missionRegistry = require('missions_registry');
const bodies = require('spawning_bodies');
const names = require('spawning_names');

const ROLE_SPAWN_PRIORITY = {
  minerStatic: 100,
  haulerDedicated: 90,
  worker: 80,
  upgraderStatic: 50,
};

function canSpawn(spawn) {
  return spawn && !spawn.spawning;
}

function getRoomPolicy(roomName) {
  const roomMemory = Memory.rooms && Memory.rooms[roomName] ? Memory.rooms[roomName] : null;
  return roomMemory && roomMemory.policy ? roomMemory.policy : null;
}

function countServiceCreeps(serviceId, creeps) {
  let count = 0;
  for (const name in creeps) {
    if (!Object.prototype.hasOwnProperty.call(creeps, name)) continue;
    const creep = creeps[name];
    if (creep.memory && creep.memory.serviceId === serviceId) count++;
  }
  return count;
}

function countSharedWorkers(roomName, creeps) {
  let count = 0;
  for (const name in creeps) {
    if (!Object.prototype.hasOwnProperty.call(creeps, name)) continue;
    const creep = creeps[name];
    if (creep.memory && creep.memory.role === 'worker' && creep.memory.roomName === roomName) count++;
  }
  return count;
}

function sortServicesByNeed(services, creeps) {
  return services
    .map(function withDeficit(service) {
      const alive = countServiceCreeps(service.id, creeps);
      const desired = service.desired || 0;
      const need = desired - alive;
      return {
        service: service,
        alive: alive,
        desired: desired,
        need: need,
        priority: ROLE_SPAWN_PRIORITY[service.role] || 0,
      };
    })
    .filter(function onlyNeeding(entry) {
      return entry.need > 0;
    })
    .sort(function byPriorityThenNeed(a, b) {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.need - a.need;
    });
}

function trySpawnFromServiceEntries(spawn, room, entries, policy) {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const service = entry.service;

    const name = names.makeServiceName(service);
    const body = bodies.getBodyForService(service, room, {
      deficit: entry.need,
      desired: entry.desired,
      alive: entry.alive,
      policy: policy,
    });

    const result = spawn.spawnCreep(body, name, {
      memory: {
        role: service.role,
        serviceId: service.id,
        roomName: room.name,
      },
    });

    if (result === OK) return true;
    if (result === ERR_NOT_ENOUGH_ENERGY) return false;
  }

  return false;
}

function getSharedWorkerTarget(room) {
  const roomMemory = Memory.rooms && Memory.rooms[room.name] ? Memory.rooms[room.name] : null;
  const workforce = roomMemory && roomMemory.policy && roomMemory.policy.workforce ? roomMemory.policy.workforce : null;
  const cap = workforce && workforce.sharedWorkerCap ? workforce.sharedWorkerCap : 6;

  const missions = missionRegistry.getActiveByRoom(room.name);
  let desiredWorkers = 0;
  for (let i = 0; i < missions.length; i++) {
    desiredWorkers += missions[i].desired || 0;
  }

  return Math.min(cap, desiredWorkers);
}

function trySpawnWorker(spawn, room, creeps, policy) {
  const desiredWorkers = getSharedWorkerTarget(room);
  const existing = countSharedWorkers(room.name, creeps);
  const deficit = desiredWorkers - existing;
  if (deficit <= 0) return false;

  const name = names.makeSharedName('worker', room.name);
  const body = bodies.getBodyForSharedRole('worker', room, {
    deficit: deficit,
    desired: desiredWorkers,
    alive: existing,
    policy: policy,
  });

  const result = spawn.spawnCreep(body, name, {
    memory: {
      role: 'worker',
      roomName: room.name,
    },
  });

  return result === OK;
}

function run(context) {
  const rooms = context && Array.isArray(context.rooms) ? context.rooms : [];
  const creeps = context && context.creeps ? context.creeps : Game.creeps;

  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const policy = getRoomPolicy(room.name);
    const spawns = room.find(FIND_MY_SPAWNS);
    const services = serviceRegistry.getByRoom(room.name);
    const prioritized = sortServicesByNeed(services, creeps);

    const essential = prioritized.filter(function isEssential(entry) {
      return entry.priority >= ROLE_SPAWN_PRIORITY.worker;
    });
    const optional = prioritized.filter(function isOptional(entry) {
      return entry.priority < ROLE_SPAWN_PRIORITY.worker;
    });

    for (let s = 0; s < spawns.length; s++) {
      const spawn = spawns[s];
      if (!canSpawn(spawn)) continue;

      if (trySpawnFromServiceEntries(spawn, room, essential, policy)) continue;
      if (trySpawnWorker(spawn, room, creeps, policy)) continue;
      trySpawnFromServiceEntries(spawn, room, optional, policy);
    }
  }
}

module.exports = { run };
