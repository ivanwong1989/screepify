/**
 * Purpose: assign shared workers to active missions with stickiness.
 * Responsibilities: keep valid assignments and only reassign when needed.
 * Persistent state touched: creep.memory.missionId and Memory.missions[*].assigned.
 * Heap state: none.
 */

const creepUtils = require('utils_creep');
const missionRegistry = require('missions_registry');

function cleanupAssignments() {
  const missions = missionRegistry.getAll();
  for (const missionId in missions) {
    if (!Object.prototype.hasOwnProperty.call(missions, missionId)) continue;
    const mission = missions[missionId];
    if (!Array.isArray(mission.assigned)) mission.assigned = [];
    mission.assigned = mission.assigned.filter(function filterDead(name) {
      return !!Game.creeps[name];
    });
  }
}

function findBestMission(roomName) {
  const active = missionRegistry.getActiveByRoom(roomName);
  active.sort(function byPriority(a, b) {
    return (b.priority || 0) - (a.priority || 0);
  });

  for (let i = 0; i < active.length; i++) {
    const mission = active[i];
    const assignedCount = Array.isArray(mission.assigned) ? mission.assigned.length : 0;
    if (assignedCount < (mission.desired || 0)) {
      return mission;
    }
  }

  return null;
}

function detachFromMission(creep, missionId) {
  if (!missionId) return;
  const mission = Memory.missions && Memory.missions[missionId] ? Memory.missions[missionId] : null;
  if (!mission || !Array.isArray(mission.assigned)) return;
  mission.assigned = mission.assigned.filter(function filterName(name) {
    return name !== creep.name;
  });
}

function attachToMission(creep, mission) {
  if (!mission) return;
  if (!Array.isArray(mission.assigned)) mission.assigned = [];
  if (mission.assigned.indexOf(creep.name) === -1) {
    mission.assigned.push(creep.name);
  }
  creep.memory.missionId = mission.id;
}

function run(context) {
  cleanupAssignments();

  const creeps = context && context.creeps ? context.creeps : Game.creeps;
  for (const creepName in creeps) {
    if (!Object.prototype.hasOwnProperty.call(creeps, creepName)) continue;
    const creep = creeps[creepName];
    if (!creepUtils.isSharedCreep(creep)) continue;

    const homeRoom = creep.memory.roomName || creep.room.name;
    const currentId = creep.memory.missionId;
    const currentMission = currentId && Memory.missions ? Memory.missions[currentId] : null;

    if (currentMission && currentMission.status === 'active' && currentMission.roomName === homeRoom) {
      attachToMission(creep, currentMission);
      continue;
    }

    detachFromMission(creep, currentId);
    delete creep.memory.missionId;

    const mission = findBestMission(homeRoom);
    if (mission) {
      attachToMission(creep, mission);
    }
  }
}

module.exports = { run };
