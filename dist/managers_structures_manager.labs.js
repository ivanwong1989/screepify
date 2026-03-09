var reverseLabs = require('managers_structures_labs.reverse');


const DEFAULTS = Object.freeze({
    enabled: true,
    runEvery: 5,
    mode: 'react', // react | reverse | idle | purge (boost stocking is independent via cfg.boosts)
    transferPriority: 60,
    inputTarget: 2000,
    boostTarget: 1000,
    maxReactionsPerTick: 3,
    cleanupIdle: false,
    debug: false
});

function clampNumber(value, fallback, min) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    if (num < min) return min;
    return num;
}

function ensureLabConfig() {
    if (!Memory.labs || typeof Memory.labs !== 'object') Memory.labs = {};
    const cfg = Memory.labs;

    if (!cfg._initialized) {
        cfg.enabled = (typeof cfg.enabled === 'boolean') ? cfg.enabled : DEFAULTS.enabled;
        cfg.runEvery = clampNumber(cfg.runEvery, DEFAULTS.runEvery, 1);
        cfg.mode = cfg.mode || DEFAULTS.mode;
        cfg.transferPriority = clampNumber(cfg.transferPriority, DEFAULTS.transferPriority, 0);
        cfg.inputTarget = clampNumber(cfg.inputTarget, DEFAULTS.inputTarget, 0);
        cfg.boostTarget = clampNumber(cfg.boostTarget, DEFAULTS.boostTarget, 0);
        cfg.maxReactionsPerTick = clampNumber(cfg.maxReactionsPerTick, DEFAULTS.maxReactionsPerTick, 0);
        cfg.cleanupIdle = cfg.cleanupIdle === true;
        cfg.debug = cfg.debug === true;
        if (!cfg.rooms || typeof cfg.rooms !== 'object') cfg.rooms = {};
        cfg._initialized = true;
    }

    cfg.enabled = cfg.enabled !== false;
    cfg.runEvery = clampNumber(cfg.runEvery, DEFAULTS.runEvery, 1);
    cfg.mode = cfg.mode || DEFAULTS.mode;
    cfg.transferPriority = clampNumber(cfg.transferPriority, DEFAULTS.transferPriority, 0);
    cfg.inputTarget = clampNumber(cfg.inputTarget, DEFAULTS.inputTarget, 0);
    cfg.boostTarget = clampNumber(cfg.boostTarget, DEFAULTS.boostTarget, 0);
    cfg.maxReactionsPerTick = clampNumber(cfg.maxReactionsPerTick, DEFAULTS.maxReactionsPerTick, 0);
    cfg.cleanupIdle = cfg.cleanupIdle === true;
    cfg.debug = cfg.debug === true;
    if (!cfg.rooms || typeof cfg.rooms !== 'object') cfg.rooms = {};

    return cfg;
}

function mergePatch(target, patch) {
    if (!patch || typeof patch !== 'object') return target;
    for (const key of Object.keys(patch)) {
        const value = patch[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (!target[key] || typeof target[key] !== 'object') target[key] = {};
            mergePatch(target[key], value);
        } else {
            target[key] = value;
        }
    }
    return target;
}

function applyLabPatch(patch) {
    const cfg = ensureLabConfig();
    mergePatch(cfg, patch);
    return ensureLabConfig();
}

function applyRoomPatch(roomName, patch) {
    const cfg = ensureLabConfig();
    const key = ('' + roomName).trim();
    if (!key) return cfg;
    if (!cfg.rooms[key] || typeof cfg.rooms[key] !== 'object') cfg.rooms[key] = {};
    mergePatch(cfg.rooms[key], patch);
    return ensureLabConfig();
}

function getRoomConfig(base, roomName) {
    const override = base.rooms && base.rooms[roomName];
    if (!override || typeof override !== 'object') return base;
    const merged = Object.assign({}, base, override);
    if (override.boosts && typeof override.boosts === 'object') {
        merged.boosts = Object.assign({}, base.boosts || {}, override.boosts);
    }
    return merged;
}

function shouldRunThisTick(roomName, interval) {
    if (interval <= 1) return true;
    let hash = 0;
    for (let i = 0; i < roomName.length; i++) {
        hash = (hash + roomName.charCodeAt(i)) % interval;
    }
    return (Game.time % interval) === hash;
}

function normalizeLabIdList(list, labById) {
    if (!Array.isArray(list)) return [];
    return list
        .map(id => (id ? ('' + id).trim() : ''))
        .filter(id => id && labById[id]);
}

function normalizeReaction(spec) {
    if (!spec) return null;
    let a = null;
    let b = null;
    let product = null;

    if (Array.isArray(spec)) {
        a = spec[0];
        b = spec[1];
        product = spec[2];
    } else if (typeof spec === 'string') {
        const raw = spec.replace(/\s+/g, '');
        const match = raw.match(/^([^+]+)\+([^=]+)(?:=(.+))?$/);
        if (match) {
            a = match[1];
            b = match[2];
            product = match[3] || null;
        }
    } else if (typeof spec === 'object') {
        a = spec.reagentA || spec.reagent1 || spec.a || spec[0];
        b = spec.reagentB || spec.reagent2 || spec.b || spec[1];
        product = spec.product || spec.result || spec.output || spec.c || spec[2];
    }

    if (!a || !b) return null;
    a = ('' + a).trim();
    b = ('' + b).trim();
    if (product) product = ('' + product).trim();

    if (!product && typeof REACTIONS === 'object') {
        if (REACTIONS[a] && REACTIONS[a][b]) {
            product = REACTIONS[a][b];
        } else if (REACTIONS[b] && REACTIONS[b][a]) {
            const tmp = a;
            a = b;
            b = tmp;
            product = REACTIONS[a][b];
        }
    }

    return { reagentA: a, reagentB: b, product };
}

function normalizeBoostAssignments(boosts, labById) {
    if (!boosts || typeof boosts !== 'object') return {};
    const result = {};
    for (const resourceType of Object.keys(boosts)) {
        const labId = boosts[resourceType];
        if (!labId) continue;
        const key = ('' + labId).trim();
        if (!key || !labById[key]) continue;
        result[resourceType] = key;
    }
    return result;
}

function chooseSource(room, resourceType) {
    if (room.storage && room.storage.store && (room.storage.store[resourceType] || 0) > 0) {
        return room.storage;
    }
    if (room.terminal && room.terminal.store && (room.terminal.store[resourceType] || 0) > 0) {
        return room.terminal;
    }
    return null;
}

function chooseSink(room, resourceType) {
    if (room.storage && room.storage.store && room.storage.store.getFreeCapacity(resourceType) > 0) {
        return room.storage;
    }
    if (room.terminal && room.terminal.store && room.terminal.store.getFreeCapacity(resourceType) > 0) {
        return room.terminal;
    }
    return null;
}


function buildBoostLogisticsMissions(room, cfg, labs, labById) {
    const missions = [];
    if (!room || !cfg) return missions;
    if (!Array.isArray(labs) || labs.length === 0) return missions;
    if (!labById || typeof labById !== 'object') return missions;

    const boostAssignments = normalizeBoostAssignments(cfg.boosts, labById);
    const boostTypes = Object.keys(boostAssignments);
    if (boostTypes.length === 0) return missions;

    const missionPrefix = `labhaul:${room.name}`;
    const seen = new Set();

    // Keep mission names stable so an already-assigned hauler doesn't get released mid-run.
    const isMissionAssigned = (label) => {
        if (!label) return false;
        for (const creep of Object.values(Game.creeps)) {
            if (!creep || !creep.my) continue;
            const name = creep.memory && creep.memory.missionName;
            if (name === label) return true;
        }
        return false;
    };

    // For clear missions, infer resourceType from the mission label if a creep is already assigned.
    const getAssignedClearTypes = (labId) => {
        const out = new Set();
        if (!labId) return out;
        const prefix = `${missionPrefix}:clear:${labId}:`;
        for (const creep of Object.values(Game.creeps)) {
            if (!creep || !creep.my) continue;
            const name = creep.memory && creep.memory.missionName;
            if (!name || typeof name !== 'string') continue;
            if (!name.startsWith(prefix)) continue;
            const resourceType = name.slice(prefix.length);
            if (resourceType) out.add(resourceType);
        }
        return out;
    };

    const enqueue = (sourceId, targetId, resourceType, label) => {
        if (!targetId || !resourceType || !label) return;
        if (seen.has(label)) return;
        seen.add(label);

        missions.push({
            name: label,
            type: 'transfer',
            archetype: 'hauler',
            targetId: targetId,
            data: {
                resourceType: resourceType,
                sourceId: sourceId || null
            },
            requirements: {
                archetype: 'hauler',
                minCount: 1,
                maxCount: 1,
                spawn: false
            },
            priority: cfg.transferPriority
        });
    };

    const requestClear = (lab, resourceType) => {
        const sink = chooseSink(room, resourceType);
        if (!sink) return;
        const label = `${missionPrefix}:clear:${lab.id}:${resourceType}`;
        enqueue(lab.id, sink.id, resourceType, label);
    };

    const requestFill = (lab, resourceType, targetAmount) => {
        const current = lab.store[resourceType] || 0;
        if (current >= targetAmount) return;

        const label = `${missionPrefix}:fill:${lab.id}:${resourceType}`;

        const source = chooseSource(room, resourceType);
        if (!source) {
            // If a hauler already picked this up, keep the mission alive so it can finish delivery.
            if (!isMissionAssigned(label)) return;
            const keepSource = (room.storage && room.storage.id) || (room.terminal && room.terminal.id) || null;
            enqueue(keepSource, lab.id, resourceType, label);
            return;
        }

        enqueue(source.id, lab.id, resourceType, label);
    };

    const cleanupLab = (lab) => {
        if (lab.mineralType && (lab.store[lab.mineralType] || 0) > 0) {
            requestClear(lab, lab.mineralType);
            return;
        }

        // If a hauler already withdrew the last bit, keep the clear mission alive to finish dumping.
        const assigned = getAssignedClearTypes(lab.id);
        if (assigned.size === 0) return;
        for (const rt of assigned) {
            requestClear(lab, rt);
        }
    };

    // Only touch labs explicitly assigned as boost labs.
    for (const resourceType of boostTypes) {
        const labId = boostAssignments[resourceType];
        const lab = labById[labId];
        if (!lab) continue;

        if (lab.mineralType && lab.mineralType !== resourceType && (lab.store[lab.mineralType] || 0) > 0) {
            requestClear(lab, lab.mineralType);
            continue;
        }

        // If lab is "wrong but empty", no mission needed; it will become correct after first fill.
        if (lab.mineralType && lab.mineralType !== resourceType) {
            // Still allow fill if the game thinks it's empty (mineralType can linger on 0 sometimes).
        }

        requestFill(lab, resourceType, cfg.boostTarget);
    }

    return missions;
}

function buildLabLogisticsMissions(room, cfg) {
    const missions = [];
    // Always publish boost stocking missions (if configured)
    // so we can react/reverse while keeping boost labs topped up.
    // (Injected after labs discovery)

    if (!room || !room.controller || !room.controller.my) return missions;

    const cache = global.getRoomCache(room);
    const labs = cache.myStructuresByType[STRUCTURE_LAB] || [];
    if (labs.length === 0) return missions;

    const labById = {};
    for (const lab of labs) labById[lab.id] = lab;

    // Boost stocking is independent from reaction mode.
    const boostMissions = buildBoostLogisticsMissions(room, cfg, labs, labById);
    for (const m of boostMissions) missions.push(m);

    const mode = (cfg.mode || DEFAULTS.mode).toLowerCase();
    const reaction = normalizeReaction(cfg.reaction);
    const inputIds = normalizeLabIdList(cfg.inputLabs, labById);
    const inputA = (inputIds.length > 0) ? labById[inputIds[0]] : null;
    const inputB = (inputIds.length > 1) ? labById[inputIds[1]] : null;
    const boostAssignments = normalizeBoostAssignments(cfg.boosts, labById);
    const boostLabIds = new Set(Object.values(boostAssignments));

    let outputIds = normalizeLabIdList(cfg.outputLabs, labById);
    if (outputIds.length === 0) {
        outputIds = labs
            .map(l => l.id)
            .filter(id => !inputIds.includes(id) && !boostLabIds.has(id));
    }

    const missionPrefix = `labhaul:${room.name}`;
const seen = new Set();

// If a creep is already assigned to a label, keep publishing that mission
// even if the underlying "need" disappears mid-run (e.g. last withdraw emptied storage).
const isMissionAssigned = (label) => {
    if (!label) return false;
    for (const creep of Object.values(Game.creeps)) {
        if (!creep || !creep.my) continue;
        const name = creep.memory && creep.memory.missionName;
        if (name === label) return true;
    }
    return false;
};

// For clear missions, if a creep is assigned, we can infer resourceType from the mission label.
const getAssignedClearTypes = (labId) => {
    const out = new Set();
    if (!labId) return out;
    const prefix = `${missionPrefix}:clear:${labId}:`;
    for (const creep of Object.values(Game.creeps)) {
        if (!creep || !creep.my) continue;
        const name = creep.memory && creep.memory.missionName;
        if (!name || typeof name !== 'string') continue;
        if (!name.startsWith(prefix)) continue;
        const resourceType = name.slice(prefix.length);
        if (resourceType) out.add(resourceType);
    }
    return out;
};

// For fill missions, infer (labId, resourceType) pairs currently assigned from labels.
const getAssignedFillTypes = (labId) => {
    const out = new Set();
    if (!labId) return out;
    const prefix = `${missionPrefix}:fill:${labId}:`;
    for (const creep of Object.values(Game.creeps)) {
        if (!creep || !creep.my) continue;
        const name = creep.memory && creep.memory.missionName;
        if (!name || typeof name !== 'string') continue;
        if (!name.startsWith(prefix)) continue;
        const resourceType = name.slice(prefix.length);
        if (resourceType) out.add(resourceType);
    }
    return out;
};

const enqueue = (sourceId, targetId, resourceType, label) => {
        if (!targetId || !resourceType || !label) return;
        if (seen.has(label)) return;
        seen.add(label);
        missions.push({
            name: label,
            type: 'transfer',
            archetype: 'hauler',
            targetId: targetId,
            data: {
                resourceType: resourceType,
                sourceId: sourceId || null
            },
            requirements: {
                archetype: 'hauler',
                minCount: 1,
                maxCount: 1,
                spawn: false
            },
            priority: cfg.transferPriority
        });
    };

    const requestClear = (lab, resourceType) => {
        const sink = chooseSink(room, resourceType);
        if (!sink) return;
        const label = `${missionPrefix}:clear:${lab.id}:${resourceType}`;
        enqueue(lab.id, sink.id, resourceType, label);
    };

    const requestFill = (lab, resourceType, targetAmount) => {
        const current = lab.store[resourceType] || 0;
        if (current >= targetAmount) return;

        // IMPORTANT: keep the mission name stable so an already-assigned hauler
        // doesn't get released just because the chosen source changed or became empty.
        const label = `${missionPrefix}:fill:${lab.id}:${resourceType}`;

        const source = chooseSource(room, resourceType);
        if (!source) {
            // If a hauler already picked this up, keep the mission alive so it can finish delivery.
            if (!isMissionAssigned(label)) return;
            const keepSource = (room.storage && room.storage.id) || (room.terminal && room.terminal.id) || null;
            enqueue(keepSource, lab.id, resourceType, label);
            return;
        }

        enqueue(source.id, lab.id, resourceType, label);
    };

    const cleanupLab = (lab) => {
        if (lab.mineralType && (lab.store[lab.mineralType] || 0) > 0) {
            requestClear(lab, lab.mineralType);
            return;
        }

        // If a hauler already withdrew the last bit from the lab, keep the clear mission
        // alive so it can finish dumping even after the lab becomes empty.
        const assigned = getAssignedClearTypes(lab.id);
        if (assigned.size === 0) return;
        for (const rt of assigned) {
            requestClear(lab, rt);
        }
    };

        if (mode === 'idle') {
            if (cfg.cleanupIdle) {
                for (const lab of labs) {
                    // Do NOT cleanup labs reserved for boosts
                    if (boostLabIds.has(lab.id)) continue;
                    cleanupLab(lab);
                }
            }
        } else if (mode === 'purge') {
        for (const lab of labs) {
            if (!lab.mineralType) continue;

            const amount = lab.store[lab.mineralType] || 0;
            if (amount > 0) {
                requestClear(lab, lab.mineralType);
            }
        }
    } else if (mode === 'react') {
        if (!reaction) return missions;
        if (inputIds.length < 2) return missions;
        if (!inputA || !inputB) return missions;

        if (inputA.mineralType && inputA.mineralType !== reaction.reagentA && (inputA.store[inputA.mineralType] || 0) > 0) {
            requestClear(inputA, inputA.mineralType);
        } else {
            requestFill(inputA, reaction.reagentA, cfg.inputTarget);
        }

        if (inputB.mineralType && inputB.mineralType !== reaction.reagentB && (inputB.store[inputB.mineralType] || 0) > 0) {
            requestClear(inputB, inputB.mineralType);
        } else {
            requestFill(inputB, reaction.reagentB, cfg.inputTarget);
        }

        for (const outId of outputIds) {
            const lab = labById[outId];
            if (!lab) continue;
            if (boostLabIds.has(lab.id)) continue;
            if (reaction.product && lab.mineralType && lab.mineralType !== reaction.product && (lab.store[lab.mineralType] || 0) > 0) {
                requestClear(lab, lab.mineralType);
            }
        }
    }

    return missions;
}

function summarizeConfig(cfg) {
    const lines = [];
    lines.push(
        `Labs auto=${cfg.enabled ? 'ON' : 'OFF'} runEvery=${cfg.runEvery} mode=${cfg.mode} ` +
        `inputTarget=${cfg.inputTarget} boostTarget=${cfg.boostTarget} ` +
        `maxReactionsPerTick=${cfg.maxReactionsPerTick} cleanupIdle=${cfg.cleanupIdle ? 'true' : 'false'} ` +
        `transferPriority=${cfg.transferPriority}`
    );

    if (cfg.reaction) {
        const r = normalizeReaction(cfg.reaction);
        if (r) {
            const product = r.product ? ` -> ${r.product}` : '';
            lines.push(`Reaction: ${r.reagentA} + ${r.reagentB}${product}`);
        }
    }

    if (Array.isArray(cfg.inputLabs) && cfg.inputLabs.length > 0) {
        lines.push(`Input labs: ${cfg.inputLabs.join(', ')}`);
    }

    if (Array.isArray(cfg.outputLabs) && cfg.outputLabs.length > 0) {
        lines.push(`Output labs: ${cfg.outputLabs.join(', ')}`);
    }

    if (cfg.boosts && typeof cfg.boosts === 'object') {
        const keys = Object.keys(cfg.boosts);
        if (keys.length > 0) {
            lines.push('Boost labs:');
            for (const resourceType of keys) {
                lines.push(`${resourceType}: ${cfg.boosts[resourceType]}`);
            }
        }
    }

    return lines.join('\n');
}

const managerLabs = {
    getConfig: function() {
        return ensureLabConfig();
    },

    applyPatch: function(patch) {
        return applyLabPatch(patch);
    },

    applyRoomPatch: function(roomName, patch) {
        return applyRoomPatch(roomName, patch);
    },

    summarize: function() {
        const cfg = ensureLabConfig();
        return summarizeConfig(cfg);
    },

    summarizeRoom: function(roomName) {
        const cfg = ensureLabConfig();
        const merged = getRoomConfig(cfg, roomName);
        return summarizeConfig(merged);
    },

    getLogisticsMissions: function(room) {
        if (!room || !room.controller || !room.controller.my) return [];

        const base = ensureLabConfig();
        if (!base.enabled) return [];

        const cfg = getRoomConfig(base, room.name);
        if (!cfg.enabled) return [];
        if (room._opState === 'EMERGENCY') return [];

        // Reverse still uses the dedicated module, but we can run boost stocking in parallel.
        if (cfg.mode && cfg.mode.toLowerCase() === 'reverse') {
            const cache = global.getRoomCache(room);
            const labs = cache.myStructuresByType[STRUCTURE_LAB] || [];
            const labById = {};
            for (const lab of labs) labById[lab.id] = lab;

            const boostAssignments = normalizeBoostAssignments(cfg.boosts, labById);
            const boostLabIds = new Set(Object.values(boostAssignments));
            const boostMissions = buildBoostLogisticsMissions(room, cfg, labs, labById);

            // Prevent reverse logic from stealing/clearing boost labs.
            const reverseLabsList = labs.filter(l => l && !boostLabIds.has(l.id));
            const reverseMissions = reverseLabs.getReverseLogisticsMissions(room, cfg, reverseLabsList);

            return boostMissions.concat(reverseMissions);
        }

        return buildLabLogisticsMissions(room, cfg);
    },

    run: function(room) {
        if (!room || !room.controller || !room.controller.my) return;

        const base = ensureLabConfig();
        if (!base.enabled) return;

        const cfg = getRoomConfig(base, room.name);
        if (!cfg.enabled) return;
        if (!shouldRunThisTick(room.name, cfg.runEvery)) return;
        if (room._opState === 'EMERGENCY') return;

        const cache = global.getRoomCache(room);
        const labs = cache.myStructuresByType[STRUCTURE_LAB] || [];
        if (labs.length === 0) return;

        const labById = {};
        for (const lab of labs) labById[lab.id] = lab;

        const mode = (cfg.mode || DEFAULTS.mode).toLowerCase();
        const reaction = normalizeReaction(cfg.reaction);
        const inputIds = normalizeLabIdList(cfg.inputLabs, labById);
        const inputA = (inputIds.length > 0) ? labById[inputIds[0]] : null;
        const inputB = (inputIds.length > 1) ? labById[inputIds[1]] : null;
        const boostLabIds = new Set(Object.values(normalizeBoostAssignments(cfg.boosts, labById)));

        let outputIds = normalizeLabIdList(cfg.outputLabs, labById);
        if (outputIds.length === 0) {
            outputIds = labs
                .map(l => l.id)
                .filter(id => !inputIds.includes(id) && !boostLabIds.has(id));
        }

        // Reverse mode branch out
        if (mode === 'reverse') {
            // Prevent reverse logic from stealing/clearing boost labs.
            const boostAssignments = normalizeBoostAssignments(cfg.boosts, labById);
            const boostLabIds = new Set(Object.values(boostAssignments));
            const reverseLabsList = labs.filter(l => l && !boostLabIds.has(l.id));
            reverseLabs.runReverse(room, cfg, reverseLabsList);
            return;
        }

        if (mode === 'react') {
            if (!reaction) return;
            if (inputIds.length < 2) return;
            if (!inputA || !inputB) return;

            const product = reaction.product;
            if (product) {
                const canReact = (
                    inputA.mineralType === reaction.reagentA &&
                    inputB.mineralType === reaction.reagentB &&
                    (inputA.store[reaction.reagentA] || 0) > 0 &&
                    (inputB.store[reaction.reagentB] || 0) > 0
                );

                if (canReact) {
                    let fired = 0;
                    for (const outId of outputIds) {
                        if (cfg.maxReactionsPerTick > 0 && fired >= cfg.maxReactionsPerTick) break;
                        const outLab = labById[outId];
                        if (!outLab) continue;
                        if (boostLabIds.has(outLab.id)) continue;
                        if (outLab.cooldown && outLab.cooldown > 0) continue;
                        if (outLab.mineralType && outLab.mineralType !== product) continue;
                        if (outLab.store.getFreeCapacity(product) <= 0) continue;
                        const result = outLab.runReaction(inputA, inputB);
                        if (result === OK) fired += 1;
                    }
                }
            }
        }
    }
};

module.exports = managerLabs;
