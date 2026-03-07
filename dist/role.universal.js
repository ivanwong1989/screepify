const heap = require('utils_heap');

function getBorderDirection(pos) {
    if (!pos) return null;
    if (pos.x === 0) return FIND_EXIT_LEFT;
    if (pos.x === 49) return FIND_EXIT_RIGHT;
    if (pos.y === 0) return FIND_EXIT_TOP;
    if (pos.y === 49) return FIND_EXIT_BOTTOM;
    return null;
}

function getOffExitPosition(pos) {
    if (!pos) return null;
    let x = pos.x;
    let y = pos.y;
    if (x === 0) x = 1;
    else if (x === 49) x = 48;
    if (y === 0) y = 1;
    else if (y === 49) y = 48;
    if (x === pos.x && y === pos.y) return null;
    return new RoomPosition(x, y, pos.roomName);
}

function isNudgePositionOpen(room, x, y) {
    if (!room) return false;
    const terrain = room.getTerrain().get(x, y);
    if (terrain === TERRAIN_MASK_WALL) return false;
    const creeps = room.lookForAt(LOOK_CREEPS, x, y);
    if (creeps && creeps.length > 0) return false;
    return true;
}

function getNudgeCandidates(pos) {
    if (!pos) return [];
    const candidates = [];
    const seen = new Set();
    const add = (x, y) => {
        if (x < 1 || x > 48 || y < 1 || y > 48) return;
        const key = (x * 50) + y;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(new RoomPosition(x, y, pos.roomName));
    };

    if (pos.x === 0) {
        add(1, pos.y);
        add(1, pos.y - 1);
        add(1, pos.y + 1);
        add(2, pos.y);
        add(2, pos.y - 1);
        add(2, pos.y + 1);
    } else if (pos.x === 49) {
        add(48, pos.y);
        add(48, pos.y - 1);
        add(48, pos.y + 1);
        add(47, pos.y);
        add(47, pos.y - 1);
        add(47, pos.y + 1);
    }

    if (pos.y === 0) {
        add(pos.x, 1);
        add(pos.x - 1, 1);
        add(pos.x + 1, 1);
        add(pos.x, 2);
        add(pos.x - 1, 2);
        add(pos.x + 1, 2);
    } else if (pos.y === 49) {
        add(pos.x, 48);
        add(pos.x - 1, 48);
        add(pos.x + 1, 48);
        add(pos.x, 47);
        add(pos.x - 1, 47);
        add(pos.x + 1, 47);
    }

    return candidates;
}

function getNudgePosition(creep) {
    if (!creep) return null;
    const candidates = getNudgeCandidates(creep.pos);
    for (const pos of candidates) {
        if (isNudgePositionOpen(creep.room, pos.x, pos.y)) return pos;
    }
    return null;
}

function getHomeSpawnTarget(creep) {
    if (!creep || !creep.memory || !creep.memory.room) return null;
    const homeRoom = Game.rooms[creep.memory.room];
    if (!homeRoom) return null;
    let spawns;
    if (global.getRoomCache) {
        const cache = global.getRoomCache(homeRoom);
        spawns = cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_SPAWN];
    }
    if (!spawns || spawns.length === 0) {
        spawns = homeRoom.find(FIND_MY_SPAWNS);
    }
    if (!spawns || spawns.length === 0) return null;
    return spawns[0];
}

function moveToTarget(creep, target, range) {
    const moveRange = Number.isFinite(range) ? range : 1;
    const targetPos = target && target.pos ? target.pos : target;
    const borderDir = getBorderDirection(creep.pos);
    const nudgeRequired = borderDir && creep.memory && (creep.memory._borderNudge || creep.memory._justEnteredRoom === Game.time);

    if (nudgeRequired) {
        const nudgePos = getNudgePosition(creep);
        if (nudgePos) {
            creep.moveTo(nudgePos, { range: 0, reusePath: 0 });
            return;
        }
    }

    if (targetPos && targetPos.roomName && targetPos.roomName !== creep.room.name) {
        if (borderDir) {
            const exitDir = creep.room.findExitTo(targetPos.roomName);
            if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS && exitDir !== borderDir) {
                const nudgePos = getNudgePosition(creep);
                if (nudgePos) {
                    creep.moveTo(nudgePos, { range: 0, reusePath: 0 });
                    return;
                }
            }
        }
    }

    creep.moveTo(target, { range: moveRange, reusePath: 20 });
}

// ============================================================
// Lane move support (heap-only, reset-safe)
// ============================================================

function getHeapLane(homeRoomName, laneKey) {
    if (!homeRoomName || !laneKey) return null;

    // Heap is volatile; may be empty after VM reset. Treat as cache only.
    // Producer (mission.remote.haul) is responsible for rebuilding.
    let store;
    try {
        // utils/heap should exist at top-level utils folder.
        store = heap && heap.getStore ? heap.getStore('remoteHaul') : null;
    } catch (e) {
        store = null;
    }
    if (!store || !store.rooms) return null;

    const roomCache = store.rooms[homeRoomName];
    if (!roomCache || !roomCache.lanes) return null;

    const lane = roomCache.lanes[laneKey];
    if (!lane) return null;

    return lane;
}


function getOwnedLane(creep, laneKey, homeRoomName) {
    if (!laneKey || !homeRoomName) return null;

    // Heap is the source of truth for lanes.
    // If heap is empty (VM reset), lanes must be rebuilt by the mission layer.
    return getHeapLane(homeRoomName, laneKey);
}

function tryMoveByLane(creep, lane, destPos, range) {
    if (!creep || !lane) return false;

    const moveRange = Number.isFinite(range) ? range : 1;
    if (destPos && creep.pos.inRangeTo(destPos, moveRange)) return true;

    // Border nudge logic should keep priority (avoid being stuck on exits).
    if (getBorderDirection(creep.pos)) return false;

    let path = null;

    // Preferred: multi-room safe lane path (array of compact positions)
    if (Array.isArray(lane.p) && lane.p.length) {
        try {
            path = lane.p.map(pt => new RoomPosition(pt.x, pt.y, pt.r || pt.roomName));
        } catch (e) {
            path = null;
        }
    }

    // Back-compat: Room.serializePath string (single-room style)
    if (!path && lane.s) {
        try {
            path = Room.deserializePath(lane.s);
        } catch (e) {
            path = null;
        }
    }

    if (!path || !path.length) return false;

    // moveByPath() requires creep.pos to be in the path array.
    // We try three options:
    //  1) exact match (ideal)
    //  2) "snap" if we're adjacent to a path tile in the same room (common near borders/traffic)
    //  3) otherwise fall back to moveTo()
    let idx = -1;
    for (let i = 0; i < path.length; i++) {
        const p = path[i];
        if (p.roomName === creep.pos.roomName && p.x === creep.pos.x && p.y === creep.pos.y) {
            idx = i;
            break;
        }
    }

    let usePath = path;

    if (idx === -1) {
        // Try snapping to a nearby step in the same room.
        let snapIdx = -1;
        for (let i = 0; i < path.length; i++) {
            const p = path[i];
            if (p.roomName !== creep.pos.roomName) continue;
            const dx = Math.abs(p.x - creep.pos.x);
            const dy = Math.abs(p.y - creep.pos.y);
            if (dx <= 1 && dy <= 1) { snapIdx = i; break; }
        }
        if (snapIdx === -1) return false;

        // Build a small synthetic path that includes current pos first.
        // moveByPath() will move to the *next* entry after creep.pos.
        usePath = [creep.pos].concat(path.slice(snapIdx));
    }

    const code = creep.moveByPath(usePath);
    creep.memory._laneLastMoveByPathCode = code;

    // IMPORTANT: moveByPath can return OK even when the creep doesn't physically move (blocked or fatigued).
    // Treat OK / ERR_TIRED as "we handled movement" so callers don't trigger expensive fallback pathfinding.
    return code === OK || code === ERR_TIRED;
}

function getOpportunisticDesiredHits(room, st) {
    if (!st || !st.hitsMax) return 0;

    // For walls/ramparts, cap at mission policy target hits (NOT hitsMax)
    if (st.structureType === STRUCTURE_WALL || st.structureType === STRUCTURE_RAMPART) {
        const policy = room && room.memory && room.memory.overseer && room.memory.overseer.fortifyPolicy;
        const target = policy && Number.isFinite(policy.target) ? policy.target : 0;

        // If no policy, safest is to not opportunistic-fortify infinities
        if (target <= 0) return 0;

        return Math.min(target, st.hitsMax);
    }

    // Normal structures: desired is full hitsMax
    return st.hitsMax;
}

function tryOpportunisticRepair(creep, currentTask) {
    if (!creep || creep.spawning) return false;

    // Only if we have energy + energy is above 50% of carry capacity + WORK
    if (!creep.store || (creep.store[RESOURCE_ENERGY] <= 0.5*creep.store.getCapacity())) return false;
    if (creep.getActiveBodyparts(WORK) <= 0) return false;

    // Don't double-repair on a real repair task (let the mission do its job)
    const action = currentTask && currentTask.action;
    if (action === 'repair') return false;

    // Avoid combat roles
    const role = creep.memory && creep.memory.role;
    if (role && ['defender', 'brawler', 'drainer', 'assault'].includes(role)) return false;

    // Avoid during siege (keep workers focused / reduce noise)
    const room = creep.room;
    if (!room) return false;
    const combatState = room.memory && room.memory.admiral && room.memory.admiral.state;
    if (combatState === 'SIEGE') return false;

    // Throttle: at most once per tick (in case run() gets called twice)
    if (creep._oppRepairTick === Game.time) return false;
    creep._oppRepairTick = Game.time;

    // Pick nearby damaged structures
    // Prefer roomCache (avoids fresh room.find / findInRange scans).
    let candidates;
    if (room && global.getRoomCache) {
        const cache = global.getRoomCache(room);
        const structs = cache && cache.structures;
        if (structs && structs.length) {
            candidates = structs.filter((st) => {
                if (!st || !st.hitsMax) return false;

                // Only consider nearby (match old findInRange radius=3)
                if (!st.pos || st.pos.getRangeTo(creep.pos) > 3) return false;

                const desired = getOpportunisticDesiredHits(room, st);
                if (desired <= 0) return false;          // no policy for fortifications => skip
                if (st.hits >= desired) return false;    // already at/above desired cap

                // Skip if only tiny scratch (relative to desired cap)
                return st.hits < (desired * 0.95);
            });
        }
    }
    if (!candidates) {
        candidates = creep.pos.findInRange(FIND_STRUCTURES, 3, {
            filter: (st) => {
                if (!st || !st.hitsMax) return false;

                const desired = getOpportunisticDesiredHits(room, st);
                if (desired <= 0) return false;
                if (st.hits >= desired) return false;

                return st.hits < (desired * 0.85);
            }
        });
    }
    if (!candidates || candidates.length === 0) return false;

    candidates.sort((a, b) => {
        const da = getOpportunisticDesiredHits(room, a) || a.hitsMax;
        const db = getOpportunisticDesiredHits(room, b) || b.hitsMax;
        return (a.hits / da) - (b.hits / db);
    });

    const target = candidates[0];
    const res = creep.repair(target);
    return res === OK;
}


var roleUniversal = {
    /**
     * The universal role creep logic.
     * Reads 'task' from memory and executes it.
     * @param {Creep} creep
     */
    run: function(creep) {
        const lastRoom = creep.memory._lastRoom;
        if (lastRoom && lastRoom !== creep.room.name) {
            creep.memory._justEnteredRoom = Game.time;
            creep.memory._borderNudge = true;
        }
        creep.memory._lastRoom = creep.room.name;
        if (!getBorderDirection(creep.pos) && creep.memory._borderNudge) {
            delete creep.memory._borderNudge;
        }
        if (creep.memory._borderNudge && getBorderDirection(creep.pos)) {
            const nudgePos = getNudgePosition(creep);
            if (nudgePos) {
                creep.moveTo(nudgePos, { range: 0, reusePath: 0 });
                return;
            }
        }

        // --- Global Deployment Logic ---
        // If spawned remotely, travel to home room before doing anything else.
        if (creep.memory._travellingToHome) {
            if (creep.room.name === creep.memory.room) {
                delete creep.memory._travellingToHome;
            } else {
                const homeSpawn = getHomeSpawnTarget(creep);
                if (homeSpawn) {
                    moveToTarget(creep, homeSpawn, 2);
                } else if (Game.rooms[creep.memory.room] && Game.rooms[creep.memory.room].controller) {
                    moveToTarget(creep, Game.rooms[creep.memory.room].controller, 2);
                } else {
                    moveToTarget(creep, new RoomPosition(25, 25, creep.memory.room), 20);
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
            //tryOpportunisticRepair(creep, task);
            ;
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
                            const lane = getOwnedLane(creep, meta.laneKey, meta.homeRoom);
                            const moved = tryMoveByLane(creep, lane, targetPos, task.range);
                            const laneSig = `lane:${meta.laneKey}:${targetPos.roomName}:${moved ? 'ok' : 'fallback'}`;
                            if (creep.memory._laneLogSig !== laneSig) {
                                creep.memory._laneLogSig = laneSig;
                                debug(
                                    'mission.remote.haul',
                                    `[Lane] ${creep.name} key=${meta.laneKey} home=${meta.homeRoom} ` +
                                    `to=${targetPos.roomName} moved=${moved} code=${creep.memory._laneLastMoveByPathCode} lane=${lane ? 'hit' : 'miss'}`
                                );
                            }
                            if (!moved) {
                                moveToTarget(creep, targetPos, task.range);
                            }
                        } else {
                            moveToTarget(creep, targetPos, task.range);
                        }
                    }
                }
                break;
            case 'harvest':
                if (creep.harvest(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
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
                    moveToTarget(creep, target, task.range);
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
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'pickup':
                if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'upgrade':
                if (creep.upgradeController(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'build':
                if (creep.build(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'repair': {
                const res = creep.repair(target);
                if (res === ERR_NOT_IN_RANGE) {
                    // Still traveling to the real repair target — allow opportunistic repair en route.
                    //tryOpportunisticRepair(creep, task);
                    moveToTarget(creep, target, task.range);
                }
                break;
            }
            case 'dismantle':
                if (creep.dismantle(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'reserve':
                if (creep.reserveController(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'claim':
                if (creep.claimController(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'drop':
                creep.drop(task.resourceType);
                break;
        }
    }
};

module.exports = roleUniversal;
