const missionBoard = require('managers_overseer_missions_board_missionBoard');
const missionRuntime = require('managers_overseer_missions_board_missionRuntime');

const STATE_LOAD = 'LOAD';
const STATE_DELIVER = 'DELIVER';
const STATE_RETURN = 'RETURN';

function posKey(pos) {
    return pos ? `${pos.roomName}:${pos.x},${pos.y}` : '';
}

function getMissionForCreep(creep) {
    if (!creep || !creep.memory) return null;
    const missionId = creep.memory.coreLaneMissionId || creep.memory.missionId;
    if (!missionId) return null;
    const mission = missionBoard.getById(missionId);
    if (!mission || mission.type !== 'logisticsCoreV2') return null;
    return mission;
}

function getRuntimeForCreep(creep, mission) {
    if (!creep || !mission) return null;
    const runtime = missionRuntime.getMissionRuntime(mission);
    if (!runtime || !runtime.paths || !runtime.paths.core || !Array.isArray(runtime.paths.core.path) || runtime.paths.core.path.length <= 0) {
        return null;
    }
    return runtime;
}

function getLaneRuntime(runtime, key) {
    if (!runtime || !runtime.paths) return null;
    if (key && runtime.paths[key] && Array.isArray(runtime.paths[key].path) && runtime.paths[key].path.length > 0) {
        return runtime.paths[key];
    }
    return runtime.paths.core || null;
}

function getCurrentIndex(creep, lane) {
    if (!creep || !lane || !lane.indexByPos) return -1;
    const idx = lane.indexByPos[posKey(creep.pos)];
    return Number.isInteger(idx) ? idx : -1;
}

function moveToNearestPathTile(creep, lane) {
    if (!creep || !lane || !Array.isArray(lane.path)) return;
    let best = null;
    let bestRange = Infinity;
    for (let i = 0; i < lane.path.length; i++) {
        const tile = lane.path[i];
        if (!tile || tile.roomName !== creep.room.name) continue;
        const range = creep.pos.getRangeTo(tile);
        if (range < bestRange) {
            bestRange = range;
            best = tile;
        }
    }
    if (best) creep.moveTo(best, { range: 0, reusePath: 3 });
}

function getCoreLaneTrafficCache(missionId) {
    if (!missionId) return null;
    if (!global.__coreLaneTrafficCache || typeof global.__coreLaneTrafficCache !== 'object') {
        global.__coreLaneTrafficCache = { tick: -1, byMission: Object.create(null) };
    }
    const root = global.__coreLaneTrafficCache;
    if (root.tick !== Game.time) {
        root.tick = Game.time;
        root.byMission = Object.create(null);
    }
    if (root.byMission[missionId]) return root.byMission[missionId];

    const entry = {
        posToName: Object.create(null),
        byName: Object.create(null)
    };
    for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (!c || !c.my || !c.memory) continue;
        if (c.memory.missionType !== 'logisticsCoreV2') continue;
        const cid = c.memory.coreLaneMissionId || c.memory.missionId;
        if (cid !== missionId) continue;
        const key = posKey(c.pos);
        if (key) entry.posToName[key] = c.name;
        entry.byName[c.name] = c;
    }
    root.byMission[missionId] = entry;
    return entry;
}

function getRoadSpeedScore(creep) {
    if (!creep || !Array.isArray(creep.body)) return 0;
    const moveParts = creep.getActiveBodyparts(MOVE);
    let nonMove = 0;
    for (let i = 0; i < creep.body.length; i++) {
        const part = creep.body[i];
        if (!part || part.hits <= 0) continue;
        if (part.type !== MOVE) nonMove++;
    }
    return (moveParts * 2) - nonMove;
}

function getLanePriority(creep) {
    if (!creep || !creep.memory) return 0;
    const state = creep.memory.coreLaneState || '';
    const mode = creep.memory.coreLaneMode || '';
    if (state === STATE_DELIVER && mode === 'core') return 4;
    if (state === STATE_DELIVER && mode === 'labs') return 3;
    if (state === STATE_LOAD) return 2;
    if (state === STATE_RETURN) return 1;
    return 0;
}

function shouldYield(self, other) {
    if (!self || !other) return true;
    const selfPriority = getLanePriority(self);
    const otherPriority = getLanePriority(other);
    if (selfPriority !== otherPriority) return selfPriority < otherPriority;

    const selfSpeed = getRoadSpeedScore(self);
    const otherSpeed = getRoadSpeedScore(other);
    if (selfSpeed !== otherSpeed) return selfSpeed > otherSpeed;

    return self.name > other.name;
}

function getCreepIntentTargetIndex(creep, lane, runtime) {
    if (!creep || !creep.memory || !lane || !Array.isArray(lane.path)) return null;
    const state = creep.memory.coreLaneState || STATE_LOAD;
    const mode = creep.memory.coreLaneMode || 'core';
    const endIndex = Math.max(0, lane.path.length - 1);

    if (state === STATE_RETURN) return 0;
    if (state === STATE_DELIVER && mode === 'core') return endIndex;
    if (state === STATE_LOAD && mode === 'core') return 0;

    const jobId = creep.memory.coreLaneJobId || null;
    const job = jobId && runtime && runtime.laneJobsById ? runtime.laneJobsById[jobId] : null;
    if (!job) return state === STATE_DELIVER ? endIndex : 0;

    if (state === STATE_LOAD) {
        return Number.isInteger(job.sourceIndex) ? job.sourceIndex : 0;
    }
    if (state === STATE_DELIVER) {
        return Number.isInteger(job.targetIndex) ? job.targetIndex : endIndex;
    }
    return 0;
}

function trySwapWithHigherPriority(creep, blocker, lane, currentIndex, targetIndex, runtime) {
    if (!creep || !blocker || !lane || !Array.isArray(lane.path)) return false;
    if (creep.fatigue > 0 || blocker.fatigue > 0) return false;
    if (!creep.pos.isNearTo(blocker.pos)) return false;

    const blockerIndex = getCurrentIndex(blocker, lane);
    if (blockerIndex < 0) return false;
    const selfDir = targetIndex > currentIndex ? 1 : -1;
    const expectedBlockerIndex = currentIndex + selfDir;
    if (blockerIndex !== expectedBlockerIndex) return false;

    const blockerTargetIndex = getCreepIntentTargetIndex(blocker, lane, runtime);
    if (!Number.isInteger(blockerTargetIndex) || blockerTargetIndex === blockerIndex) return false;
    const blockerDir = blockerTargetIndex > blockerIndex ? 1 : -1;
    if (blockerDir !== -selfDir) return false;

    const blockerMove = blocker.move(blocker.pos.getDirectionTo(creep.pos));
    if (blockerMove !== OK) return false;
    const creepMove = creep.move(creep.pos.getDirectionTo(blocker.pos));
    if (creepMove !== OK) return false;
    return true;
}

function isWalkableYieldTile(creep, x, y, traffic) {
    if (!creep || x < 0 || x > 49 || y < 0 || y > 49) return false;
    const terrain = creep.room.getTerrain();
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;

    const key = `${creep.room.name}:${x},${y}`;
    if (traffic && traffic.posToName && traffic.posToName[key] && traffic.posToName[key] !== creep.name) return false;

    const structures = creep.room.lookForAt(LOOK_STRUCTURES, x, y);
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (!s) continue;
        if (s.structureType === STRUCTURE_ROAD) continue;
        if (s.structureType === STRUCTURE_CONTAINER) continue;
        if (s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic)) continue;
        return false;
    }
    const sites = creep.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
    for (let i = 0; i < sites.length; i++) {
        const site = sites[i];
        if (!site) continue;
        if (site.structureType === STRUCTURE_ROAD || site.structureType === STRUCTURE_CONTAINER) continue;
        return false;
    }
    return true;
}

function tryYieldMove(creep, lane, currentIndex, targetIndex, traffic) {
    if (!creep || !lane || !Array.isArray(lane.path)) return false;
    const path = lane.path;
    const reverseIndex = currentIndex < targetIndex ? currentIndex - 1 : currentIndex + 1;
    if (reverseIndex >= 0 && reverseIndex < path.length) {
        const backPos = path[reverseIndex];
        if (backPos && isWalkableYieldTile(creep, backPos.x, backPos.y, traffic)) {
            const occupied = traffic && traffic.posToName ? traffic.posToName[posKey(backPos)] : null;
            if (!occupied || occupied === creep.name) {
                creep.move(creep.pos.getDirectionTo(backPos));
                return true;
            }
        }
    }

    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = creep.pos.x + dx;
            const y = creep.pos.y + dy;
            if (!isWalkableYieldTile(creep, x, y, traffic)) continue;
            const candidate = new RoomPosition(x, y, creep.room.name);
            if (lane.indexByPos && Number.isInteger(lane.indexByPos[posKey(candidate)])) continue;
            creep.move(creep.pos.getDirectionTo(candidate));
            return true;
        }
    }
    return false;
}

function stepTowardIndex(creep, lane, targetIndex, missionId, runtime) {
    if (!creep || !lane || !Array.isArray(lane.path)) return;
    const path = lane.path;
    if (targetIndex < 0 || targetIndex >= path.length) return;

    const currentIndex = getCurrentIndex(creep, lane);
    if (currentIndex < 0) {
        moveToNearestPathTile(creep, lane);
        return;
    }

    if (currentIndex === targetIndex) return;
    const nextIndex = currentIndex < targetIndex ? currentIndex + 1 : currentIndex - 1;
    const nextPos = path[nextIndex];
    if (!nextPos) return;
    const traffic = getCoreLaneTrafficCache(missionId);
    const occupiedBy = traffic && traffic.posToName ? traffic.posToName[posKey(nextPos)] : null;
    if (occupiedBy && occupiedBy !== creep.name) {
        const blocker = traffic.byName ? traffic.byName[occupiedBy] : null;
        if (shouldYield(creep, blocker)) {
            if (trySwapWithHigherPriority(creep, blocker, lane, currentIndex, targetIndex, runtime)) return;
            tryYieldMove(creep, lane, currentIndex, targetIndex, traffic);
        }
        return;
    }
    creep.move(creep.pos.getDirectionTo(nextPos));
}

function getStoreAmount(obj, resourceType) {
    if (!obj || !resourceType) return 0;
    if (obj.store) return obj.store[resourceType] || 0;
    if (obj.resourceType === resourceType && Number.isFinite(obj.amount)) return obj.amount;
    return 0;
}

function getHeadSource(creep, mission, runtime) {
    if (!creep || !mission) return null;
    const headSourceId = (runtime && runtime.headSourceId) || (mission.meta && mission.meta.headSourceId) || null;
    const preferred = headSourceId ? Game.getObjectById(headSourceId) : null;
    if (preferred) return preferred;

    if (creep.room.storage) return creep.room.storage;
    const spawns = creep.room.find(FIND_MY_SPAWNS);
    return spawns && spawns.length > 0 ? spawns[0] : null;
}

function getPrimaryDumpTarget(creep, mission, runtime, resourceType) {
    if (!creep || !resourceType) return null;
    if (creep.room.storage && creep.room.storage.store && creep.room.storage.store.getFreeCapacity(resourceType) > 0) {
        return creep.room.storage;
    }
    if (creep.room.terminal && creep.room.terminal.store && creep.room.terminal.store.getFreeCapacity(resourceType) > 0) {
        return creep.room.terminal;
    }
    const head = getHeadSource(creep, mission, runtime);
    if (head && head.store && typeof head.store.getFreeCapacity === 'function' && head.store.getFreeCapacity(resourceType) > 0) {
        return head;
    }
    return null;
}

function dumpNonJobCargo(creep, mission, runtime, keepResourceType) {
    if (!creep) return false;
    for (const rt in creep.store) {
        if ((creep.store[rt] || 0) <= 0) continue;
        if (keepResourceType && rt === keepResourceType) continue;
        const target = getPrimaryDumpTarget(creep, mission, runtime, rt);
        if (!target) continue;
        if (!creep.pos.inRangeTo(target, 1)) {
            creep.moveTo(target, { range: 1, reusePath: 3 });
            return true;
        }
        creep.transfer(target, rt);
        return true;
    }
    return false;
}

function laneHasEnergyDemand(lane) {
    if (!lane || !lane.stopsByIndex) return false;
    for (const idxKey in lane.stopsByIndex) {
        const stopIds = lane.stopsByIndex[idxKey];
        if (!Array.isArray(stopIds) || stopIds.length <= 0) continue;
        for (let i = 0; i < stopIds.length; i++) {
            const target = Game.getObjectById(stopIds[i]);
            if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') continue;
            if (target.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return true;
        }
    }
    return false;
}

function indexHasEnergyDemand(lane, index) {
    if (!lane || !lane.stopsByIndex || !Number.isInteger(index)) return false;
    const stopIds = lane.stopsByIndex[index];
    if (!Array.isArray(stopIds) || stopIds.length <= 0) return false;
    for (let i = 0; i < stopIds.length; i++) {
        const target = Game.getObjectById(stopIds[i]);
        if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') continue;
        if (target.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return true;
    }
    return false;
}

function transferEnergyAtCurrentIndex(creep, lane) {
    if (!creep || !lane || !lane.stopsByIndex) return false;
    const idx = getCurrentIndex(creep, lane);
    if (idx < 0) return false;
    const stopIds = lane.stopsByIndex[idx];
    if (!Array.isArray(stopIds) || stopIds.length <= 0) return false;

    let best = null;
    let bestNeed = 0;
    for (let i = 0; i < stopIds.length; i++) {
        const target = Game.getObjectById(stopIds[i]);
        if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') continue;
        if (!creep.pos.inRangeTo(target, 1)) continue;
        const need = target.store.getFreeCapacity(RESOURCE_ENERGY);
        if (need > bestNeed) {
            bestNeed = need;
            best = target;
        }
    }

    if (!best) return false;
    return creep.transfer(best, RESOURCE_ENERGY) === OK;
}

function getLaneJobById(runtime, id) {
    if (!runtime || !id || !runtime.laneJobsById) return null;
    return runtime.laneJobsById[id] || null;
}

function getJobClaimStore(missionId) {
    if (!missionId) return null;
    if (!global.__coreLaneJobClaims || typeof global.__coreLaneJobClaims !== 'object') {
        global.__coreLaneJobClaims = { tick: -1, byMission: Object.create(null) };
    }
    const root = global.__coreLaneJobClaims;
    if (root.tick !== Game.time) {
        root.tick = Game.time;
        root.byMission = Object.create(null);
    }
    if (!root.byMission[missionId]) root.byMission[missionId] = Object.create(null);
    return root.byMission[missionId];
}

function claimJob(missionId, jobId, creepName) {
    const store = getJobClaimStore(missionId);
    if (!store || !jobId || !creepName) return;
    store[jobId] = creepName;
}

function isJobClaimedByOther(missionId, jobId, creepName) {
    const store = getJobClaimStore(missionId);
    if (!store || !jobId) return false;
    const holder = store[jobId];
    return !!(holder && holder !== creepName);
}

function isJobRunnable(job, carriedAmount) {
    if (!job || !job.resourceType) return false;
    const target = job.targetId ? Game.getObjectById(job.targetId) : null;
    if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') return false;
    if (target.store.getFreeCapacity(job.resourceType) <= 0) return false;

    const carried = Number.isFinite(carriedAmount) ? carriedAmount : 0;
    if (carried > 0) return true;

    const source = job.sourceId ? Game.getObjectById(job.sourceId) : null;
    if (!source) return false;
    return getStoreAmount(source, job.resourceType) > 0;
}

function pickLaneJob(runtime, creep, missionId) {
    if (!runtime || !Array.isArray(runtime.laneJobs) || runtime.laneJobs.length <= 0) return null;
    for (let i = 0; i < runtime.laneJobs.length; i++) {
        const job = runtime.laneJobs[i];
        if (!job) continue;
        if (isJobClaimedByOther(missionId, job.id, creep && creep.name)) continue;
        const carried = creep && creep.store ? (creep.store[job.resourceType] || 0) : 0;
        if (isJobRunnable(job, carried)) return job;
    }
    return null;
}

function clearJobMemory(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.coreLaneJobId;
    delete creep.memory.coreLaneMode;
    delete creep.memory.coreLaneResourceType;
}

function unassignCreep(creep) {
    if (!creep || !creep.memory) return;
    if (creep.memory.coreLanePrevRole) {
        creep.memory.role = creep.memory.coreLanePrevRole;
    }
    delete creep.memory.coreLaneMissionId;
    delete creep.memory.missionType;
    delete creep.memory.missionId;
    delete creep.memory.coreLaneState;
    delete creep.memory.coreLanePrevRole;
    clearJobMemory(creep);
}

module.exports = {
    run(creep) {
        if (!creep || !creep.my) return;
        const mission = getMissionForCreep(creep);
        if (!mission) {
            unassignCreep(creep);
            return;
        }

        const runtime = getRuntimeForCreep(creep, mission);
        const coreLane = runtime ? getLaneRuntime(runtime, 'core') : null;
        if (!runtime || !coreLane || !coreLane.headPos) {
            if (creep.room.name === mission.targetRoom && mission.meta && mission.meta.headSourceId) {
                const headSource = Game.getObjectById(mission.meta.headSourceId);
                if (headSource) creep.moveTo(headSource, { range: 1, reusePath: 3 });
            }
            return;
        }

        if (!creep.memory.coreLaneState) creep.memory.coreLaneState = STATE_LOAD;
        if (creep.store.getUsedCapacity() <= 0 && creep.memory.coreLaneState !== STATE_RETURN) {
            creep.memory.coreLaneState = STATE_LOAD;
        }

        const hasCoreDemand = laneHasEnergyDemand(coreLane);
        let activeJob = creep.memory.coreLaneJobId ? getLaneJobById(runtime, creep.memory.coreLaneJobId) : null;
        if (activeJob) {
            const carried = creep.store[activeJob.resourceType] || 0;
            if (!isJobRunnable(activeJob, carried)) {
                activeJob = null;
                clearJobMemory(creep);
            }
        }

        if (!activeJob) {
            activeJob = pickLaneJob(runtime, creep, mission.id);
            if (activeJob) {
                creep.memory.coreLaneJobId = activeJob.id;
                creep.memory.coreLaneResourceType = activeJob.resourceType;
            }
        }
        if (activeJob) claimJob(mission.id, activeJob.id, creep.name);

        if (creep.memory.coreLaneState === STATE_LOAD) {
            if (hasCoreDemand) {
                creep.memory.coreLaneMode = 'core';
                if (dumpNonJobCargo(creep, mission, runtime, RESOURCE_ENERGY)) return;
                if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                    creep.memory.coreLaneState = STATE_DELIVER;
                    return;
                }

                if (!creep.pos.inRangeTo(coreLane.headPos, 0)) {
                    stepTowardIndex(creep, coreLane, 0, mission.id, runtime);
                    return;
                }

                const source = getHeadSource(creep, mission, runtime);
                if (!source || !source.store) return;
                if (source.structureType === STRUCTURE_SPAWN && creep.room.storage) return;
                if (source.structureType === STRUCTURE_SPAWN) {
                    const available = source.store[RESOURCE_ENERGY] || 0;
                    if (available <= creep.store.getFreeCapacity(RESOURCE_ENERGY)) return;
                }

                creep.withdraw(source, RESOURCE_ENERGY);
                if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                    creep.memory.coreLaneState = STATE_DELIVER;
                }
                return;
            }

            if (!activeJob) {
                if (dumpNonJobCargo(creep, mission, runtime, null)) return;
                if (!creep.pos.inRangeTo(coreLane.headPos, 0)) {
                    stepTowardIndex(creep, coreLane, 0, mission.id, runtime);
                }
                return;
            }

            const resourceType = activeJob.resourceType;
            const lane = getLaneRuntime(runtime, activeJob.pathKey) || coreLane;
            creep.memory.coreLaneMode = 'labs';
            creep.memory.coreLaneResourceType = resourceType;

            if (dumpNonJobCargo(creep, mission, runtime, resourceType)) return;
            if ((creep.store[resourceType] || 0) > 0) {
                creep.memory.coreLaneState = STATE_DELIVER;
                return;
            }

            const source = Game.getObjectById(activeJob.sourceId);
            if (!source || !source.store || getStoreAmount(source, resourceType) <= 0) {
                clearJobMemory(creep);
                return;
            }

            if (!creep.pos.inRangeTo(source, 1)) {
                if (Number.isInteger(activeJob.sourceIndex) && activeJob.sourceIndex >= 0) {
                    stepTowardIndex(creep, lane, activeJob.sourceIndex, mission.id, runtime);
                    const idx = getCurrentIndex(creep, lane);
                    if (idx === activeJob.sourceIndex) {
                        creep.moveTo(source, { range: 1, reusePath: 3 });
                    }
                } else {
                    creep.moveTo(source, { range: 1, reusePath: 3 });
                }
                return;
            }

            creep.withdraw(source, resourceType);
            if ((creep.store[resourceType] || 0) > 0) {
                creep.memory.coreLaneState = STATE_DELIVER;
            }
            return;
        }

        if (creep.memory.coreLaneState === STATE_DELIVER) {
            if (creep.memory.coreLaneMode === 'core') {
                if (!hasCoreDemand || (creep.store[RESOURCE_ENERGY] || 0) <= 0) {
                    creep.memory.coreLaneState = STATE_RETURN;
                    return;
                }

                const idx = getCurrentIndex(creep, coreLane);
                const endIndex = coreLane.path.length - 1;
                if (idx < 0) {
                    moveToNearestPathTile(creep, coreLane);
                    return;
                }

                if (indexHasEnergyDemand(coreLane, idx) && (creep.store[RESOURCE_ENERGY] || 0) > 0) {
                    transferEnergyAtCurrentIndex(creep, coreLane);
                    return;
                }

                if (!laneHasEnergyDemand(coreLane)) {
                    creep.memory.coreLaneState = STATE_RETURN;
                    return;
                }

                if (idx >= endIndex) {
                    creep.memory.coreLaneState = STATE_RETURN;
                    return;
                }

                stepTowardIndex(creep, coreLane, endIndex, mission.id, runtime);
                return;
            }

            if (!activeJob) {
                creep.memory.coreLaneState = STATE_RETURN;
                return;
            }

            const resourceType = activeJob.resourceType;
            const lane = getLaneRuntime(runtime, activeJob.pathKey) || coreLane;
            const target = Game.getObjectById(activeJob.targetId);
            const carried = creep.store[resourceType] || 0;
            if (!target || !target.store || target.store.getFreeCapacity(resourceType) <= 0 || carried <= 0) {
                creep.memory.coreLaneState = STATE_RETURN;
                return;
            }

            if (!creep.pos.inRangeTo(target, 1)) {
                if (Number.isInteger(activeJob.targetIndex) && activeJob.targetIndex >= 0) {
                    stepTowardIndex(creep, lane, activeJob.targetIndex, mission.id, runtime);
                    const idx = getCurrentIndex(creep, lane);
                    if (idx === activeJob.targetIndex) {
                        creep.moveTo(target, { range: 1, reusePath: 3 });
                    }
                } else {
                    creep.moveTo(target, { range: 1, reusePath: 3 });
                }
                return;
            }

            creep.transfer(target, resourceType);
            if ((creep.store[resourceType] || 0) <= 0) {
                const stillRunnable = isJobRunnable(activeJob, 0);
                creep.memory.coreLaneState = stillRunnable ? STATE_LOAD : STATE_RETURN;
                if (!stillRunnable) clearJobMemory(creep);
            }
            return;
        }

        if (creep.memory.coreLaneState === STATE_RETURN) {
            const idx = getCurrentIndex(creep, coreLane);
            if (idx < 0) {
                moveToNearestPathTile(creep, coreLane);
                return;
            }

            if (idx > 0) {
                stepTowardIndex(creep, coreLane, 0, mission.id, runtime);
                return;
            }

            if (dumpNonJobCargo(creep, mission, runtime, null)) return;
            clearJobMemory(creep);
            creep.memory.coreLaneState = STATE_LOAD;
        }
    }
};
