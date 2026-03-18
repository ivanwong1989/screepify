/**
 * Dedicated combat role for assault creeps.
 * Handles tactical movement and combat actions.
 *
 * DUO-SAFE BORDER POLICY:
 * - If planner is controlling this tick (movePlan.step.dir exists): do NOT nudge (planner owns borders).
 * - If planner is NOT controlling and creep is on an exit tile: DO nudge inward to prevent unintended edge-stay issues.
 * - Keep existing moveToTarget() nudge logic for generic / fallback moveTo travel.
 */

function getBorderDirection(pos) {
    if (!pos) return null;
    if (pos.x === 0) return FIND_EXIT_LEFT;
    if (pos.x === 49) return FIND_EXIT_RIGHT;
    if (pos.y === 0) return FIND_EXIT_TOP;
    if (pos.y === 49) return FIND_EXIT_BOTTOM;
    return null;
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
    if (!spawns || spawns.length === 0) spawns = homeRoom.find(FIND_MY_SPAWNS);
    if (!spawns || spawns.length === 0) return null;
    return spawns[0];
}

/**
 * Generic moveTo wrapper used by fallback logic / travelling-to-home / generic move tasks.
 * It contains its own nudge behavior to avoid edge drift when moveTo wants the wrong exit.
 */
function moveToTarget(creep, target, range, visualizePathStyle, extraOpts) {
    const moveRange = Number.isFinite(range) ? range : 1;
    const targetPos = target && target.pos ? target.pos : target;
    const borderDir = getBorderDirection(creep.pos);

    // If we're on border and recently entered / flagged for nudge, try to step inward.
    const nudgeRequired =
        borderDir &&
        creep.memory &&
        (creep.memory._borderNudge || creep.memory._justEnteredRoom === Game.time);

    if (nudgeRequired) {
        const nudgePos = getNudgePosition(creep);
        if (nudgePos) {
            const nudgeOpts = { range: 0, reusePath: 0 };
            if (visualizePathStyle) nudgeOpts.visualizePathStyle = visualizePathStyle;
            creep.moveTo(nudgePos, nudgeOpts);
            return;
        }
    }

    // If inter-room target and moveTo is trying to use the "wrong" exit edge, nudge inward first.
    if (targetPos && targetPos.roomName && targetPos.roomName !== creep.room.name) {
        if (borderDir) {
            const exitDir = creep.room.findExitTo(targetPos.roomName);
            if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS && exitDir !== borderDir) {
                const nudgePos = getNudgePosition(creep);
                if (nudgePos) {
                    const nudgeOpts = { range: 0, reusePath: 0 };
                    if (visualizePathStyle) nudgeOpts.visualizePathStyle = visualizePathStyle;
                    creep.moveTo(nudgePos, nudgeOpts);
                    return;
                }
            }
        }
    }

    const opts = { range: moveRange };
    if (visualizePathStyle) opts.visualizePathStyle = visualizePathStyle;
    if (extraOpts) {
        if (extraOpts.ignoreCreeps) opts.ignoreCreeps = true;
        if (Number.isFinite(extraOpts.reusePath)) opts.reusePath = extraOpts.reusePath;
    }
    creep.moveTo(target, opts);
}

var roleAssault = {
    /** @param {Creep} creep **/
    run: function (creep) {
        const task = creep.memory.task;
        const debugCombat = Memory.debugCombat;

        // ===========================
        // Planner-controlled detection
        // ===========================
        const movePlan = task && task.movePlan;
        const plannerControlled =
            !!(movePlan && movePlan.step && Number.isFinite(movePlan.step.dir));

        // ===========================
        // Border nudge bookkeeping
        // ===========================
        const lastRoom = creep.memory._lastRoom;
        if (lastRoom && lastRoom !== creep.room.name) {
            creep.memory._justEnteredRoom = Game.time;
            creep.memory._borderNudge = true;
        }
        creep.memory._lastRoom = creep.room.name;

        // Clear nudge flag once we're safely off border.
        if (!getBorderDirection(creep.pos) && creep.memory._borderNudge) {
            delete creep.memory._borderNudge;
        }

        // ==========================================
        // DUO-SAFE BORDER NUDGE EXECUTION
        // ==========================================
        // Only run nudge when planner is NOT controlling AND we're currently on an exit tile.
        // This prevents border helper logic from fighting the duoPlanner, while still protecting
        // against edge-stay hazards when the planner isn't supplying a move this tick.
        let didBorderNudge = false;
        const onBorder = !!getBorderDirection(creep.pos);
        if (!plannerControlled && creep.memory._borderNudge && onBorder) {
            const nudgePos = getNudgePosition(creep);
            if (nudgePos) {
                creep.moveTo(nudgePos, { range: 0, reusePath: 0 });
                didBorderNudge = true;
            }
        }

        // --- Global Deployment Logic ---
        // If spawned remotely, travel to home room before doing anything else.
        if (creep.memory._travellingToHome) {
            if (creep.room.name === creep.memory.room) {
                delete creep.memory._travellingToHome;
            } else {
                if (!didBorderNudge) {
                    const homeSpawn = getHomeSpawnTarget(creep);
                    if (homeSpawn) {
                        moveToTarget(creep, homeSpawn, 2);
                    } else if (Game.rooms[creep.memory.room] && Game.rooms[creep.memory.room].controller) {
                        moveToTarget(creep, Game.rooms[creep.memory.room].controller, 2);
                    } else {
                        moveToTarget(creep, new RoomPosition(25, 25, creep.memory.room), 20);
                    }
                }
                return;
            }
        }

        if (debugCombat) {
            logCombat(
                `[Assault] ${creep.name} Tick: ${Game.time} Pos: ${creep.pos} Task: ${JSON.stringify(task)}`
            );
        }

        if (!task) return;

        // ===================
        // 1) Execute Movement
        // ===================
        if (!didBorderNudge) {
            if (plannerControlled) {
                creep.move(movePlan.step.dir);
            } else if (task.moveTarget && (!movePlan || movePlan.allowFallbackMoveTo)) {
                const pos = new RoomPosition(task.moveTarget.x, task.moveTarget.y, task.moveTarget.roomName);
                if (debugCombat) logCombat(`[Assault] ${creep.name} moving to ${pos}`);
                moveToTarget(creep, pos, task.range, { stroke: '#ff0000' }, task.moveOpts);
            } else if (task.action === 'move') {
                // Handle generic move tasks (e.g. Decongest/Parking)
                let target;
                if (task.targetId) target = Game.getObjectById(task.targetId);
                else if (task.targetName) target = Game.flags[task.targetName];

                if (target) {
                    moveToTarget(creep, target, task.range, { stroke: '#ffffff' }, task.moveOpts);
                }
            }
        }

        // ==================
        // 2) Execute Actions
        // ==================
        const actions = task.actions || (task.action ? [{ action: task.action, targetId: task.targetId }] : []);

        actions.forEach((act) => {
            if (!act || !act.action) return;

            if (act.action === 'rangedMassAttack') {
                if (debugCombat) logCombat(`[Assault] ${creep.name} executing rangedMassAttack`);
                creep.rangedMassAttack();
                return;
            }

            if (act.targetId) {
                const target = Game.getObjectById(act.targetId);
                if (target) {
                    if (debugCombat) {
                        logCombat(
                            `[Assault] ${creep.name} executing ${act.action} on ${target} (Range: ${creep.pos.getRangeTo(
                                target
                            )})`
                        );
                    }
                    switch (act.action) {
                        case 'attack':
                            creep.attack(target);
                            break;
                        case 'rangedAttack':
                            creep.rangedAttack(target);
                            break;
                        case 'heal':
                            creep.heal(target);
                            break;
                        case 'rangedHeal':
                            creep.rangedHeal(target);
                            break;
                        case 'dismantle':
                            creep.dismantle(target);
                            break;
                    }
                } else if (debugCombat) {
                    logCombat(`[Assault] ${creep.name} target ${act.targetId} missing/invisible`);
                }
            }
        });
    }
};

module.exports = roleAssault;