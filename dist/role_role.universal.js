const borderNav = require('utils_creepBorderNav');
const laneMovement = require('utils_creepLaneMovement');
const opportunisticRepair = require('utils_creepOpportunisticRepair');
const heap = require('utils_heap');

function getLaneDebugState(creep) {
    if (!creep || !creep.name) return null;
    const store = heap.getStore('laneDebug');
    if (!store.creeps) store.creeps = Object.create(null);
    if (!store.creeps[creep.name]) store.creeps[creep.name] = Object.create(null);
    return store.creeps[creep.name];
}

var roleUniversal = {
    /**
     * The universal role creep logic.
     * Reads 'task' from memory and executes it.
     * @param {Creep} creep
     */
    run: function(creep) {
        if (creep.memory && creep.memory._laneLogSig) delete creep.memory._laneLogSig;
        if (creep.memory && creep.memory._laneLastMoveByPathCode !== undefined) delete creep.memory._laneLastMoveByPathCode;

        if (borderNav.handleBorderNudgeTick(creep)) return;

        // --- Global Deployment Logic ---
        // If spawned remotely, travel to home room before doing anything else.
        if (creep.memory._travellingToHome) {
            if (creep.room.name === creep.memory.room) {
                delete creep.memory._travellingToHome;
                if (creep.memory.spawnRoom) delete creep.memory.spawnRoom;
            } else {
                const homeSpawn = borderNav.getHomeSpawnTarget(creep);
                if (homeSpawn) {
                    borderNav.moveToTarget(creep, homeSpawn, 2);
                } else if (Game.rooms[creep.memory.room] && Game.rooms[creep.memory.room].controller) {
                    borderNav.moveToTarget(creep, Game.rooms[creep.memory.room].controller, 2);
                } else {
                    borderNav.moveToTarget(creep, new RoomPosition(25, 25, creep.memory.room), 20);
                }
                return;
            }
        }

        let task = creep.memory.task;

        if (!task) return;

        let target;
        // Targets can be ID or Names
        if (task.targetId) {
            target = Game.getObjectById(task.targetId);
        } else if (task.targetName) {
            target = Game.flags[task.targetName];
        } else if (task.targetPos) {
            const pos = task.targetPos;
            if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && pos.roomName) {
                target = new RoomPosition(pos.x, pos.y, pos.roomName);
            }
        } else if (task.moveTarget) {
            const pos = task.moveTarget;
            if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && pos.roomName) {
                target = new RoomPosition(pos.x, pos.y, pos.roomName);
            }
        }

        // If the target is no longer valid (despawned, destroyed), clear the task.
        if (!target && task.action !== 'drop') {
            delete creep.memory.task;
            return;
        }

        // Opportunistic micro-repair while traveling (does NOT stop movement)
        if (task.action !== 'repair' && task.action !== 'harvest') {
            opportunisticRepair.tryOpportunisticRepair(creep, task);
        }

        switch(task.action) {
            case 'move':
                if (target) {
                    const targetPos = target.pos ? target.pos : target;

                    if (!creep.pos.inRangeTo(targetPos, Number.isFinite(task.range) ? task.range : 1)) {
                        // NEW: lane-aware move (only when explicitly requested)
                        const meta = task.meta;
                        const wantLane = meta && meta.moveMode === 'lane' && meta.laneKey && meta.homeRoom;
                        if (wantLane) {
                            const lane = laneMovement.getOwnedLane(meta.laneKey, meta.homeRoom);
                            const moved = laneMovement.tryMoveByLane(creep, lane, targetPos, task.range);
                            const laneDebug = getLaneDebugState(creep);
                            const laneSig = `lane:${meta.laneKey}:${targetPos.roomName}:${moved ? 'ok' : 'fallback'}`;
                            if (!laneDebug || laneDebug.lastLogSig !== laneSig) {
                                if (laneDebug) laneDebug.lastLogSig = laneSig;
                                debug(
                                    'mission.remote.haul',
                                    `[Lane] ${creep.name} key=${meta.laneKey} home=${meta.homeRoom} ` +
                                    `to=${targetPos.roomName} moved=${moved} code=${laneDebug ? laneDebug.lastMoveByPathCode : undefined} lane=${lane ? 'hit' : 'miss'}`
                                );
                            }
                            // Only use normal target pathfinding when lane data is missing.
                            if (!moved && !lane) {
                                borderNav.moveToTarget(creep, targetPos, task.range);
                            }
                        } else {
                            borderNav.moveToTarget(creep, targetPos, task.range);
                        }
                    }
                }
                break;
            case 'harvest':
                if (creep.harvest(target) === ERR_NOT_IN_RANGE) {
                    borderNav.moveToTarget(creep, target, task.range);
                }
                break;
            case 'transfer': 
                var amount = null;
                if (task && task.amount !== undefined && task.amount !== null) {
                    amount = Number(task.amount);
                    if (!isFinite(amount) || amount <= 0) amount = null;
                    else amount = Math.floor(amount);
                }

                var res;
                if (amount !== null) res = creep.transfer(target, task.resourceType, amount);
                else res = creep.transfer(target, task.resourceType);

                if (res === ERR_NOT_IN_RANGE) {
                    borderNav.moveToTarget(creep, target, task.range);
                }
                break;
            case 'withdraw':
                var amount = null;
                if (task && task.amount !== undefined && task.amount !== null) {
                    amount = Number(task.amount);
                    if (!isFinite(amount) || amount <= 0) amount = null;
                    else amount = Math.floor(amount);
                }

                var res;
                if (amount !== null) res = creep.withdraw(target, task.resourceType, amount);
                else res = creep.withdraw(target, task.resourceType);

                if (res === ERR_NOT_IN_RANGE) {
                    borderNav.moveToTarget(creep, target, task.range);
                }
                break;
            case 'pickup':
                if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
                    borderNav.moveToTarget(creep, target, task.range);
                }
                break;
            case 'upgrade':
                if (creep.upgradeController(target) === ERR_NOT_IN_RANGE) {
                    borderNav.moveToTarget(creep, target, task.range);
                }
                break;
            case 'build':
                if (creep.build(target) === ERR_NOT_IN_RANGE) {
                    borderNav.moveToTarget(creep, target, task.range);
                }
                break;
            case 'repair': {
                const res = creep.repair(target);
                if (res === ERR_NOT_IN_RANGE) {
                    // Still traveling to the real repair target — allow opportunistic repair en route.
                    opportunisticRepair.tryOpportunisticRepair(creep, task);
                    borderNav.moveToTarget(creep, target, task.range);
                }
                break;
            }
            case 'dismantle':
                if (creep.dismantle(target) === ERR_NOT_IN_RANGE) {
                    borderNav.moveToTarget(creep, target, task.range);
                }
                break;
            case 'reserve':
                if (creep.reserveController(target) === ERR_NOT_IN_RANGE) {
                    borderNav.moveToTarget(creep, target, task.range);
                }
                break;
            case 'claim':
                if (creep.claimController(target) === ERR_NOT_IN_RANGE) {
                    borderNav.moveToTarget(creep, target, task.range);
                }
                break;
            case 'drop':
                creep.drop(task.resourceType);
                break;
        }
    }
};

module.exports = roleUniversal;
