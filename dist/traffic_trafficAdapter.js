const trafficManager = require('traffic_screeps-traffic-manager');

function getRoomTrafficState(room) {
    if (!room) return null;

    if (!room.__trafficState || room.__trafficState.tick !== Game.time) {
        room.__trafficState = {
            tick: Game.time,
            managed: new Set(),
            blockerMovable: new Set(),
            strict: new Set()
        };
    }

    return room.__trafficState;
}

function beginRoom(room) {
    return getRoomTrafficState(room);
}

function enableForCreep(creep, opts) {
    if (!creep || !creep.room) return;
    const options = opts || {};
    const state = getRoomTrafficState(creep.room);
    if (!state) return;

    if (options.managed !== false) {
        state.managed.add(creep.name);
    }

    if (options.blockerMovable !== false) {
        state.blockerMovable.add(creep.name);
    }

    if (options.strict === true) {
        state.strict.add(creep.name);
    }
}

function registerMove(creep, target) {
    if (!creep || !target) return ERR_INVALID_ARGS;
    trafficManager.registerMove(creep, target);
    return OK;
}

function setWorkingArea(creep, pos, range) {
    if (!creep || !pos) return ERR_INVALID_ARGS;
    trafficManager.setWorkingArea(creep, pos, range);
    return OK;
}

function clearTrafficTemp(creep) {
    if (!creep) return;
    delete creep._trafficManaged;
    delete creep._trafficBlockerMovable;
    delete creep._intendedPackedCoord;
    delete creep._matchedPackedCoord;
    delete creep._possibleMoves;
    delete creep._canMove;
    delete creep._workingPos;
    delete creep._workingRange;
}

function finalizeRoom(room, costs) {
    if (!room) return;

    const state = room.__trafficState;
    if (!state || state.tick !== Game.time) {
        delete room.__trafficState;
        return;
    }

    const allCreepsInRoom = [...room.find(FIND_MY_CREEPS), ...room.find(FIND_MY_POWER_CREEPS)];
    if (allCreepsInRoom.length <= 0) {
        delete room.__trafficState;
        return;
    }

    const managedCount = state.managed.size;
    const blockerCount = state.blockerMovable.size;
    const posBefore = Object.create(null);

    for (let i = 0; i < allCreepsInRoom.length; i++) {
        const creep = allCreepsInRoom[i];
        posBefore[creep.name] = `${creep.pos.x},${creep.pos.y}`;
        creep._trafficManaged = state.managed.has(creep.name);
        creep._trafficBlockerMovable = state.blockerMovable.has(creep.name);
    }

    if (managedCount > 0) {
        trafficManager.run(room, costs);
    }

    let movedCount = 0;
    if (Memory.debugTraffic) {
        for (let i = 0; i < allCreepsInRoom.length; i++) {
            const creep = allCreepsInRoom[i];
            const before = posBefore[creep.name];
            const after = `${creep.pos.x},${creep.pos.y}`;
            if (before !== after) movedCount++;

            if (
                before !== after &&
                creep._trafficManaged === true &&
                creep.memory &&
                (creep.memory.role === 'worker' || creep.memory.role === 'builder' || creep.memory.role === 'repairer') &&
                !Number.isFinite(creep._intendedPackedCoord)
            ) {
                if (typeof debug === 'function') {
                    debug('traffic', `[TrafficBuild] displaced ${creep.name} ${room.name} ${before}->${after}`);
                }
            }
        }

        if (typeof debug === 'function') {
            debug(
                'traffic',
                `[TrafficFinalize] room=${room.name} managed=${managedCount} blockerMovable=${blockerCount} moved=${movedCount}`
            );
        }
    }

    for (let i = 0; i < allCreepsInRoom.length; i++) {
        clearTrafficTemp(allCreepsInRoom[i]);
    }

    delete room.__trafficState;
}

module.exports = {
    beginRoom,
    enableForCreep,
    registerMove,
    setWorkingArea,
    finalizeRoom
};
