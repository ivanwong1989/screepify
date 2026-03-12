function getOrderedWaypoints(mission) {
    const data = (mission && mission.data) || {};
    const names = Array.isArray(data.waypointFlagNames) ? data.waypointFlagNames : [];
    const out = [];
    for (let i = 0; i < names.length; i++) {
        const flag = Game.flags[names[i]];
        if (!flag) continue;
        out.push(flag.pos);
    }
    return out;
}

function getClaimTargetPos(mission) {
    const data = (mission && mission.data) || {};
    const flag = data.claimFlagName ? Game.flags[data.claimFlagName] : null;
    if (flag) return flag.pos;
    const p = data.claimPos;
    if (p && p.roomName) return new RoomPosition(p.x, p.y, p.roomName);
    return null;
}

function getState(creep) {
    if (!creep.memory.claimAttack) creep.memory.claimAttack = {};
    return creep.memory.claimAttack;
}

function moveToPos(creep, pos, range) {
    if (!creep || !pos) return;
    creep.moveTo(pos, {
        range: Number.isFinite(range) ? range : 0,
        reusePath: 15,
        maxOps: 6000
    });
}

module.exports = {
    execute: function(creep, mission) {
        if (!creep || !mission) return;

        const state = getState(creep);
        const waypoints = getOrderedWaypoints(mission);
        let waypointIndex = Number.isFinite(state.waypointIndex) ? state.waypointIndex : 0;

        while (waypointIndex < waypoints.length) {
            const wp = waypoints[waypointIndex];
            if (creep.pos.roomName === wp.roomName && creep.pos.inRangeTo(wp, 1)) {
                waypointIndex += 1;
                continue;
            }
            state.waypointIndex = waypointIndex;
            moveToPos(creep, wp, 1);
            return;
        }

        state.waypointIndex = waypoints.length;

        const claimPos = getClaimTargetPos(mission);
        const targetRoom = (mission.data && mission.data.targetRoom) || (claimPos && claimPos.roomName) || null;

        if (targetRoom && creep.room.name !== targetRoom) {
            if (claimPos) moveToPos(creep, claimPos, 1);
            else moveToPos(creep, new RoomPosition(25, 25, targetRoom), 20);
            return;
        }

        const controller = creep.room && creep.room.controller;
        if (!controller) return;

        if (!creep.pos.inRangeTo(controller, 1)) {
            moveToPos(creep, controller.pos, 1);
            return;
        }

        const myUser = creep.owner && creep.owner.username;
        const ownedByOther = !!(controller.owner && controller.owner.username !== myUser);
        const reservedByOther = !!(controller.reservation && controller.reservation.username !== myUser);

        if (ownedByOther || reservedByOther) {
            creep.attackController(controller);
            return;
        }

        if (!controller.my) {
            creep.claimController(controller);
        }
    }
};
