/**
 * Purpose: compute one room policy from room state and empire intent.
 * Responsibilities: return operating rules only; no missions or spawn actions.
 * Persistent state touched: none directly.
 * Heap state: none.
 */

function build(room) {
  const rcl = room && room.controller ? room.controller.level : 0;
  const energyCapacity = room ? room.energyCapacityAvailable : 0;
  const econMode = energyCapacity < 550 ? 'bootstrap' : 'normal';

  let harvestersPerSource = 1;
  if (rcl <= 2) harvestersPerSource = 2;

  let upgraderMax = 1;
  if (rcl >= 3) upgraderMax = 2;
  if (rcl >= 6) upgraderMax = 3;

  let refillMax = 2;
  if (rcl >= 3) refillMax = 3;
  if (rcl >= 5) refillMax = 4;

  let buildMax = 2;
  if (rcl >= 4) buildMax = 3;
  if (rcl >= 6) buildMax = 4;

  return {
    econMode: econMode,
    upgrade: {
      enabled: rcl > 0,
      staticSpots: true,
      maxWorkers: upgraderMax,
    },
    remotes: {
      enabled: false,
      maxRooms: 0,
    },
    logistics: {
      dedicatedHaulers: rcl >= 3,
    },
    workforce: {
      harvestersPerSource: harvestersPerSource,
      refillMaxWorkers: refillMax,
      buildMaxWorkers: buildMax,
      sharedWorkerCap: rcl <= 2 ? 4 : 8,
    },
    defense: {
      mode: 'normal',
    },
  };
}

module.exports = { build };
