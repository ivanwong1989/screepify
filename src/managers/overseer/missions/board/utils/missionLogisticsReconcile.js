const heap = require('utils_heap');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const managerTerminal = require('managers_structures_manager.terminal');

const MAX_HAULER_CARRY_PARTS = 25;
const LOGISTICS_COMPONENT_THROTTLE_STORE = 'logisticsDetectorThrottle';
const SUPPLY_CRITICAL_SCAN_INTERVAL = 5;
const SUPPLY_AUX_SCAN_INTERVAL = 17;
const LANE_SCAN_INTERVAL = 51;
const PICKUP_SCAN_INTERVAL = 23;
const STOCK_SCAN_INTERVAL = 17;
const TERMINAL_ENERGY_TARGET_FALLBACK = 60000;
const TERMINAL_ENERGY_MAX_FALLBACK = 80000;
const STORAGE_ENERGY_RESERVE_FALLBACK = 20000;
const ROUTE_AGE_STORE = 'logisticsRouteAge';
const ROUTE_AGE_PRUNE_INTERVAL = 200;
const ROUTE_AGE_TTL = 2000;
const ROUTE_AGE_MAX_KEYS_PER_ROOM = 1500;

function getLogisticsPriority(kind, target, isEmergency) {
    if (kind === 'supply') {
        if (target && target.structureType === STRUCTURE_TOWER) return isEmergency ? 950 : 95;
        if (target && (target.structureType === STRUCTURE_SPAWN || target.structureType === STRUCTURE_EXTENSION)) {
            return isEmergency ? 900 : 80;
        }
        return 70;
    }
    if (kind === 'link_out') return 95;
    if (kind === 'mining') return 85;
    if (kind === 'drop_mining') return 47;
    if (kind === 'scavenge') return 45;
    if (kind === 'terminal_stock') return 60;
    return 40;
}

function getAvailableAmount(source, resourceType) {
    const rt = resourceType || RESOURCE_ENERGY;
    if (!source) return 0;
    if (source.store) return source.store[rt] || 0;
    if (source.resourceType === rt && Number.isFinite(source.amount)) return source.amount;
    return 0;
}

function getSlots(source, target, carryParts, resourceType, amountOverride) {
    const cap = Math.max(50, carryParts * 50);
    const amount = Number.isFinite(amountOverride)
        ? Math.max(0, amountOverride)
        : getAvailableAmount(source, resourceType);
    if (amount <= 0) return 0;
    const dist = source.pos.getRangeTo(target.pos);
    const travelTicks = dist * 2 + 10;
    const roundTrip = travelTicks * 2 + 10;
    const demandTrips = amount / cap;
    const desiredClearTicks = 100;
    let slots = Math.ceil((demandTrips * roundTrip) / desiredClearTicks);
    slots = Math.max(1, Math.min(3, slots));
    return slots;
}

function getEffectiveSourceCapacity(source, resourceType, fallback) {
    if (!source || !source.store) return Math.max(50, fallback || 50);
    const rt = resourceType || RESOURCE_ENERGY;
    let capacity = 0;
    if (typeof source.store.getCapacity === 'function') {
        capacity = source.store.getCapacity(rt);
        if (!Number.isFinite(capacity)) capacity = source.store.getCapacity();
    }
    if (!Number.isFinite(capacity) || capacity <= 0) {
        if (Number.isFinite(source.storeCapacity)) capacity = source.storeCapacity;
    }
    if (!Number.isFinite(capacity) || capacity <= 0) capacity = fallback || 50;
    return Math.max(50, capacity);
}

function closestByRange(pos, targets) {
    if (!pos || !Array.isArray(targets) || targets.length === 0) return null;
    let best = null;
    let bestRange = Infinity;
    for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (!t || !t.pos) continue;
        const r = pos.getRangeTo(t.pos);
        if (r < bestRange) {
            bestRange = r;
            best = t;
        }
    }
    return best;
}

function getComponentThrottle(roomName) {
    const store = heap.getStore(LOGISTICS_COMPONENT_THROTTLE_STORE, { ttl: 500 });
    if (!store.byRoom) store.byRoom = Object.create(null);
    if (!store.byRoom[roomName]) {
        store.byRoom[roomName] = {
            supplyCritical: 0,
            supplyAux: 0,
            lanes: 0,
            pickup: 0,
            stock: 0
        };
    }
    return store.byRoom[roomName];
}

function shouldRunComponent(roomName, component, interval, forceRun) {
    const throttle = getComponentThrottle(roomName);
    const now = Game.time;
    if (forceRun) {
        throttle[component] = now;
        return true;
    }

    const last = Number.isFinite(throttle[component]) ? throttle[component] : 0;
    if ((now - last) < Math.max(1, interval || 1)) return false;
    throttle[component] = now;
    return true;
}

function addSupplyJobs(room, intel, context, missionBoard, isEmergency, mode) {
    const useCritical = mode !== 'aux';
    const useAux = mode !== 'critical';
    const targets = [];
    if (useCritical) {
        targets.push.apply(targets, intel.structures[STRUCTURE_SPAWN] || []);
        targets.push.apply(targets, intel.structures[STRUCTURE_EXTENSION] || []);
        targets.push.apply(targets, intel.structures[STRUCTURE_TOWER] || []);
    }
    if (useAux) {
        targets.push.apply(targets, intel.structures[STRUCTURE_LAB] || []);
    }

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (!target || !target.store || target.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) continue;
        const supplyClass = target.structureType === STRUCTURE_LAB ? 'aux' : 'critical';
        missionBoard.createMission('logisticsJob', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            kind: 'supply',
            targetId: target.id,
            resourceType: RESOURCE_ENERGY,
            supplyClass,
            priority: getLogisticsPriority('supply', target, isEmergency)
        }, { room, intel, context });
    }
}

function getRouteAgeStore(roomName) {
    const root = heap.getStore(ROUTE_AGE_STORE, { ttl: null });
    if (!root.byRoom) root.byRoom = Object.create(null);
    if (!Number.isFinite(root.lastPruneTick)) root.lastPruneTick = 0;
    if (!root.byRoom[roomName]) root.byRoom[roomName] = Object.create(null);

    if ((Game.time - root.lastPruneTick) >= ROUTE_AGE_PRUNE_INTERVAL) {
        root.lastPruneTick = Game.time;
        for (const rn in root.byRoom) {
            const mem = root.byRoom[rn];
            if (!mem) continue;
            for (const key in mem) {
                const firstSeen = mem[key];
                if (!Number.isFinite(firstSeen) || (Game.time - firstSeen) > ROUTE_AGE_TTL) {
                    delete mem[key];
                }
            }
            const keys = Object.keys(mem);
            if (keys.length > ROUTE_AGE_MAX_KEYS_PER_ROOM) {
                keys.sort((a, b) => mem[a] - mem[b]);
                const remove = keys.length - ROUTE_AGE_MAX_KEYS_PER_ROOM;
                for (let i = 0; i < remove; i++) delete mem[keys[i]];
            }
        }
    }
    return root.byRoom[roomName];
}

function getRoutePolicy(kind, carryParts, source, resourceType) {
    const cap = Math.max(50, carryParts * 50);
    const sourceCap = getEffectiveSourceCapacity(source, resourceType, cap);
    const efficientLoad = Math.max(50, Math.min(cap, sourceCap));
    if (kind === 'link_out') return { minAmount: efficientLoad, maxAgeTicks: null };
    if (kind === 'mining') return { minAmount: efficientLoad, maxAgeTicks: null };
    return { minAmount: clampNumber(Math.floor(cap * 0.25), 50, 25, 1200), maxAgeTicks: 300 };
}

function shouldScheduleRoute(roomName, routeKey, amount, policy) {
    const mem = getRouteAgeStore(roomName);
    if (!routeKey || !policy) return amount > 0;
    if (!Number.isFinite(amount) || amount <= 0) {
        if (Object.prototype.hasOwnProperty.call(mem, routeKey)) delete mem[routeKey];
        return false;
    }
    if (!Object.prototype.hasOwnProperty.call(mem, routeKey)) mem[routeKey] = Game.time;
    if (amount >= policy.minAmount) return true;
    if (!Number.isFinite(policy.maxAgeTicks) || policy.maxAgeTicks <= 0) return false;
    const age = Math.max(0, Game.time - mem[routeKey]);
    return age >= policy.maxAgeTicks;
}

function addPersistentLanes(room, intel, context, missionBoard, carryParts, isEmergency) {
    const storage = room.storage;
    if (!storage || !storage.store || storage.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return;
    const efficientSources = context && context.efficientSources ? context.efficientSources : null;
    if (!efficientSources || efficientSources.size <= 0) return;

    for (let i = 0; i < intel.sources.length; i++) {
        const srcInfo = intel.sources[i];
        if (!srcInfo || !srcInfo.id || !efficientSources.has(srcInfo.id) || !srcInfo.containerId) continue;
        const source = Game.getObjectById(srcInfo.containerId);
        if (!source || !source.pos) continue;
        const laneType = 'mining';
        const routeKey = `${laneType}:${source.id}:${storage.id}:${RESOURCE_ENERGY}`;
        const amount = getAvailableAmount(source, RESOURCE_ENERGY);
        const policy = getRoutePolicy(laneType, carryParts, source, RESOURCE_ENERGY);
        if (!shouldScheduleRoute(room.name, routeKey, amount, policy)) continue;
        const slots = getSlots(source, storage, carryParts, RESOURCE_ENERGY, amount);
        for (let slot = 0; slot < slots; slot++) {
            missionBoard.createMission('logisticsLane', {
                sponsorRoom: room.name,
                targetRoom: room.name,
                sourceId: source.id,
                targetId: storage.id,
                resourceType: RESOURCE_ENERGY,
                slot,
                laneType,
                priority: getLogisticsPriority('mining', storage, isEmergency),
                allowPartial: false,
                minAmount: policy.minAmount
            }, { room, intel, context });
        }
    }

    const links = intel.structures[STRUCTURE_LINK] || [];
    const spawns = intel.structures[STRUCTURE_SPAWN] || [];
    for (let i = 0; i < links.length; i++) {
        const link = links[i];
        if (!link || !link.pos) continue;
        const amount = link.store[RESOURCE_ENERGY] || 0;
        if (amount <= 0) continue;
        const nearStorageOrSpawn = link.pos.inRangeTo(storage.pos, 3) || spawns.some(s => s && s.pos && link.pos.inRangeTo(s.pos, 3));
        if (!nearStorageOrSpawn) continue;
        if (room.controller && link.pos.inRangeTo(room.controller.pos, 3)) continue;
        const laneType = 'link_out';
        const routeKey = `${laneType}:${link.id}:${storage.id}:${RESOURCE_ENERGY}`;
        const policy = getRoutePolicy(laneType, carryParts, link, RESOURCE_ENERGY);
        if (!shouldScheduleRoute(room.name, routeKey, amount, policy)) continue;

        missionBoard.createMission('logisticsLane', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            sourceId: link.id,
            targetId: storage.id,
            resourceType: RESOURCE_ENERGY,
            slot: 0,
            laneType,
            priority: getLogisticsPriority('link_out', storage, isEmergency),
            allowPartial: true,
            minAmount: policy.minAmount
        }, { room, intel, context });
    }
}

function addPickupJobs(room, intel, context, missionBoard, isEmergency) {
    const miningContainerIds = new Set((intel.sources || []).map(s => s.containerId).filter(id => id));
    const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
    const nonMiningContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
    const sinks = [];
    if (room.storage && room.storage.store && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) sinks.push(room.storage);
    for (let i = 0; i < nonMiningContainers.length; i++) {
        const c = nonMiningContainers[i];
        if (c && c.store && c.store.getFreeCapacity(RESOURCE_ENERGY) > 0) sinks.push(c);
    }
    if (sinks.length === 0) return;

    const dropped = intel.dropped || [];
    for (let i = 0; i < dropped.length; i++) {
        const source = dropped[i];
        if (!source || source.resourceType !== RESOURCE_ENERGY || source.amount <= 100) continue;
        const sink = closestByRange(source.pos, sinks);
        if (!sink) continue;
        missionBoard.createMission('logisticsJob', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            kind: 'pickup',
            sourceId: source.id,
            targetId: sink.id,
            resourceType: RESOURCE_ENERGY,
            amountThreshold: 25,
            allowPartial: true,
            priority: getLogisticsPriority('scavenge', sink, isEmergency)
        }, { room, intel, context });
    }

    const scavenges = []
        .concat(intel.ruins || [])
        .concat(intel.tombstones || []);
    for (let i = 0; i < scavenges.length; i++) {
        const source = scavenges[i];
        if (!source || !source.store || (source.store[RESOURCE_ENERGY] || 0) <= 0) continue;
        const sink = closestByRange(source.pos, sinks);
        if (!sink) continue;
        missionBoard.createMission('logisticsJob', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            kind: 'pickup',
            sourceId: source.id,
            targetId: sink.id,
            resourceType: RESOURCE_ENERGY,
            amountThreshold: 0,
            allowPartial: true,
            priority: getLogisticsPriority('scavenge', sink, isEmergency)
        }, { room, intel, context });
    }
}

function clampNumber(value, fallback, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const lo = Number.isFinite(min) ? min : -Infinity;
    const hi = Number.isFinite(max) ? max : Infinity;
    if (num < lo) return lo;
    if (num > hi) return hi;
    return num;
}

function getStoreAmount(obj, resourceType) {
    if (!obj) return 0;
    if (obj.store) return obj.store[resourceType] || 0;
    if (obj.resourceType === resourceType && Number.isFinite(obj.amount)) return obj.amount;
    return 0;
}

function getTerminalRoomPolicy(roomName) {
    const base = (managerTerminal && typeof managerTerminal.getConfig === 'function')
        ? (managerTerminal.getConfig() || {})
        : {};
    const rooms = base.rooms && typeof base.rooms === 'object' ? base.rooms : {};
    const key = String(roomName || '').toUpperCase();
    const roomCfg = rooms[key] || rooms[roomName] || {};

    return {
        terminalEnergyTarget: clampNumber(
            roomCfg.terminalEnergyTarget,
            TERMINAL_ENERGY_TARGET_FALLBACK,
            0,
            300000
        ),
        terminalEnergyMax: clampNumber(
            roomCfg.terminalEnergyMax,
            TERMINAL_ENERGY_MAX_FALLBACK,
            0,
            300000
        ),
        energyReserve: clampNumber(
            roomCfg.energyReserve,
            STORAGE_ENERGY_RESERVE_FALLBACK,
            0,
            1000000
        )
    };
}

function addTerminalStockJob(room, missionBoard, source, target, resourceType, moveAmount, isEmergency, opts) {
    if (!source || !target || !resourceType) return;
    const amount = Math.floor(Number(moveAmount));
    if (!Number.isFinite(amount) || amount <= 0) return;
    const sourceNow = getStoreAmount(source, resourceType);
    if (sourceNow <= 0) return;
    const boundedMove = Math.min(sourceNow, amount);
    if (boundedMove <= 0) return;

    const sourceThreshold = Math.max(0, sourceNow - boundedMove);
    const extra = opts && typeof opts === 'object' ? opts : {};

    const mission = missionBoard.createMission('logisticsJob', {
        sponsorRoom: room.name,
        targetRoom: room.name,
        kind: 'stock',
        sourceId: source.id,
        targetId: target.id,
        resourceType,
        amountThreshold: sourceThreshold,
        amountHint: boundedMove,
        allowPartial: false,
        targetMin: Number.isFinite(extra.targetMin) ? extra.targetMin : null,
        targetMax: Number.isFinite(extra.targetMax) ? extra.targetMax : null,
        priority: getLogisticsPriority('terminal_stock', target, isEmergency)
    }, { room, context: null });

    // createMission returns existing live missions as-is; keep stock bounds fresh when policy changes.
    if (!mission || !mission.meta) return;
    mission.meta.amountThreshold = sourceThreshold;
    mission.meta.amountHint = boundedMove;
    mission.meta.targetMin = Number.isFinite(extra.targetMin) ? extra.targetMin : null;
    mission.meta.targetMax = Number.isFinite(extra.targetMax) ? extra.targetMax : null;
    mission.meta.allowPartial = false;
    mission.priority = getLogisticsPriority('terminal_stock', target, isEmergency);
    mission.updatedTick = Game.time;
}

function addTerminalStockJobs(room, missionBoard, isEmergency) {
    const storage = room.storage;
    const terminal = room.terminal;
    if (!storage || !storage.store || !terminal || !terminal.store) return;
    const policy = getTerminalRoomPolicy(room.name);
    const energyTarget = policy.terminalEnergyTarget;
    const energyMax = policy.terminalEnergyMax;
    const storageFloor = policy.energyReserve;

    if (energyTarget > 0) {
        const cur = terminal.store[RESOURCE_ENERGY] || 0;
        const stor = storage.store[RESOURCE_ENERGY] || 0;
        const storageFree = storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        const deadband = clampNumber(Math.ceil(energyTarget * 0.05), 500, 500, 5000);
        const lo = Math.max(0, energyTarget - deadband);
        const hi = energyMax > 0 ? Math.min(energyTarget + deadband, energyMax) : (energyTarget + deadband);

        if (cur < lo) {
            const storageSpare = Math.max(0, stor - storageFloor);
            const need = Math.min(energyTarget - cur, storageSpare);
            if (need > 0) {
                addTerminalStockJob(room, missionBoard, storage, terminal, RESOURCE_ENERGY, need, isEmergency, {
                    targetMin: energyTarget
                });
            }
        } else if (cur > hi && storageFree > 0) {
            const excess = Math.max(0, cur - energyTarget);
            const flush = Math.min(excess, storageFree);
            if (flush > 0) {
                addTerminalStockJob(room, missionBoard, terminal, storage, RESOURCE_ENERGY, flush, isEmergency, {
                    targetMax: energyTarget
                });
            }
        }
    }

    const terminalTargets = (managerTerminal && typeof managerTerminal.getTerminalStockTargets === 'function')
        ? (managerTerminal.getTerminalStockTargets(room.name) || {})
        : {};
    const keys = new Set();
    Object.keys(terminalTargets).forEach(k => keys.add(k));
    Object.keys(terminal.store || {}).forEach(k => keys.add(k));

    keys.forEach(resourceType => {
        if (!resourceType || resourceType === RESOURCE_ENERGY) return;
        const target = Number(terminalTargets[resourceType] || 0);
        const termAmt = terminal.store[resourceType] || 0;

        if (target > 0) {
            const deadband = clampNumber(Math.ceil(target * 0.05), 50, 50, 2000);
            const lo = Math.max(0, target - deadband);
            const hi = target + deadband;

            if (termAmt < lo) {
                const storageAmt = storage.store[resourceType] || 0;
                if (storageAmt <= 0) return;
                const need = Math.min(target - termAmt, storageAmt);
                if (need <= 0) return;
                addTerminalStockJob(room, missionBoard, storage, terminal, resourceType, need, isEmergency, {
                    targetMin: target
                });
                return;
            }

            if (termAmt > hi) {
                const storageFree = storage.store.getFreeCapacity(resourceType) || 0;
                if (storageFree <= 0) return;
                const excess = Math.min(termAmt - target, storageFree);
                if (excess <= 0) return;
                addTerminalStockJob(room, missionBoard, terminal, storage, resourceType, excess, isEmergency, {
                    targetMax: target
                });
            }
            return;
        }

        if (termAmt > 0) {
            const storageFree = storage.store.getFreeCapacity(resourceType) || 0;
            if (storageFree <= 0) return;
            const flushAll = Math.min(termAmt, storageFree);
            if (flushAll <= 0) return;
            addTerminalStockJob(room, missionBoard, terminal, storage, resourceType, flushAll, isEmergency, {
                targetMax: 0
            });
        }
    });
}

function reconcileRoom({ room, intel, context, missionBoard }) {
    if (!room || !missionBoard || !intel) return;
    const isEmergency = (context && context.opState === 'EMERGENCY');
    const hasCriticalEnergyGap = room.energyAvailable < room.energyCapacityAvailable;
    const live = missionBoard.listLiveByRoom(room.name);
    const existingLanes = live.filter(m => m.type === 'logisticsLane').length;
    let existingSupplyJobs = 0;
    let existingCriticalSupplyJobs = 0;
    let existingAuxSupplyJobs = 0;
    let existingPickupJobs = 0;
    let existingStockJobs = 0;
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (!mission || mission.type !== 'logisticsJob') continue;
        const kind = mission.meta && mission.meta.kind;
        if (kind === 'supply') {
            existingSupplyJobs++;
            const supplyClass = mission.meta && mission.meta.supplyClass;
            if (supplyClass === 'aux') existingAuxSupplyJobs++;
            else existingCriticalSupplyJobs++;
        }
        else if (kind === 'pickup') existingPickupJobs++;
        else if (kind === 'stock') existingStockJobs++;
    }
    const hasLogisticsCoverage = (existingLanes + existingSupplyJobs + existingPickupJobs + existingStockJobs) > 0;
    if (
        hasLogisticsCoverage &&
        !isEmergency &&
        !hasCriticalEnergyGap &&
        !missionThrottle.shouldRunReconcile('logistics', room.name, Game.time)
    ) return;

    const efficientSources = context && context.efficientSources ? context.efficientSources : new Set();
    const budget = Number.isFinite(context && context.budget) ? context.budget : room.energyCapacityAvailable;
    const estimatedCarryParts = Math.max(1, Math.floor((budget || 0) / 100));
    const carryParts = Math.min(estimatedCarryParts, MAX_HAULER_CARRY_PARTS);

    const forceCriticalSupplyScan = existingCriticalSupplyJobs === 0 || hasCriticalEnergyGap;
    const labs = intel.structures[STRUCTURE_LAB] || [];
    const labNeedsEnergy = labs.some(l => l && l.store && l.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    const forceAuxSupplyScan = existingAuxSupplyJobs === 0 && labNeedsEnergy;
    const forceLaneScan = existingLanes === 0;
    const potentialPickupCount = (intel.dropped ? intel.dropped.length : 0) +
        (intel.ruins ? intel.ruins.length : 0) +
        (intel.tombstones ? intel.tombstones.length : 0);
    const forcePickupScan = existingPickupJobs === 0 && potentialPickupCount > 0;
    const forceStockScan = existingStockJobs === 0;

    const criticalSupplyInterval = isEmergency ? 1 : SUPPLY_CRITICAL_SCAN_INTERVAL;
    if (shouldRunComponent(room.name, 'supplyCritical', criticalSupplyInterval, forceCriticalSupplyScan)) {
        addSupplyJobs(room, intel, context, missionBoard, isEmergency, 'critical');
    }
    if (!isEmergency && labNeedsEnergy && shouldRunComponent(room.name, 'supplyAux', SUPPLY_AUX_SCAN_INTERVAL, forceAuxSupplyScan)) {
        addSupplyJobs(room, intel, context, missionBoard, isEmergency, 'aux');
    }
    if (efficientSources.size > 0 && shouldRunComponent(room.name, 'lanes', LANE_SCAN_INTERVAL, forceLaneScan)) {
        addPersistentLanes(room, intel, context, missionBoard, carryParts, isEmergency);
    }
    if (!isEmergency && potentialPickupCount > 0 && shouldRunComponent(room.name, 'pickup', PICKUP_SCAN_INTERVAL, forcePickupScan)) {
        addPickupJobs(room, intel, context, missionBoard, isEmergency);
    }
    if (!isEmergency && shouldRunComponent(room.name, 'stock', STOCK_SCAN_INTERVAL, forceStockScan)) {
        addTerminalStockJobs(room, missionBoard, isEmergency);
    }
}

module.exports = {
    reconcileRoom
};
