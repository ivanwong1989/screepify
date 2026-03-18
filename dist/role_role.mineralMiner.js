const borderNav = require('utils_creepBorderNav');
const roleUniversal = require('role_role.universal');

function clearMineralAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
}

function getMissionByName(homeRoom, missionName) {
    if (!homeRoom || !missionName) return null;
    if (homeRoom._mineralMissionMapTick !== Game.time || !homeRoom._mineralMissionMap) {
        const map = Object.create(null);
        const missions = Array.isArray(homeRoom._missions) ? homeRoom._missions : [];
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.name) continue;
            map[mission.name] = mission;
        }
        homeRoom._mineralMissionMap = map;
        homeRoom._mineralMissionMapTick = Game.time;
    }
    return homeRoom._mineralMissionMap[missionName] || null;
}

function transferOrMove(creep, target, resourceType, range) {
    if (!creep || !target) return;
    const code = creep.transfer(target, resourceType);
    if (code === ERR_NOT_IN_RANGE) {
        borderNav.moveToTarget(creep, target, Number.isFinite(range) ? range : 1);
    }
}

const roleMineralMiner = {
    run: function(creep) {
        if (!creep || !creep.memory) return;

        if (creep.memory._travellingToHome) {
            roleUniversal.run(creep);
            return;
        }

        const missionName = creep.memory.missionName;
        if (!missionName) {
            roleUniversal.run(creep);
            return;
        }

        const homeRoomName = creep.memory.room || (creep.room && creep.room.name);
        const homeRoom = homeRoomName ? Game.rooms[homeRoomName] : null;
        const mission = getMissionByName(homeRoom, missionName);
        if (!mission) {
            clearMineralAssignment(creep);
            return;
        }

        if (mission.type !== 'mineral') {
            roleUniversal.run(creep);
            return;
        }

        delete creep.memory.task;
        delete creep.memory.taskState;

        const mineralId = mission.mineralId || mission.targetId;
        const mineral = mineralId ? Game.getObjectById(mineralId) : null;
        if (!mineral || (mineral.mineralAmount || 0) <= 0) {
            clearMineralAssignment(creep);
            return;
        }

        const missionData = mission.data || {};
        if (missionData.extractorId) {
            const extractor = Game.getObjectById(missionData.extractorId);
            if (!extractor) {
                clearMineralAssignment(creep);
                return;
            }
        }

        const resourceType = missionData.resourceType || mineral.mineralType;
        const container = missionData.containerId ? Game.getObjectById(missionData.containerId) : null;
        const terminal = creep.room && creep.room.terminal ? creep.room.terminal : null;
        const storage = creep.room && creep.room.storage ? creep.room.storage : null;

        const carriedTypes = Object.keys(creep.store).filter(type => (creep.store[type] || 0) > 0);
        if (carriedTypes.length > 0) {
            const depositType = carriedTypes.includes(resourceType) ? resourceType : carriedTypes[0];
            const terminalHasSpace = terminal && terminal.store && (terminal.store.getFreeCapacity(depositType) || 0) > 0;
            const storageHasSpace = storage && storage.store && (storage.store.getFreeCapacity(depositType) || 0) > 0;
            const containerHasSpace = container && container.store && (container.store.getFreeCapacity(depositType) || 0) > 0;
            const depositTarget = terminalHasSpace
                ? terminal
                : (storageHasSpace ? storage : (containerHasSpace ? container : null));

            if (depositTarget === container && creep.pos.inRangeTo(container.pos, 1)) {
                transferOrMove(creep, container, depositType, 1);
                return;
            }

            if (creep.store.getFreeCapacity() === 0) {
                if (depositTarget) {
                    if (depositTarget === container) {
                        if (creep.pos.inRangeTo(container.pos, 1)) {
                            transferOrMove(creep, container, depositType, 1);
                        } else {
                            borderNav.moveToTarget(creep, container, 0);
                        }
                        return;
                    }

                    transferOrMove(creep, depositTarget, depositType, 1);
                    return;
                }

                creep.drop(depositType);
                return;
            }
        }

        if (container && !creep.pos.isEqualTo(container.pos)) {
            const creepsOnContainer = container.pos.lookFor(LOOK_CREEPS) || [];
            if (creepsOnContainer.length === 0) {
                borderNav.moveToTarget(creep, container, 0);
                return;
            }
        }

        const harvestCode = creep.harvest(mineral);
        if (harvestCode === ERR_NOT_IN_RANGE) {
            borderNav.moveToTarget(creep, mineral, 1);
        }
    }
};

module.exports = roleMineralMiner;
