// mission.remote.haul.js (heap-backed lane cache + reset-safe + rate-limited rebuild; Memory only for settings)
//
// Notes:
// - All non-settings caches live in heap (volatile). After VM reset, heap is empty and we rebuild lazily.
// - No path point arrays are written to Memory.

'use strict';

const remoteUtils = require('managers_overseer_utils_overseer.remote');
const remoteHaulPathing = require('managers_overseer_utils_overseer.remoteHaulPathing');
const REMOTE_HAUL_LANE_LAYOUT_VERSION = 3;

const toRoomPosition = (pos) => {
    if (!pos || !pos.roomName) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return new RoomPosition(x, y, pos.roomName);
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
        const TARGET_WORK = 5;
        const ENERGY_PER_TICK = 2 * TARGET_WORK;

        const TRANSFER_BUFFER_TICKS = 2;

        const DISTANCE_SOFT_CAP = 25;
        const DISTANCE_SCALE_PER_TILE = 0.002;

        const MAX_REMOTE_HAULER_CARRY_PARTS = 25;
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
                const rebuilt = laneManager.ensureLanes(pickupId, dropoffPos, pickupPos, laneKeyToPickup, laneKeyToDropoff);
                pathLen = rebuilt.pathLen || pathLen;

                const roundTrip = (pathLen * 2) + TRANSFER_BUFFER_TICKS;
                const distanceScale = 1 + Math.max(0, pathLen - DISTANCE_SOFT_CAP) * DISTANCE_SCALE_PER_TILE;

                const requiredCarryParts = Math.ceil((ENERGY_PER_TICK * roundTrip * distanceScale) / 50);
                const reqCount = Math.max(1, Math.ceil(requiredCarryParts / carryParts));

                debug('mission.remote.haul',
                    `[RemoteHaul] ${room.name} -> ${name} mode=${hasContainer ? 'container' : 'drop'} ` +
                    `pickup=${pickupId} path=${pathLen} carryParts=${carryParts} req=${reqCount} lane=${laneKeyBase}` +
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
                        spawnFromFleet: true,
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
