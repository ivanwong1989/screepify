const heap = require('utils_heap');
const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const remoteUtils = require('managers_overseer_utils_overseer.remote');

const MAX_REMOTE_BUILD_SITES_PER_ROOM = 3;
const MAX_REMOTE_ROAD_SITES_PER_TICK = 3;
const REMOTE_ROAD_PLANNER_INTERVAL = 197;
const GLOBAL_CONSTRUCTION_SITE_LIMIT = 100;
const REMOTE_BUILD_CONTEXT_INDEX_STORE = 'remoteBuildContextIndex';

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function toPosObject(pos, fallbackRoomName) {
    if (!pos) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    const roomName = pos.roomName || fallbackRoomName || null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !roomName) return null;
    return { x, y, roomName };
}

function getRemoteContextIndex(homeRoom, opState) {
    if (!homeRoom) return { entries: [], byName: Object.create(null) };
    const store = heap.getStore(REMOTE_BUILD_CONTEXT_INDEX_STORE, { ttl: 3 });
    const key = `${homeRoom.name}:${opState || 'none'}:${Game.time}`;
    const cached = store[key];
    if (cached && Array.isArray(cached.entries) && cached.byName) return cached;

    const entries = remoteUtils.getRemoteEconomicContext(homeRoom, {
        opState: opState || null,
        maxScoutAge: 4000
    });
    const byName = Object.create(null);
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry && entry.name) byName[entry.name] = entry;
    }
    const next = { tick: Game.time, entries, byName };
    store[key] = next;
    return next;
}

function getRemoteEntry(homeRoom, remoteRoomName, opState) {
    if (!homeRoom || !remoteRoomName) return null;
    const ctx = getRemoteContextIndex(homeRoom, opState);
    return ctx.byName[remoteRoomName] || null;
}

function canPlaceRoadSite(room, x, y) {
    if (!room || x < 1 || x > 48 || y < 1 || y > 48) return false;

    const terrain = room.getTerrain();
    if (!terrain || terrain.get(x, y) === TERRAIN_MASK_WALL) return false;

    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (!s) continue;
        if (s.structureType === STRUCTURE_ROAD) return false;
        if (s.structureType === STRUCTURE_RAMPART) continue;
        return false;
    }

    const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
    return !sites || sites.length <= 0;
}

function isSwampTile(room, x, y) {
    if (!room) return false;
    const terrain = room.getTerrain();
    if (!terrain) return false;
    return terrain.get(x, y) === TERRAIN_MASK_SWAMP;
}

function seedRoadSitesFromCachedRemoteHaulLanes(homeRoom, entries) {
    if (!homeRoom || !Array.isArray(entries) || entries.length <= 0) return 0;

    const allSites = Game.constructionSites ? Object.keys(Game.constructionSites).length : 0;
    if (allSites >= GLOBAL_CONSTRUCTION_SITE_LIMIT) return 0;

    const laneStore = heap.getStore('remoteHaul', { ttl: null });
    const roomStore = laneStore && laneStore.rooms ? laneStore.rooms[homeRoom.name] : null;
    const lanes = roomStore && roomStore.lanes ? roomStore.lanes : null;
    if (!lanes) return 0;

    const enabledVisibleRooms = Object.create(null);
    for (let i = 0; i < entries.length; i++) {
        const wrapped = entries[i];
        if (!wrapped || !wrapped.enabled || !wrapped.name || !wrapped.room) continue;
        enabledVisibleRooms[wrapped.name] = wrapped.room;
    }
    const roomNames = Object.keys(enabledVisibleRooms);
    if (roomNames.length <= 0) return 0;

    const perRoomBudget = Object.create(null);
    for (let i = 0; i < roomNames.length; i++) {
        const roomName = roomNames[i];
        const remote = enabledVisibleRooms[roomName];
        const activeSites = remote.find(FIND_MY_CONSTRUCTION_SITES) || [];
        perRoomBudget[roomName] = Math.max(0, MAX_REMOTE_BUILD_SITES_PER_ROOM - activeSites.length);
    }

    let remainingGlobal = Math.min(
        MAX_REMOTE_ROAD_SITES_PER_TICK,
        Math.max(0, GLOBAL_CONSTRUCTION_SITE_LIMIT - allSites)
    );
    if (remainingGlobal <= 0) return 0;

    const seen = Object.create(null);
    const laneKeys = Object.keys(lanes);
    let placed = 0;

    for (let i = 0; i < laneKeys.length && remainingGlobal > 0; i++) {
        const laneKey = laneKeys[i];
        if (!laneKey || !laneKey.endsWith(':F')) continue;
        const lane = lanes[laneKey];
        if (!lane || !Array.isArray(lane.p) || lane.p.length <= 0) continue;

        for (let j = 0; j < lane.p.length && remainingGlobal > 0; j++) {
            const p = lane.p[j];
            if (!p || !p.r || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            const remote = enabledVisibleRooms[p.r];
            if (!remote) continue;
            if (!perRoomBudget[p.r] || perRoomBudget[p.r] <= 0) continue;

            const key = `${p.r}:${p.x}:${p.y}`;
            if (seen[key]) continue;
            seen[key] = 1;

            // Keep auto-roading sparse: only pave swamp tiles on remote lanes.
            if (!isSwampTile(remote, p.x, p.y)) continue;
            if (!canPlaceRoadSite(remote, p.x, p.y)) continue;

            const result = remote.createConstructionSite(p.x, p.y, STRUCTURE_ROAD);
            if (result === OK) {
                perRoomBudget[p.r] -= 1;
                remainingGlobal -= 1;
                placed += 1;
                continue;
            }
            if (result === ERR_FULL) return placed;
        }
    }

    return placed;
}

module.exports = {
    makeKey(context) {
        const sponsorRoom = context.sponsorRoom || context.targetRoom || null;
        const targetRoom = context.targetRoom || context.sponsorRoom || null;
        const siteId = context.siteId || context.targetId || null;
        if (sponsorRoom && targetRoom && siteId) {
            return missionKeys.makeRemoteBuildKey(sponsorRoom, targetRoom, siteId);
        }
        return missionKeys.makeUserMissionKey(
            sponsorRoom || targetRoom || 'unknown',
            'remoteBuild',
            siteId,
            'remoteBuild'
        );
    },

    discover({ room, context }) {
        if (!room) return [];
        if (context && context.opState === 'EMERGENCY') return [];
        const opState = context && context.opState ? context.opState : null;
        const remoteCtx = getRemoteContextIndex(room, opState);
        const entries = remoteCtx.entries;
        const out = [];

        for (let i = 0; i < entries.length; i++) {
            const wrapped = entries[i];
            const remoteRoom = wrapped && wrapped.name ? wrapped.name : null;
            const entry = wrapped && wrapped.entry ? wrapped.entry : null;
            const remote = wrapped && wrapped.room ? wrapped.room : null;
            const enabled = !!(wrapped && wrapped.enabled);
            if (!enabled || !remoteRoom || !remote) continue;

            const sites = remote.find(FIND_MY_CONSTRUCTION_SITES);
            if (!sites || sites.length <= 0) continue;

            const sourcesInfo = entry && Array.isArray(entry.sourcesInfo) ? entry.sourcesInfo : [];
            const sourceIds = sourcesInfo.map(s => s && s.id).filter(Boolean);
            const containerIds = sourcesInfo.map(s => s && s.containerId).filter(Boolean);
            const capped = sites.slice(0, MAX_REMOTE_BUILD_SITES_PER_ROOM);

            for (let j = 0; j < capped.length; j++) {
                const site = capped[j];
                if (!site || !site.id || !site.pos) continue;
                const createContext = {
                    sponsorRoom: room.name,
                    targetRoom: remoteRoom,
                    siteId: site.id,
                    targetPos: { x: site.pos.x, y: site.pos.y, roomName: site.pos.roomName },
                    sourceIds,
                    containerIds,
                    requiredWork: 4,
                    priority: 55
                };
                out.push({
                    key: this.makeKey(createContext),
                    createContext,
                    discoveredMeta: {
                        remoteRoom,
                        siteId: site.id
                    }
                });
            }
        }

        return out;
    },

    create(context) {
        const now = Game.time;
        const remoteRoom = context.targetRoom || context.sponsorRoom;
        const targetPos = toPosObject(context.targetPos, remoteRoom);
        const siteId = context.siteId || context.targetId || null;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'remoteBuild',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: remoteRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 55,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: siteId,
            assigned: { primary: [], support: [] },
            demand: { role: 'remote_worker', count: 1, bodyProfile: 'remote_worker' },
            goal: {
                kind: 'finite',
                target: { kind: 'remote_build_site', roomName: remoteRoom, id: siteId },
                success: { kind: 'site_built_or_removed' }
            },
            progress: { stage: 'remote_build', goalState: 'awaiting_assignment' },
            meta: {
                remoteRoom,
                missionName: `remoteBuild:${remoteRoom}:${siteId || 'anon'}`,
                requiredWork: Number.isFinite(context.requiredWork) ? context.requiredWork : 4
            },
            data: {
                remoteRoom,
                targetPos,
                sourceIds: Array.isArray(context.sourceIds) ? context.sourceIds : [],
                containerIds: Array.isArray(context.containerIds) ? context.containerIds : []
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const sponsor = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[mission.sponsorRoom];
        const context = runtimeCtx && runtimeCtx.context ? runtimeCtx.context : null;
        if (!sponsor || !sponsor.controller || !sponsor.controller.my) return false;
        const entry = getRemoteEntry(sponsor, mission.targetRoom, context && context.opState);
        if (!(entry && entry.enabled)) return false;
        const expectedKey = missionKeys.makeRemoteBuildKey(
            mission.sponsorRoom,
            mission.targetRoom,
            mission.targetId
        );
        return mission.id === expectedKey;
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);
        mission.meta = mission.meta || {};
        mission.data = mission.data || {};
        mission.progress = mission.progress || {};

        const site = mission.targetId ? Game.getObjectById(mission.targetId) : null;
        if (site && site.pos) {
            mission.data.targetPos = { x: site.pos.x, y: site.pos.y, roomName: site.pos.roomName };
            mission.targetRoom = site.pos.roomName;
            mission.lastProgressTick = Game.time;
        }

        mission.meta.remoteRoom = mission.meta.remoteRoom || mission.targetRoom;
        mission.meta.requiredWork = Number.isFinite(mission.meta.requiredWork) ? mission.meta.requiredWork : 4;
        mission.meta.missionName = mission.meta.missionName || `remoteBuild:${mission.targetRoom}:${mission.targetId || 'anon'}`;

        mission.requirements = {
            archetype: 'remote_worker',
            requiredWork: mission.meta.requiredWork,
            minCount: 1,
            maxCount: 1,
            spawn: true
        };
        mission.demand = {
            role: 'remote_worker',
            count: Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'remote_worker'
        };
        mission.progress.stage = 'remote_build';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'executing' : 'awaiting_assignment';

        if (!Array.isArray(mission.data.sourceIds)) mission.data.sourceIds = [];
        if (!Array.isArray(mission.data.containerIds)) mission.data.containerIds = [];
    },

    isComplete(mission, runtimeCtx) {
        const site = mission.targetId ? Game.getObjectById(mission.targetId) : null;
        if (site) return false;
        const remoteRoomName = mission.targetRoom || (mission.meta && mission.meta.remoteRoom) || null;
        if (!remoteRoomName) return true;
        const remoteRoom = Game.rooms[remoteRoomName];
        if (!remoteRoom) return false;
        return true;
    },

    toContractMission(mission) {
        return {
            name: mission.meta && mission.meta.missionName
                ? mission.meta.missionName
                : `remoteBuild:${mission.targetRoom}:${mission.targetId || 'anon'}`,
            type: 'remote_build',
            archetype: 'remote_worker',
            targetId: mission.targetId || null,
            targetPos: mission.data && mission.data.targetPos ? mission.data.targetPos : null,
            data: {
                remoteRoom: mission.data && mission.data.remoteRoom ? mission.data.remoteRoom : mission.targetRoom,
                targetPos: mission.data && mission.data.targetPos ? mission.data.targetPos : null,
                sourceIds: mission.data && Array.isArray(mission.data.sourceIds) ? mission.data.sourceIds : [],
                containerIds: mission.data && Array.isArray(mission.data.containerIds) ? mission.data.containerIds : [],
                requiredWork: mission.meta && Number.isFinite(mission.meta.requiredWork) ? mission.meta.requiredWork : 4
            },
            requirements: mission.requirements || {
                archetype: 'remote_worker',
                requiredWork: 4,
                minCount: 1,
                maxCount: 1,
                spawn: true
            },
            priority: Number.isFinite(mission.priority) ? mission.priority : 55
        };
    }
};
