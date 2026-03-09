const heap = require('utils_heap');

const HARVEST_TRAVEL_CACHE_TTL = 200;
const HARVEST_TRAVEL_STORE = 'harvestTravel';

function getSourceAnchorPos(room, source) {
    if (!room || !source || !source.pos) return null;

    if (source.containerId) {
        const container = Game.getObjectById(source.containerId);
        if (container && container.pos) return container.pos;
    }

    const terrain = room.getTerrain();
    let best = null;

    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;

            const x = source.pos.x + dx;
            const y = source.pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

            const structures = room.lookForAt(LOOK_STRUCTURES, x, y) || [];
            let blocked = false;
            for (let i = 0; i < structures.length; i++) {
                const s = structures[i];
                if (
                    s.structureType !== STRUCTURE_ROAD &&
                    s.structureType !== STRUCTURE_CONTAINER &&
                    !(s.structureType === STRUCTURE_RAMPART && s.my)
                ) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) continue;

            const pos = new RoomPosition(x, y, room.name);
            if (!best) best = pos;
            if (terrain.get(x, y) !== TERRAIN_MASK_SWAMP) return pos;
        }
    }

    return best;
}

function estimateTravelTicks(pathLen, bodyLen, moveParts) {
    if (!pathLen || pathLen <= 0) return 0;
    if (!bodyLen || bodyLen <= 0) return pathLen;
    if (!moveParts || moveParts <= 0) return pathLen * bodyLen;

    const ticksPerStep = Math.max(1, Math.ceil(bodyLen / (2 * moveParts)));
    return pathLen * ticksPerStep;
}

function estimateMinerStatsForPlanning(budget, mode) {
    if (mode === 'mobile') {
        const segments = Math.max(1, Math.floor((budget || 0) / 250));
        const work = Math.min(5, segments);
        const move = Math.max(2, segments * 2);
        const carry = Math.max(1, segments);
        return { work, move, carry, bodyLen: work + move + carry };
    }

    const safeBudget = Math.max(200, budget || 0);
    const work = Math.max(1, Math.min(7, 1 + Math.floor((safeBudget - 200) / 100)));
    const carry = 1;
    const move = 1;
    return { work, move, carry, bodyLen: work + carry + move };
}

function getHarvestTravelEstimate(room, spawns, source, archStats) {
    if (!room || !source || !source.id || !spawns || spawns.length === 0) {
        return {
            sourceDistance: 0,
            travelTicks: 0,
            preSpawnLeadTicks: 0,
            travelFromSpawnId: null
        };
    }

    const store = heap.getStore(HARVEST_TRAVEL_STORE, { ttl: HARVEST_TRAVEL_CACHE_TTL });
    const cacheKey = `${room.name}:${source.id}`;
    let cached = store[cacheKey];

    if (!cached) {
        const anchorPos = getSourceAnchorPos(room, source);
        if (!anchorPos) {
            cached = {
                sourceDistance: 0,
                travelFromSpawnId: null
            };
        } else {
            let bestPathLen = Infinity;
            let bestSpawnId = null;

            for (let i = 0; i < spawns.length; i++) {
                const spawn = spawns[i];
                if (!spawn || !spawn.pos) continue;

                const path = spawn.pos.findPathTo(anchorPos, {
                    range: 0,
                    ignoreCreeps: true,
                    maxOps: 2000
                });
                const pathLen = path ? path.length : 0;

                if (pathLen < bestPathLen) {
                    bestPathLen = pathLen;
                    bestSpawnId = spawn.id;
                }
            }

            cached = {
                sourceDistance: Number.isFinite(bestPathLen) && bestPathLen !== Infinity ? bestPathLen : 0,
                travelFromSpawnId: bestSpawnId
            };
        }

        store[cacheKey] = cached;
    }

    const bodyLen = archStats && Number.isFinite(archStats.bodyLen)
        ? archStats.bodyLen
        : (archStats && archStats.body ? archStats.body.length : 0);
    const moveParts = archStats && archStats.move ? archStats.move : 0;
    const travelTicks = estimateTravelTicks(cached.sourceDistance, bodyLen, moveParts);

    return {
        sourceDistance: cached.sourceDistance || 0,
        travelTicks: travelTicks,
        preSpawnLeadTicks: travelTicks,
        travelFromSpawnId: cached.travelFromSpawnId || null
    };
}

module.exports = {
    generate: function(room, intel, context, missions) {
        const { opState, budget, getMissionCensus, efficientSources } = context;
        const isEmergency = opState === 'EMERGENCY';
        const spawns = intel.structures[STRUCTURE_SPAWN] || [];
        const extensions = intel.structures[STRUCTURE_EXTENSION] || [];
        const towers = intel.structures[STRUCTURE_TOWER] || [];
        const storage = room.storage;

        intel.sources.forEach(source => {
            const isEfficient = efficientSources.has(source.id);
            const hasContainer = !!source.containerId;
            const hasHauler = intel.myCreeps.some(c => c.memory.role === 'hauler');
            const hasLogistics = hasHauler;
            const canUseStaticDrop = isEfficient && hasLogistics;

            let mode = 'mobile';
            if (canUseStaticDrop) {
                mode = hasContainer ? 'static' : 'static_drop';
            }

            let containerId = hasContainer ? source.containerId : null;
            let dropoffIds = [];
            let fallback = 'none';
            let dropoffRange = 1;

            if (mode === 'static') {
                const linkId = source.linkId || null;
                if (linkId) dropoffIds.push(linkId);
                if (containerId) dropoffIds.push(containerId);
                fallback = 'none';
            } else if (mode === 'static_drop') {
                dropoffIds = [];
                fallback = 'none';
            } else {
                const spawnExt = [
                    ...spawns.filter(s => s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0).map(s => s.id),
                    ...extensions.filter(e => e.store && e.store.getFreeCapacity(RESOURCE_ENERGY) > 0).map(e => e.id)
                ];
                const towerIds = towers
                    .filter(t => t.store && t.store.getFreeCapacity(RESOURCE_ENERGY) >= 50)
                    .map(t => t.id);
                const storageIds = (storage && storage.store && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
                    ? [storage.id]
                    : [];
                dropoffIds = [...spawnExt, ...towerIds, ...storageIds];
                fallback = 'upgrade';
            }

            const missionName = `harvest:${source.id}`;
            const census = getMissionCensus(missionName);
            const archStats = estimateMinerStatsForPlanning(budget, mode);
            const travel = getHarvestTravelEstimate(room, spawns, source, archStats);
            const targetWork = 7;
            const maxCount = Math.max(1, source.availableSpaces || 1);

            const staticRolesBySlot = {};
            if (mode === 'static' && maxCount > 1) {
                staticRolesBySlot['0'] = 'container';
                for (let i = 1; i < maxCount; i++) staticRolesBySlot[String(i)] = 'overflow';
            }

            debug('mission.harvest', `[Harvest] ${room.name} ${source.id} mode=${mode} ` +
                `count=${census.count} workParts=${census.workParts}/${targetWork} ` +
                `maxCount=${maxCount} dist=${travel.sourceDistance} travel=${travel.travelTicks}`);

            const hasValidSource = !!source.id;
            const hasValidMode = (mode === 'static' || mode === 'static_drop' || mode === 'mobile');
            const hasValidStatic = mode !== 'static' || (containerId && dropoffIds.length > 0);
            const hasValidStaticDrop = mode !== 'static_drop' || (containerId === null && dropoffIds.length === 0);
            const hasValidMobile = mode !== 'mobile' || Array.isArray(dropoffIds);

            if (!hasValidSource || !hasValidMode || !hasValidStatic || !hasValidStaticDrop || !hasValidMobile) {
                debug('mission.harvest', `[Harvest] ${room.name} ${source.id} blocked: invalid contract`);
                return;
            }

            missions.push({
                name: missionName,
                type: 'harvest',
                archetype: 'miner',
                sourceId: source.id,
                pos: source.pos,
                requirements: {
                    archetype: 'miner',
                    requiredWork: targetWork,
                    minCount: 1,
                    maxCount: maxCount
                },
                spawnSlots: (() => {
                    const slots = [];
                    const count = Math.max(0, maxCount || 0);
                    for (let i = 0; i < count; i++) {
                        slots.push(`harvest:${room.name}:${source.id}:${i}`);
                    }
                    return slots;
                })(),
                data: {
                    sourceId: source.id,
                    mode: mode,
                    dropoffIds: dropoffIds,
                    fallback: fallback,
                    containerId: containerId,
                    dropoffRange: dropoffRange,
                    staticRolesBySlot: staticRolesBySlot,
                    overflowPolicy: 'drop',
                    sourceDistance: travel.sourceDistance,
                    travelTicks: travel.travelTicks,
                    preSpawnLeadTicks: travel.preSpawnLeadTicks,
                    travelFromSpawnId: travel.travelFromSpawnId
                },
                priority: isEmergency ? 1000 : 100
            });
        });
    }
};
