// mission.remote.haul.js (heap-backed lane cache + reset-safe + rate-limited rebuild; Memory only for settings)
//
// Notes:
// - All non-settings caches live in heap (volatile). After VM reset, heap is empty and we rebuild lazily.
// - No path point arrays are written to Memory.

'use strict';

const remoteUtils = require('managers_overseer_utils_overseer.remote');
const remoteHaulPathing = require('managers_overseer_utils_overseer.remoteHaulPathing');
const REMOTE_HAUL_LANE_LAYOUT_VERSION = 4;

const toRoomPosition = (pos) => {
    if (!pos || !pos.roomName) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return new RoomPosition(x, y, pos.roomName);
};

const buildOtherSourceRings = (sources, currentSourceId, roomName) => {
    const blockedTiles = [];
    if (!Array.isArray(sources) || !currentSourceId || !roomName) return blockedTiles;

    for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        if (!src || !src.id || src.id === currentSourceId) continue;

        const sx = Number(src.x);
        const sy = Number(src.y);
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const x = sx + dx;
                const y = sy + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                blockedTiles.push({ roomName, x, y });
            }
        }
    }

    return blockedTiles;
};

module.exports = {
    generate: function (room, intel, context, missions) {
        if (context.opState === 'EMERGENCY') return;

        const miningContainerIds = new Set(intel.sources.map(s => s.containerId).filter(id => id));
        const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
        const nonMiningContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
        const dropoffTarget = room.storage || nonMiningContainers[0];

        if (!dropoffTarget) {
            debug('mission.remote.haul', `[RemoteHaul] ${room.name} skipped: no dropoff target`);
            return;
        }

        const entries = remoteUtils.getRemoteEconomicContext(room, {
            opState: context.opState,
            maxScoutAge: 4000,
        });

        const { budget, getMissionCensus } = context;

        // ============================================================
        // SIZING: keep it simple (hardcode targetWork, derived energyPerTick)
        // ============================================================
        const TARGET_WORK = 7;
        const ENERGY_PER_TICK = 2 * TARGET_WORK;

        const TRANSFER_BUFFER_TICKS = 2;

        // Keep short/medium lanes strictly linear, but damp very long lanes so they do not
        // over-inflate required hauler count from pure path length growth.
        const LONG_LANE_DAMP_START = 20;
        const LONG_LANE_DAMP_FACTOR = 0.65;

        const MAX_REMOTE_HAULER_CARRY_PARTS = 16;
        const carryParts = Math.min(Math.max(1, Math.floor((budget || 0) / 100)), MAX_REMOTE_HAULER_CARRY_PARTS);

        // ============================================================
        // Signature invalidation (dropoff changes).
        // ============================================================
        const targetSignature = `v${REMOTE_HAUL_LANE_LAYOUT_VERSION}:dropoff:${dropoffTarget.id}`;
        const laneManager = remoteHaulPathing.createLaneManager(room.name, targetSignature);

        const sortedEntries = entries
            .slice()
            .sort((a, b) => String(a && a.name || '').localeCompare(String(b && b.name || '')));

        sortedEntries.forEach(({ name, entry, enabled }) => {
            if (!enabled || !entry || !Array.isArray(entry.sourcesInfo)) return;

            const sources = entry.sourcesInfo
                .slice()
                .sort((a, b) => String(a && a.id || '').localeCompare(String(b && b.id || '')));

            sources.forEach(source => {
                if (!source || !source.id) return;

                const hasContainer = !!(source.containerId && source.containerPos);
                const pickupId = hasContainer ? source.containerId : source.id;
                const standPos = source.standPos ? toRoomPosition(source.standPos) : null;

                const pickupPos = hasContainer
                    ? toRoomPosition(source.containerPos)
                    : (standPos || new RoomPosition(source.x, source.y, name));

                if (!pickupPos) return;

                const missionName = hasContainer
                    ? `remote:haul:${name}:${source.containerId}`
                    : `remote:haul:${name}:drop:${source.id}`;

                const census = getMissionCensus(missionName);

                const dropoffPos = dropoffTarget.pos;

                // Stable, deterministic lane key.
                const laneKeyBase = `rhaul:${room.name}:${pickupId}:${dropoffTarget.id}`;
                const laneKeyToPickup = `${laneKeyBase}:F`;
                const laneKeyToDropoff = `${laneKeyBase}:R`;

                // Get/refresh lane + pathLen without writing big blobs to Memory
                let pathLen = laneManager.getKnownPathLen(pickupId) || 1;

                // If lanes are missing/expired, try to rebuild (rate-limited).
                const blockedTiles = buildOtherSourceRings(sources, source.id, name);
                const rebuilt = laneManager.ensureLanes(
                    pickupId,
                    dropoffPos,
                    pickupPos,
                    laneKeyToPickup,
                    laneKeyToDropoff,
                    { blockedTiles }
                );
                pathLen = rebuilt.pathLen || pathLen;

                const effectivePathLen = pathLen > LONG_LANE_DAMP_START
                    ? Math.floor(LONG_LANE_DAMP_START + ((pathLen - LONG_LANE_DAMP_START) * LONG_LANE_DAMP_FACTOR))
                    : pathLen;
                const roundTrip = (effectivePathLen * 2) + TRANSFER_BUFFER_TICKS;

                const requiredCarryParts = Math.ceil((ENERGY_PER_TICK * roundTrip) / 50);
                const reqCount = Math.max(1, Math.ceil(requiredCarryParts / carryParts));

                debug('mission.remote.haul',
                    `[RemoteHaul] ${room.name} -> ${name} mode=${hasContainer ? 'container' : 'drop'} ` +
                    `pickup=${pickupId} path=${pathLen} effPath=${effectivePathLen} carryParts=${carryParts} req=${reqCount} lane=${laneKeyBase}` +
                    `${rebuilt.built ? ' (rebuilt)' : ''}`);

                missions.push({
                    name: missionName,
                    type: 'remote_haul',
                    archetype: 'remote_hauler',
                    requirements: {
                        archetype: 'remote_hauler',
                        requiredCarry: requiredCarryParts,
                        minCount: 1,
                        maxCount: reqCount,
                        maxCarryParts: MAX_REMOTE_HAULER_CARRY_PARTS,
                        spawnFromFleet: false,
                    },
                    data: {
                        // Explicit owner so role.universal can read lanes from the right room
                        homeRoom: room.name,

                        remoteRoom: name,
                        pickupId: pickupId,
                        pickupPos: { x: pickupPos.x, y: pickupPos.y, roomName: pickupPos.roomName },
                        dropoffId: dropoffTarget.id,
                        dropoffPos: { x: dropoffTarget.pos.x, y: dropoffTarget.pos.y, roomName: dropoffTarget.pos.roomName },
                        resourceType: RESOURCE_ENERGY,
                        pickupMode: hasContainer ? 'container' : 'drop',
                        pickupRange: hasContainer ? 1 : (standPos ? 1 : 2),

                        // Movement lane info (directional)
                        laneKeyToPickup: laneKeyToPickup,
                        laneKeyToDropoff: laneKeyToDropoff,

                        // Back-compat: keep a default laneKey
                        laneKey: laneKeyToPickup,
                        laneSig: targetSignature,
                    },
                    priority: 70,
                    census: census,
                });
            });
        });
    },
};
