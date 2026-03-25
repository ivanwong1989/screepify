/**
 * Overseer Utils Module
 * Handles census, worker reassignment, and visualization.
 */


let heap = null;
try {
    heap = require('utils_heap');
} catch (e) {
    heap = null; // allow running even if heap module isn't present in this shard/file context
}

let missionBoard = null;
try {
    missionBoard = require('managers_overseer_missions_board_missionBoard');
} catch (e) {
    missionBoard = null;
}

let missionRuntime = null;
try {
    missionRuntime = require('managers_overseer_missions_board_missionRuntime');
} catch (e) {
    missionRuntime = null;
}

const overseerUtils = {
    drawCoreLaneV2Visuals: function(room) {
        if (!room || !Memory || Memory.debugVisual !== true) return;
        if (!missionBoard || typeof missionBoard.listLiveByRoom !== 'function') return;
        if (!missionRuntime || typeof missionRuntime.getMissionRuntime !== 'function') return;

        const live = missionBoard.listLiveByRoom(room.name) || [];
        const missions = live.filter(m => m && m.type === 'logisticsCoreV2');
        if (missions.length <= 0) return;

        for (let mi = 0; mi < missions.length; mi++) {
            const mission = missions[mi];
            const runtime = missionRuntime.getMissionRuntime(mission);
            if (!runtime || !runtime.paths) continue;

            const core = runtime.paths.core;
            const labs = runtime.paths.labs;

            if (core && Array.isArray(core.path) && core.path.length > 0) {
                for (let i = 1; i < core.path.length; i++) {
                    const a = core.path[i - 1];
                    const b = core.path[i];
                    if (!a || !b || a.roomName !== room.name || b.roomName !== room.name) continue;
                    room.visual.line(a, b, { color: '#33cc66', width: 0.12, opacity: 0.8 });
                }
                if (core.headPos && core.headPos.roomName === room.name) {
                    room.visual.circle(core.headPos, { radius: 0.3, fill: '#00cc66', stroke: '#003300' });
                }
                if (core.endPos && core.endPos.roomName === room.name) {
                    room.visual.circle(core.endPos, { radius: 0.3, fill: '#ff6666', stroke: '#660000' });
                }
                for (let i = 0; i < core.path.length; i += 5) {
                    const p = core.path[i];
                    if (!p || p.roomName !== room.name) continue;
                    room.visual.text(String(i), p.x, p.y - 0.25, { font: 0.4, color: '#ffffff' });
                    const stopCount = core.stopsByIndex && core.stopsByIndex[i] ? core.stopsByIndex[i].length : 0;
                    if (stopCount > 0) {
                        room.visual.text(String(stopCount), p.x, p.y + 0.35, { font: 0.35, color: '#ffee66' });
                    }
                }
            }

            if (labs && Array.isArray(labs.path) && labs.path.length > 0) {
                for (let i = 1; i < labs.path.length; i++) {
                    const a = labs.path[i - 1];
                    const b = labs.path[i];
                    if (!a || !b || a.roomName !== room.name || b.roomName !== room.name) continue;
                    room.visual.line(a, b, { color: '#4488ff', width: 0.1, opacity: 0.65 });
                }
                if (labs.endPos && labs.endPos.roomName === room.name) {
                    room.visual.circle(labs.endPos, { radius: 0.25, fill: '#66aaff', stroke: '#0d2f66' });
                }
            }
        }
    },

    drawMiningLaneV2Visuals: function(room) {
        if (!room || !Memory || Memory.debugVisual !== true) return;
        if (!missionBoard || typeof missionBoard.listLiveByRoom !== 'function') return;
        if (!missionRuntime || typeof missionRuntime.getMissionRuntime !== 'function') return;

        const live = missionBoard.listLiveByRoom(room.name) || [];
        const missions = live.filter(m => m && m.type === 'logisticsMiningV2');
        if (missions.length <= 0) return;

        for (let mi = 0; mi < missions.length; mi++) {
            const mission = missions[mi];
            const runtime = missionRuntime.getMissionRuntime(mission);
            if (!runtime || !Array.isArray(runtime.path) || runtime.path.length <= 0) continue;

            const path = runtime.path;
            for (let i = 1; i < path.length; i++) {
                const a = path[i - 1];
                const b = path[i];
                if (!a || !b || a.roomName !== room.name || b.roomName !== room.name) continue;
                room.visual.line(a, b, { color: '#ffaa33', width: 0.1, opacity: 0.9, lineStyle: 'dotted' });
            }

            if (runtime.pickupPos && runtime.pickupPos.roomName === room.name) {
                room.visual.circle(runtime.pickupPos, { radius: 0.28, fill: '#ffcc66', stroke: '#7a4f00' });
                room.visual.text('M-P', runtime.pickupPos.x, runtime.pickupPos.y - 0.35, { font: 0.35, color: '#ffdd99' });
            }

            if (runtime.sinkPos && runtime.sinkPos.roomName === room.name) {
                room.visual.circle(runtime.sinkPos, { radius: 0.28, fill: '#ff9966', stroke: '#6a2f10' });
                room.visual.text('M-S', runtime.sinkPos.x, runtime.sinkPos.y - 0.35, { font: 0.35, color: '#ffd2bf' });
            }

            for (let i = 0; i < path.length; i += 4) {
                const p = path[i];
                if (!p || p.roomName !== room.name) continue;
                room.visual.text(String(i), p.x, p.y + 0.35, { font: 0.32, color: '#ffcc88' });
            }

            const assigned = mission.assigned && Array.isArray(mission.assigned.primary)
                ? mission.assigned.primary
                : [];
            for (let i = 0; i < assigned.length; i++) {
                const creep = Game.creeps[assigned[i]];
                if (!creep || !creep.my || !creep.pos || creep.pos.roomName !== room.name) continue;
                const laneIndex = runtime.indexByPos
                    ? runtime.indexByPos[`${creep.pos.roomName}:${creep.pos.x},${creep.pos.y}`]
                    : undefined;
                room.visual.circle(creep.pos, { radius: 0.33, fill: 'transparent', stroke: '#ffcc33', strokeWidth: 0.08 });
                room.visual.text(
                    `MH ${Number.isInteger(laneIndex) ? laneIndex : 'off'}`,
                    creep.pos.x,
                    creep.pos.y - 0.55,
                    { font: 0.3, color: '#ffe6a3', stroke: '#000000', strokeWidth: 0.12 }
                );
            }
        }
    },

    getRequiredHeadcount: function(mission) {
        if (!mission) return 0;
        const req = mission.requirements || {};
        if (Number.isFinite(req.maxCount)) return req.maxCount;
        if (Number.isFinite(req.minCount)) return req.minCount;

        const assignedCount = mission && mission.assigned && Array.isArray(mission.assigned.primary)
            ? mission.assigned.primary.length
            : 0;
        if (Number.isFinite(mission.meta && mission.meta.desiredCount)) {
            return Math.max(0, mission.meta.desiredCount);
        }
        if (Number.isFinite(mission.demand && mission.demand.count)) {
            // Board demand is usually "additional needed", so desired ~= assigned + demand.
            return Math.max(assignedCount, assignedCount + mission.demand.count);
        }

        if (!mission.requirements) return assignedCount;

        const census = mission.census || {};
        const count = Math.max(1, census.count || 0);
        const avgWork = Math.max(1, Math.ceil((census.workParts || 0) / count));
        const avgCarry = Math.max(1, Math.ceil((census.carryParts || 0) / count));
        const avgClaim = 1;

        const byWork = Number.isFinite(req.requiredWork) ? Math.ceil(req.requiredWork / avgWork) : 0;
        const byCarry = Number.isFinite(req.requiredCarry) ? Math.ceil(req.requiredCarry / avgCarry) : 0;
        const byClaim = Number.isFinite(req.requiredClaim) ? Math.ceil(req.requiredClaim / avgClaim) : 0;
        return Math.max(byWork, byCarry, byClaim, 0);
    },

    getMissionProgress: function(mission) {
        const assignedCount = mission && mission.assigned && Array.isArray(mission.assigned.primary)
            ? mission.assigned.primary.length
            : 0;
        const census = mission && mission.census
            ? mission.census
            : { count: assignedCount, workParts: 0, carryParts: 0, claimParts: 0 };
        const req = mission && mission.requirements ? mission.requirements : {};

        const requiredWork = Number.isFinite(req.requiredWork) ? Math.max(0, req.requiredWork) : 0;
        const requiredCarry = Number.isFinite(req.requiredCarry) ? Math.max(0, req.requiredCarry) : 0;
        const requiredClaim = Number.isFinite(req.requiredClaim) ? Math.max(0, req.requiredClaim) : 0;

        const haveWork = Math.max(0, census.workParts || 0);
        const haveCarry = Math.max(0, census.carryParts || 0);
        const haveClaim = Math.max(0, census.claimParts || 0);

        const hasPartDemand = requiredWork > 0 || requiredCarry > 0 || requiredClaim > 0;
        if (hasPartDemand) {
            const workOk = requiredWork <= 0 || haveWork >= requiredWork;
            const carryOk = requiredCarry <= 0 || haveCarry >= requiredCarry;
            const claimOk = requiredClaim <= 0 || haveClaim >= requiredClaim;
            return {
                filled: workOk && carryOk && claimOk,
                summary: `W ${haveWork}/${requiredWork} C ${haveCarry}/${requiredCarry} Q ${haveClaim}/${requiredClaim}`,
                short: `${haveWork}/${requiredWork}W ${haveCarry}/${requiredCarry}C ${haveClaim}/${requiredClaim}Q`
            };
        }

        const requiredCount = this.getRequiredHeadcount(mission);
        const assigned = Math.max(0, Number.isFinite(census.count) ? census.count : assignedCount);
        return {
            filled: assigned >= requiredCount,
            summary: `N ${assigned}/${requiredCount}`,
            short: `${assigned}/${requiredCount}`
        };
    },

    analyzeCensus: function(missions, creeps) {
        // Informational only: used for UI/debug and mission logic that depends on "currently assigned".
        // Spawn planning must rely on contract fulfillment census, not mission.census.
        const missionMap = {};
        const roleMissions = {};

        missions.forEach(m => {
            if (m.censusLocked && m.census) {
                m.census = {
                    count: m.census.count || 0,
                    workParts: m.census.workParts || 0,
                    carryParts: m.census.carryParts || 0,
                    claimParts: m.census.claimParts || 0
                };
            } else {
                m.census = { count: 0, workParts: 0, carryParts: 0, claimParts: 0 };
            }
            missionMap[m.name] = m;
            if (m.roleCensus) {
                if (!roleMissions[m.roleCensus]) roleMissions[m.roleCensus] = [];
                roleMissions[m.roleCensus].push(m);
            }
        });

        creeps.forEach(c => {
            const memory = c.memory || {};
            const workParts = c.getActiveBodyparts(WORK);
            const carryParts = c.getActiveBodyparts(CARRY);
            const claimParts = c.getActiveBodyparts(CLAIM);

            if (memory.missionName && missionMap[memory.missionName]) {
                const m = missionMap[memory.missionName];
                // Avoid double-counting roleCensus missions through missionName.
                if (!m.censusLocked && !m.roleCensus) {
                    m.census.count++;
                    m.census.workParts += workParts;
                    m.census.carryParts += carryParts;
                    m.census.claimParts += claimParts;
                }
            }
            if (memory.role && roleMissions[memory.role]) {
                roleMissions[memory.role].forEach(m => {
                    if (m.censusLocked) return;
                    m.census.count++;
                    m.census.workParts += workParts;
                    m.census.carryParts += carryParts;
                    m.census.claimParts += claimParts;
                });
            }
        });
    },

    reassignWorkers: function(room, missions, intel) {
        // Mission ownership is strict: no cross-mission reassignment here.
        return;
    },

    getLiveBoardVisualMissions: function(room, contractMissions) {
        if (!room || !missionBoard || typeof missionBoard.listLiveByRoom !== 'function') return [];
        const contracts = Array.isArray(contractMissions) ? contractMissions : [];
        const contractsByName = Object.create(null);
        for (let i = 0; i < contracts.length; i++) {
            const c = contracts[i];
            if (!c || !c.name) continue;
            contractsByName[c.name] = c;
        }

        const live = missionBoard.listLiveByRoom(room.name) || [];
        const boardVisuals = [];

        for (let i = 0; i < live.length; i++) {
            const m = live[i];
            if (!m) continue;
            const missionName =
                (m.meta && m.meta.missionName) ||
                m.name ||
                m.id ||
                `${m.type}:${room.name}`;
            const contract = contractsByName[missionName] || null;
            boardVisuals.push({
                name: missionName,
                type: m.type,
                state: m.state || null,
                priority: Number.isFinite(m.priority) ? m.priority : 0,
                requirements: m.requirements || (contract && contract.requirements) || null,
                census: (contract && contract.census) || m.census || null,
                assigned: m.assigned || null,
                demand: m.demand || null,
                progress: m.progress || null,
                meta: m.meta || null,
                data: m.data || (contract && contract.data) || null,
                pos: m.pos || (contract && contract.pos) || null,
                targetId: m.targetId || (contract && contract.targetId) || null,
                targetIds: m.targetIds || (contract && contract.targetIds) || null,
                targetNames: m.targetNames || (contract && contract.targetNames) || null
            });
        }

        return boardVisuals;
    },

    getMissionVisualColor: function(missionState, filled) {
        const state = missionState || 'active';
        if (state === 'blocked') return '#ff9966';
        if (state === 'completing') return '#ffee88';
        if (state === 'proposed') return '#99ccff';
        return filled ? '#aaffaa' : '#ffaaaa';
    },

    drawMissionWorksites: function(room, mission, color, lookupState) {
        if (!room || !mission) return;
        const MAX_PER_MISSION = 8;
        const MAX_QUEUE_IDS = 4;
        const lookup = lookupState || { used: 0, max: 80 };
        const seenPos = Object.create(null);
        let drawn = 0;

        const drawAtPos = (pos, label, stroke, radius) => {
            if (!pos || pos.roomName !== room.name || drawn >= MAX_PER_MISSION) return;
            const key = `${pos.roomName}:${pos.x},${pos.y}`;
            if (seenPos[key]) return;
            seenPos[key] = true;
            drawn++;
            room.visual.circle(pos.x, pos.y, {
                fill: 'transparent',
                radius: Number.isFinite(radius) ? radius : 0.38,
                stroke: stroke || color,
                strokeWidth: 0.08
            });
            if (label) {
                room.visual.text(label, pos.x, pos.y - 0.38, {
                    font: 0.3,
                    color: stroke || color,
                    stroke: '#000000',
                    strokeWidth: 0.12
                });
            }
        };

        const drawById = (id, label, stroke, radius) => {
            if (!id || drawn >= MAX_PER_MISSION) return;
            if (lookup.used >= lookup.max) return;
            lookup.used++;
            const obj = Game.getObjectById(id);
            if (!obj || !obj.pos) return;
            drawAtPos(obj.pos, label, stroke, radius);
        };

        const data = mission.data || {};
        if (mission.pos) drawAtPos(mission.pos, mission.type || 'M', color, 0.5);
        if (mission.targetId) drawById(mission.targetId, 'T', color, 0.42);
        if (Array.isArray(mission.targetIds)) {
            for (let i = 0; i < mission.targetIds.length && i < 3; i++) {
                drawById(mission.targetIds[i], 'T', color, 0.35);
            }
        }
        if (data.sourceId) drawById(data.sourceId, 'S', '#66ccff', 0.35);
        if (Array.isArray(data.sourceIds)) {
            for (let i = 0; i < data.sourceIds.length && i < 3; i++) {
                drawById(data.sourceIds[i], 'S', '#66ccff', 0.32);
            }
        }
        if (data.pickupId) drawById(data.pickupId, 'P', '#ffcc66', 0.32);
        if (data.dropoffId) drawById(data.dropoffId, 'D', '#99ff99', 0.32);
        if (Array.isArray(data.dropoffIds)) {
            for (let i = 0; i < data.dropoffIds.length && i < 2; i++) {
                drawById(data.dropoffIds[i], 'D', '#99ff99', 0.3);
            }
        }
        if (data.containerId) drawById(data.containerId, 'C', '#cccccc', 0.28);

        const positionPoints = [
            { pos: data.sourcePos, label: 'S', color: '#66ccff' },
            { pos: data.standPos, label: 'ST', color: '#66ccff' },
            { pos: data.pickupPos, label: 'P', color: '#ffcc66' },
            { pos: data.dropoffPos, label: 'D', color: '#99ff99' },
            { pos: data.containerPos, label: 'C', color: '#cccccc' }
        ];
        for (let i = 0; i < positionPoints.length; i++) {
            const point = positionPoints[i];
            if (!point || !point.pos) continue;
            drawAtPos(point.pos, point.label, point.color, 0.28);
        }

        if (
            heap
            && data.queueStore
            && data.queueKey
            && drawn < MAX_PER_MISSION
            && lookup.used < lookup.max
        ) {
            const store = heap.getStore(data.queueStore, { ttl: null });
            const entry = store && store[data.queueKey];
            const ids = entry && Array.isArray(entry.ids) ? entry.ids : [];
            for (let i = 0; i < ids.length && i < MAX_QUEUE_IDS; i++) {
                drawById(ids[i], 'Q', '#ffdd88', 0.24);
                if (drawn >= MAX_PER_MISSION || lookup.used >= lookup.max) break;
            }
        }
    },

    visualize: function(room, missions, roomState) {
        const policyPhase = roomState && roomState.phase
            ? roomState.phase
            : (room && room._policy && room._policy.phase ? room._policy.phase : 'UNKNOWN');
        const policyState = roomState && roomState.state
            ? roomState.state
            : (room && room._policy && room._policy.state ? room._policy.state : 'UNKNOWN');
        const combatState = roomState && roomState.combat ? roomState.combat : 'UNKNOWN';
        const overallState = roomState && roomState.overall ? roomState.overall : 'UNKNOWN';

        let color = '#00ff00';
        if (overallState === 'SIEGE') color = 'red';
        else if (overallState === 'DEFENSE') color = '#ff6600';
        else if (overallState === 'WATCH') color = '#ffaa00';
        else if (policyState === 'CRITICAL') color = 'red';

        room.visual.text(
            `Phase: ${policyPhase} | Policy: ${policyState} | Overall: ${overallState} | Combat: ${combatState}`,
            1,
            1,
            { align: 'left', color: color, font: 0.7 }
        );
        room.visual.text(
            `RemotePathVis: ${Memory && Memory.debugVisualRemotePaths === true ? 'ON' : 'OFF'}`,
            1,
            1.8,
            { align: 'left', color: '#cfd8ff', font: 0.45 }
        );
        const REMOTE_PATH_DRAW_INTERVAL = 5;
        const drawRemotePaths = (Memory && Memory.debugVisualRemotePaths === true)
            && ((Game.time % REMOTE_PATH_DRAW_INTERVAL) === 0);
        this.drawCoreLaneV2Visuals(room);
        if (drawRemotePaths) this.drawMiningLaneV2Visuals(room);
        // ------------------------------------------------------------
        // Debug Visual: Remote Haul cached lanes (heap) with colors + legend
        // ------------------------------------------------------------
        if (heap && drawRemotePaths) {
            const MAX_DRAW = 20;
            const CROSS_ROOM = true;      // draw in remote rooms too
            const SHOW_ENDPOINTS = true;  // circles only (no on-tile text labels)

            function hash32(str) {
                let h = 2166136261;
                for (let i = 0; i < str.length; i++) {
                    h ^= str.charCodeAt(i);
                    h = Math.imul(h, 16777619);
                }
                return h >>> 0;
            }

            function colorFromKey(key) {
                const hue = hash32(key) % 360;
                return `hsl(${hue},80%,60%)`;
            }

            function shortKey(key) {
                if (!key) return '?';
                if (key.length <= 22) return key;
                return key.slice(0, 10) + '...' + key.slice(-10);
            }

            // Legend is drawn ONLY in the current room (top-right) to avoid text stacking on tiles.
            const LEGEND_X = 30;
            let legendY = 1.8;

            function legendRow(stroke, label) {
                room.visual.rect(LEGEND_X, legendY - 0.3, 0.35, 0.35, { fill: stroke, opacity: 0.9, stroke: 'transparent' });
                room.visual.text(label, LEGEND_X + 0.5, legendY, {
                    align: 'left',
                    color: '#ffffff',
                    font: 0.45,
                    stroke: '#000000',
                    strokeWidth: 0.15
                });
                legendY += 0.55;
            }

            function drawPackedLane(points, stroke) {
                if (!Array.isArray(points) || points.length < 2) return;

                const style = { width: 0.08, opacity: 0.75, lineStyle: 'dashed', stroke };

                // Draw per-room segments (RoomVisual cannot draw cross-room in one poly)
                for (let i = 1; i < points.length; i++) {
                    const a = points[i - 1];
                    const b = points[i];
                    if (!a || !b || !a.r || !b.r) continue;
                    if (a.r !== b.r) continue;

                    if (!CROSS_ROOM && a.r !== room.name) continue;

                    const rv = (a.r === room.name) ? room.visual : new RoomVisual(a.r);
                    rv.line(a.x, a.y, b.x, b.y, style);
                }

                if (!SHOW_ENDPOINTS) return;

                const first = points[0];
                const last = points[points.length - 1];

                if (first && first.r) {
                    const rv = (first.r === room.name) ? room.visual : new RoomVisual(first.r);
                    rv.circle(first.x, first.y, { radius: 0.22, fill: 'transparent', stroke, strokeWidth: 0.1, opacity: 0.9 });
                }
                if (last && last.r) {
                    const rv = (last.r === room.name) ? room.visual : new RoomVisual(last.r);
                    rv.circle(last.x, last.y, { radius: 0.22, fill: 'transparent', stroke, strokeWidth: 0.1, opacity: 0.9 });
                }
            }

            // Remote haul lanes heap store
            const store = heap.getStore('remoteHaul', { ttl: null });
            const home = store && store.rooms && store.rooms[room.name];
            const lanes = home && home.lanes;

            if (lanes) {
                const keys = Object.keys(lanes);
                const drawN = Math.min(keys.length, MAX_DRAW);

                room.visual.text(
                    `RemoteHaul lanes: ${keys.length} (draw ${drawN})`,
                    LEGEND_X,
                    1.1,
                    { align: 'left', color: '#aaccff', font: 0.5 }
                );

                for (let i = 0; i < drawN; i++) {
                    const k = keys[i];
                    const e = lanes[k];
                    if (!e || !e.p || !e.p.length) continue;

                    const stroke = colorFromKey(k);
                    const extra = e.len ? ` len=${e.len}` : '';
                    legendRow(stroke, `${shortKey(k)}${extra}`);

                    drawPackedLane(e.p, stroke);
                }
            }
        }

        let y = 2.7;
        const visualMissions = this.getLiveBoardVisualMissions(room, missions);
        const byState = Object.create(null);
        const byStage = Object.create(null);
        for (let i = 0; i < visualMissions.length; i++) {
            const mission = visualMissions[i];
            const state = mission && mission.state ? mission.state : 'unknown';
            byState[state] = (byState[state] || 0) + 1;
            const stage = mission && mission.progress && mission.progress.stage ? mission.progress.stage : null;
            if (stage) byStage[stage] = (byStage[stage] || 0) + 1;
        }
        const missionStateSummary = Object.keys(byState).sort().map(k => `${k}:${byState[k]}`);
        if (missionStateSummary.length > 0) {
            room.visual.text(
                `Mission states: ${missionStateSummary.join(' | ')}`,
                1,
                y,
                { align: 'left', color: '#ffd27f', font: 0.45 }
            );
            y += 0.8;
        }
        const missionStageSummary = Object.keys(byStage).sort().map(k => `${k}:${byStage[k]}`);
        if (missionStageSummary.length > 0) {
            room.visual.text(
                `Mission stages: ${missionStageSummary.join(' | ')}`,
                1,
                y,
                { align: 'left', color: '#a7d3ff', font: 0.42 }
            );
            y += 0.8;
        }
        const getFleetCounts = (type) => {
            const m = visualMissions.find(m => m.type === type);
            if (!m) return null;
            const progress = this.getMissionProgress(m);
            return {
                summary: progress.summary
            };
        };
        const workerFleet = getFleetCounts('worker_fleet');
        const remoteWorkerFleet = getFleetCounts('remote_worker_fleet');
        const haulerFleet = getFleetCounts('hauler_fleet');
        const remoteHaulerFleet = getFleetCounts('remote_hauler_fleet');
        const fleetParts = [];
        if (workerFleet) fleetParts.push(`worker ${workerFleet.summary}`);
        if (remoteWorkerFleet) fleetParts.push(`remote_worker ${remoteWorkerFleet.summary}`);
        if (haulerFleet) fleetParts.push(`hauler ${haulerFleet.summary}`);
        if (remoteHaulerFleet) fleetParts.push(`remote_hauler ${remoteHaulerFleet.summary}`);
        if (fleetParts.length > 0) {
            room.visual.text(
                `Fleet: ${fleetParts.join(' | ')}`,
                1,
                y,
                { align: 'left', color: '#aaccff', font: 0.5 }
            );
            y += 0.9;
        }
        const sortedMissions = [...visualMissions].sort((a, b) => b.priority - a.priority);
        const lookupState = { used: 0, max: 80 };
        sortedMissions.forEach(m => {
            const progress = this.getMissionProgress(m);
            const missionState = m && m.state ? m.state : 'active';
            const stage = m && m.progress && m.progress.stage ? m.progress.stage : null;
            const goalState = m && m.progress && m.progress.goalState ? m.progress.goalState : null;
            const color = this.getMissionVisualColor(missionState, progress.filled);
            let line = `[${m.priority}] [${missionState}] ${m.name} (${progress.summary})`;
            if (stage) line += ` stg=${stage}`;
            if (goalState) line += ` goal=${goalState}`;
            room.visual.text(line, 1, y, {align: 'left', font: 0.6, color: color});
            y += 1.0;

            if (m.pos) {
                let label = `${m.type}${(m.type === 'harvest' || m.type === 'simple_harvest') && m.data && m.data.mode ? ` (${m.data.mode})` : ''}`;
                if (m.type === 'mineral' && m.data && m.data.resourceType) {
                    label += ` (${m.data.resourceType})`;
                }
                label += `\n${progress.short}`;
                room.visual.text(label, m.pos.x, m.pos.y - 0.5, { font: 0.3, color: color, stroke: '#000000', strokeWidth: 0.15, align: 'center' });
                if (m.type === 'harvest' || m.type === 'simple_harvest' || m.type === 'mineral') {
                    room.visual.circle(m.pos, {fill: 'transparent', radius: 0.7, stroke: color, strokeWidth: 0.1, lineStyle: 'dashed'});
                }
            }
            this.drawMissionWorksites(room, m, color, lookupState);
        });
    }
};

module.exports = overseerUtils;



