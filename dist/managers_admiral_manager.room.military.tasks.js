const defenseTactics = require('managers_admiral_tactics_admiral.tactics.defense');
const assaultTactics = require('managers_admiral_tactics_admiral.tactics.assault');

const DRAIN_RETREAT_RATIO = 0.90;
const DRAIN_REENGAGE_RATIO = 0.95;
const DRAIN_TARGET_RANGE = 1;
const DRAIN_SAFE_RANGE = 2;

function getRemoteCreepsByHomeRoom() {
    const cache = global._remoteCreepsByHomeRoom;
    if (cache && cache.time === Game.time) return cache.byRoom;

    const byRoom = {};
    const creeps = Object.values(Game.creeps);
    for (const creep of creeps) {
        if (!creep || !creep.my) continue;
        const memory = creep.memory || {};
        const home = memory.room;
        if (!home) continue;
        if (creep.room && creep.room.name === home) continue;

        if (!byRoom[home]) {
            byRoom[home] = { assigned: [], idle: [] };
        }
        if (memory.missionName) byRoom[home].assigned.push(creep);
        else byRoom[home].idle.push(creep);
    }

    global._remoteCreepsByHomeRoom = { time: Game.time, byRoom };
    return byRoom;
}

function cleanupMissionAssignments(creeps, allMissions, roomName) {
    creeps.forEach(creep => {
        if (roomName && creep.memory && creep.memory.room && creep.memory.room !== roomName) return;
        if (creep.memory.missionName && !allMissions.find(m => m.name === creep.memory.missionName)) {
            delete creep.memory.missionName;
            delete creep.memory.task;
            delete creep.memory.taskState;
            delete creep.memory.drainState;
        }
    });
}

function normalizeTargetPos(pos, fallbackRoom) {
    if (!pos) return null;
    if (pos instanceof RoomPosition) return { x: pos.x, y: pos.y, roomName: pos.roomName };
    const roomName = pos.roomName || fallbackRoom;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!roomName || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, roomName };
}

function getRoomCenterPos(roomName) {
    if (!roomName) return null;
    return { x: 25, y: 25, roomName };
}

function getExitPosToward(creep, targetRoom) {
    if (!targetRoom || creep.room.name === targetRoom) return null;
    const exitDir = creep.room.findExitTo(targetRoom);
    if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return null;
    return creep.pos.findClosestByRange(exitDir);
}

function inRange(creep, pos, range) {
    if (!pos || creep.room.name !== pos.roomName) return false;
    return creep.pos.getRangeTo(pos.x, pos.y) <= range;
}

function executeDrain(creep, mission) {
    const data = mission.data || {};
    const targetPos = normalizeTargetPos(data.targetPos || mission.targetPos || mission.pos, data.targetRoom);
    const targetRoom = data.targetRoom || (targetPos && targetPos.roomName);
    const safeRoom = data.safeRoom || data.sponsorRoom || creep.memory.room;
    const retreatAt = Number.isFinite(data.retreatAt) ? data.retreatAt : DRAIN_RETREAT_RATIO;
    const reengageAt = Number.isFinite(data.reengageAt) ? data.reengageAt : DRAIN_REENGAGE_RATIO;
    const targetRange = Number.isFinite(data.targetRange) ? data.targetRange : DRAIN_TARGET_RANGE;

    let state = creep.memory.drainState || 'drain';
    if (state !== 'recover' && creep.hits <= creep.hitsMax * retreatAt) {
        state = 'recover';
    }
    if (state === 'recover') {
        if (creep.room.name !== targetRoom && creep.hits >= creep.hitsMax * reengageAt) {
            state = 'drain';
        }
    }
    creep.memory.drainState = state;

    let moveTarget = null;
    let range = targetRange;

    if (state === 'drain') {
        if (targetPos) {
            if (!inRange(creep, targetPos, targetRange)) {
                moveTarget = targetPos;
            }
        } else if (targetRoom) {
            moveTarget = getRoomCenterPos(targetRoom);
            range = DRAIN_TARGET_RANGE;
        }
    } else {
        if (targetRoom && creep.room.name === targetRoom) {
            const exitPos = getExitPosToward(creep, safeRoom || targetRoom);
            if (exitPos) {
                moveTarget = exitPos;
                range = 0;
            }
        } else if (targetRoom) {
            const edgePos = getExitPosToward(creep, targetRoom);
            if (edgePos) {
                moveTarget = edgePos;
                range = DRAIN_SAFE_RANGE;
            }
        }
    }

    const actions = [];
    if (creep.getActiveBodyparts(HEAL) > 0) {
        actions.push({ action: 'heal', targetId: creep.id });
    }

    creep.memory.task = {
        actions,
        moveTarget: moveTarget ? { x: moveTarget.x, y: moveTarget.y, roomName: moveTarget.roomName } : null,
        range: range
    };
}

/**
 * Enhanced Military Tasker for Admiral Missions
 */
var militaryTasks = {
    run: function(room) {
        const allMissions = room._missions || [];
        const cache = global.getRoomCache(room);
        const localCreeps = cache.myCreeps || [];
        const remoteByHome = getRemoteCreepsByHomeRoom();
        const remote = remoteByHome[room.name] || { assigned: [], idle: [] };
        const creeps = localCreeps.concat(remote.assigned || [], remote.idle || []);

        const missions = allMissions.filter(m => m.type === 'defend' || m.type === 'patrol');
        const assaultMissions = allMissions.filter(m => m.type === 'assault');
        const drainMissions = allMissions.filter(m => m.type === 'drain');
        const defenders = creeps.filter(c => c.memory.role === 'defender' || c.memory.role === 'brawler');
        const assaulters = creeps.filter(c => c.memory.role === 'assault');
        const drainers = creeps.filter(c => c.memory.role === 'drainer');

        const hostiles = cache.hostiles || [];

        // Cleanup invalid missions
        defenseTactics.cleanupMissions(defenders, allMissions);
        cleanupMissionAssignments(assaulters, allMissions, room.name);
        cleanupMissionAssignments(drainers, allMissions, room.name);

        missions.forEach(mission => {
            let assigned = defenders.filter(c => c.memory.missionName === mission.name);

            // 1. Assignment Logic
            const needed = (mission.requirements.count || 0) - assigned.length;
            if (needed > 0) {
                // Allow reassignment from patrol to defend
                const idleDefenders = defenders.filter(c =>
                    (!c.memory.missionName ||
                     c.memory.missionName.includes('decongest') ||
                     (mission.type === 'defend' && c.memory.missionName.includes('patrol')))
                    && !c.spawning
                );
                for (let i = 0; i < needed && i < idleDefenders.length; i++) {
                    const idle = idleDefenders[i];
                    idle.memory.missionName = mission.name;
                    idle.say('def');
                    assigned.push(idle);
                }
            }

            if (mission.census) mission.census.count = assigned.length;

            // 2. Tactical Execution
            if (mission.type === 'defend') {
                const primaryTarget = defenseTactics.selectPrimaryTarget(hostiles);
                assigned.forEach(creep => {
                    if (!creep.spawning) {
                        defenseTactics.executeTactics(creep, hostiles, assigned, room, primaryTarget);
                    }
                });
            } else if (mission.type === 'patrol') {
                assigned.forEach(creep => {
                    if (!creep.spawning) {
                        defenseTactics.executePatrol(creep, assigned, room);
                    }
                });
            }
        });

        assaultMissions.forEach(mission => {
            let assigned = assaulters.filter(c => c.memory.missionName === mission.name);
            const needed = (mission.requirements.count || 0) - assigned.length;
            if (needed > 0) {
                const idleAssaulters = assaulters.filter(c => !c.memory.missionName && !c.spawning);
                for (let i = 0; i < needed && i < idleAssaulters.length; i++) {
                    const idle = idleAssaulters[i];
                    idle.memory.missionName = mission.name;
                    assigned.push(idle);
                }
            }

            if (mission.census) mission.census.count = assigned.length;

            assigned.forEach(creep => {
                if (!creep.spawning) assaultTactics.executeAssault(creep, mission);
            });
        });

        drainMissions.forEach(mission => {
            let assigned = drainers.filter(c => c.memory.missionName === mission.name);
            const needed = (mission.requirements.count || 0) - assigned.length;
            if (needed > 0) {
                const idleDrainers = drainers.filter(c => !c.memory.missionName && !c.spawning);
                for (let i = 0; i < needed && i < idleDrainers.length; i++) {
                    const idle = idleDrainers[i];
                    idle.memory.missionName = mission.name;
                    delete idle.memory.task;
                    delete idle.memory.taskState;
                    idle.memory.drainState = 'drain';
                    assigned.push(idle);
                }
            }

            if (mission.census) mission.census.count = assigned.length;

            assigned.forEach(creep => {
                if (!creep.spawning) executeDrain(creep, mission);
            });
        });
    }
};

module.exports = militaryTasks;
