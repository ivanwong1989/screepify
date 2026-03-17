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

    getRequiredHeadcount: function(mission) {
        if (!mission || !mission.requirements) return 0;
        const req = mission.requirements;
        if (Number.isFinite(req.maxCount)) return req.maxCount;
        if (Number.isFinite(req.minCount)) return req.minCount;

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
        const census = mission && mission.census ? mission.census : {};
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
        const assigned = Math.max(0, census.count || 0);
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
        const creepsByMission = Object.create(null);
        intel.myCreeps.forEach(c => {
            const memory = c.memory || {};
            const missionName = memory.missionName;
            if (missionName) {
                if (!creepsByMission[missionName]) creepsByMission[missionName] = [];
                creepsByMission[missionName].push(c);
            }
        });

        const missionsByName = Object.create(null);
        missions.forEach(m => { missionsByName[m.name] = m; });

        const moveCreeps = (fromMissionName, toMission, count) => {
            if (!toMission || count <= 0) return 0;
            const fromCreeps = creepsByMission[fromMissionName];
            if (!fromCreeps || fromCreeps.length === 0) return 0;
            let moved = 0;
            const toCreeps = creepsByMission[toMission.name] || (creepsByMission[toMission.name] = []);
            while (moved < count && fromCreeps.length > 0) {
                const creep = fromCreeps.pop();
                const memory = creep.memory || {};
                memory.missionName = toMission.name;
                delete memory.task;
                memory.taskState = 'init';
                const fromMission = missionsByName[fromMissionName];
                if (fromMission && fromMission.census) fromMission.census.count--;
                if (toMission.census) toMission.census.count++;
                toCreeps.push(creep);
                moved++;
            }
            return moved;
        };

        if (intel.constructionSites.length > 0) {
            const buildMissions = missions.filter(m => m.type === 'build');
            const upgradeMission = missionsByName['upgrade:controller'];
            if (buildMissions.length > 0 && upgradeMission) {
                const upgraders = creepsByMission['upgrade:controller'] || [];
                let available = upgraders.length - 1;
                if (available > 0) {
                    const sortedBuilds = [...buildMissions].sort((a, b) => (b.priority || 0) - (a.priority || 0));
                    for (const buildMission of sortedBuilds) {
                        if (available <= 0) break;
                        const required = this.getRequiredHeadcount(buildMission);
                        const assigned = buildMission.census ? buildMission.census.count : 0;
                        const deficit = Math.max(0, required - assigned);
                        if (deficit <= 0) continue;
                        const moved = moveCreeps('upgrade:controller', buildMission, Math.min(deficit, available));
                        available -= moved;
                    }
                }
            }
        }

        const parkingMission = missionsByName['decongest:parking'];
        if (parkingMission && parkingMission.census && parkingMission.census.count > 0) {
             const parkedCreeps = creepsByMission['decongest:parking'] || [];
             let parkedTotal = parkedCreeps.length;
             if (parkedTotal > 0) {
                 const parkedByRole = Object.create(null);
                 parkedCreeps.forEach(c => {
                     const role = c.memory && c.memory.role;
                     if (!role) return;
                     if (!parkedByRole[role]) parkedByRole[role] = [];
                     parkedByRole[role].push(c);
                 });
                 const sortedMissions = [...missions].sort((a, b) => b.priority - a.priority);
                 for (const mission of sortedMissions) {
                     if (parkedTotal === 0) break;
                     if (mission.name === 'decongest:parking' || mission.type === 'hauler_fleet' || mission.type === 'remote_hauler_fleet' || mission.type === 'worker_fleet' || mission.type === 'remote_worker_fleet' || !mission.requirements) continue;
                     const required = this.getRequiredHeadcount(mission);
                     if (required <= 0) continue;
                     const deficit = required - (mission.census ? mission.census.count : 0);
                     if (deficit > 0) {
                         const role = mission.requirements.archetype;
                         const candidates = parkedByRole[role];
                         if (!candidates || candidates.length === 0) continue;
                         let movedCount = 0;
                         const toCreeps = creepsByMission[mission.name] || (creepsByMission[mission.name] = []);
                         while (movedCount < deficit && candidates.length > 0) {
                             const creep = candidates.pop();
                             const memory = creep.memory || {};
                             memory.missionName = mission.name;
                             delete memory.task;
                             memory.taskState = 'init';
                             if (parkingMission.census) parkingMission.census.count--;
                             if (mission.census) mission.census.count++;
                             toCreeps.push(creep);
                             parkedTotal--;
                             const list = creepsByMission['decongest:parking'];
                             if (list) {
                                 const index = list.indexOf(creep);
                                 if (index !== -1) {
                                     const last = list.length - 1;
                                     if (index !== last) list[index] = list[last];
                                     list.pop();
                                 }
                             }
                             movedCount++;
                         }
                     }
                 }
             }
        }
    },

    getLiveBoardVisualMissions: function(room, contractMissions) {
        if (!room || !missionBoard || typeof missionBoard.listLiveByRoom !== 'function') return [];
        const contracts = Array.isArray(contractMissions) ? contractMissions : [];
        const existingNames = new Set(contracts.map(m => m && m.name).filter(Boolean));

        const live = missionBoard.listLiveByRoom(room.name) || [];
        const boardVisuals = [];

        for (let i = 0; i < live.length; i++) {
            const m = live[i];
            if (!m) continue;
            if (m.class === 'finite') continue;

            const missionName =
                (m.meta && m.meta.missionName) ||
                m.name ||
                m.id ||
                `${m.type}:${room.name}`;

            if (existingNames.has(missionName)) continue;

            const assigned = m.assigned && Array.isArray(m.assigned.primary)
                ? m.assigned.primary.length
                : 0;
            const desired = Number.isFinite(m.meta && m.meta.desiredCount)
                ? Math.max(0, m.meta.desiredCount)
                : Number.isFinite(m.demand && m.demand.count)
                    ? Math.max(assigned, m.demand.count + assigned)
                    : Math.max(1, assigned);

            boardVisuals.push({
                name: missionName,
                type: m.type,
                priority: Number.isFinite(m.priority) ? m.priority : 0,
                requirements: { minCount: desired, maxCount: desired },
                census: { count: assigned, workParts: 0, carryParts: 0, claimParts: 0 },
                __fromBoard: true
            });
        }

        return boardVisuals;
    },

    visualize: function(room, missions, roomState) {
        const opsState = roomState && roomState.ops ? roomState.ops : 'UNKNOWN';
        const economyState = roomState && roomState.economy ? roomState.economy : 'UNKNOWN';
        const combatState = roomState && roomState.combat ? roomState.combat : 'UNKNOWN';
        const overallState = roomState && roomState.overall ? roomState.overall : 'UNKNOWN';

        let color = '#00ff00';
        if (overallState === 'SIEGE') color = 'red';
        else if (overallState === 'DEFENSE') color = '#ff6600';
        else if (overallState === 'WATCH') color = '#ffaa00';
        else if (opsState === 'EMERGENCY') color = 'red';

        room.visual.text(
            `State: ${overallState} | Ops: ${opsState} | Combat: ${combatState} | Eco: ${economyState}`,
            1,
            1,
            { align: 'left', color: color, font: 0.7 }
        );
        this.drawCoreLaneV2Visuals(room);
        // ------------------------------------------------------------
        // Debug Visual: Remote Haul cached lanes (heap) with colors + legend
        // ------------------------------------------------------------
        if (heap) {
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
                return key.slice(0, 10) + '…' + key.slice(-10);
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

        let y = 2.5;
        const getFleetCounts = (type) => {
            const m = missions.find(m => m.type === type);
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
            y += 1.0;
        }
        const boardLiveVisuals = this.getLiveBoardVisualMissions(room, missions);
        const visualMissions = (Array.isArray(missions) ? missions : []).concat(boardLiveVisuals);
        const sortedMissions = [...visualMissions].sort((a, b) => b.priority - a.priority);
        sortedMissions.forEach(m => {
            const progress = this.getMissionProgress(m);
            const filled = progress.filled;
            const color = filled ? '#aaffaa' : '#ffaaaa';
            const prefix = m.__fromBoard ? '[B]' : '';
            room.visual.text(`${prefix}[${m.priority}] ${m.name} (${progress.summary})`, 1, y, {align: 'left', font: 0.7, color: color});
            y += 1.0;

            if (m.pos) {
                let label = `${m.type}${m.type === 'harvest' && m.data && m.data.mode ? ` (${m.data.mode})` : ''}`;
                if (m.type === 'mineral' && m.data && m.data.resourceType) {
                    label += ` (${m.data.resourceType})`;
                }
                label += `\n${progress.short}`;
                room.visual.text(label, m.pos.x, m.pos.y - 0.5, { font: 0.3, color: color, stroke: '#000000', strokeWidth: 0.15, align: 'center' });
                if (m.type === 'harvest' || m.type === 'mineral') {
                    room.visual.circle(m.pos, {fill: 'transparent', radius: 0.7, stroke: color, strokeWidth: 0.1, lineStyle: 'dashed'});
                } 
            } else if (m.type === 'build' || m.type === 'repair') {
                const targetIds = m.targetId ? [m.targetId] : (m.targetIds || []);
                targetIds.forEach(id => {
                    const target = Game.getObjectById(id);
                    if (target) room.visual.text(`🔨 ${progress.short}`, target.pos.x, target.pos.y, { font: 0.3, color: color, stroke: '#000000', strokeWidth: 0.15 });
                });
            } else if (m.type === 'decongest') {
                if (m.targetIds) {
                    m.targetIds.forEach(id => {
                        const target = Game.getObjectById(id);
                        if (target) room.visual.text(`🅿️`, target.pos.x, target.pos.y, { font: 0.5, color: '#ffffff', stroke: '#000000', strokeWidth: 0.15 });
                    });
                }
                if (m.targetNames) {
                    m.targetNames.forEach(name => {
                        const target = Game.flags[name];
                        if (target && target.pos.roomName === room.name) room.visual.text(`🅿️`, target.pos.x, target.pos.y, { font: 0.5, color: '#ffffff', stroke: '#000000', strokeWidth: 0.15 });
                    });
                }
            }
        });
    }
};

module.exports = overseerUtils;

