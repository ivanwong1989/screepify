/**
 * Overseer Utils Module
 * Handles census, worker reassignment, and visualization.
 */
const overseerUtils = {
    analyzeCensus: function(missions, creeps) {
        // Informational only: used for UI/debug and mission logic that depends on "currently assigned".
        // Spawn planning must rely on contract/ticket census, not mission.census.
        const missionMap = {};
        const roleMissions = {};

        missions.forEach(m => {
            if (m.censusLocked && m.census) {
                m.census = {
                    count: m.census.count || 0,
                    workParts: m.census.workParts || 0,
                    carryParts: m.census.carryParts || 0
                };
            } else {
                m.census = { count: 0, workParts: 0, carryParts: 0 };
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

            if (memory.missionName && missionMap[memory.missionName]) {
                const m = missionMap[memory.missionName];
                // Avoid double-counting roleCensus missions through missionName.
                if (!m.censusLocked && !m.roleCensus) {
                    m.census.count++;
                    m.census.workParts += workParts;
                    m.census.carryParts += carryParts;
                }
            }
            if (memory.role && roleMissions[memory.role]) {
                roleMissions[memory.role].forEach(m => {
                    if (m.censusLocked) return;
                    m.census.count++;
                    m.census.workParts += workParts;
                    m.census.carryParts += carryParts;
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
                        const required = buildMission.requirements ? buildMission.requirements.count : 0;
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
                     if (mission.name === 'decongest:parking' || mission.type === 'hauler_fleet' || mission.type === 'remote_hauler_fleet' || mission.type === 'worker_fleet' || mission.type === 'remote_worker_fleet' || !mission.requirements || !mission.requirements.count) continue;
                     const deficit = mission.requirements.count - (mission.census ? mission.census.count : 0);
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
        let y = 2.5;
        const getFleetCounts = (type) => {
            const m = missions.find(m => m.type === type);
            if (!m) return null;
            return {
                have: m.census ? m.census.count : 0,
                need: m.requirements ? m.requirements.count : 0
            };
        };
        const workerFleet = getFleetCounts('worker_fleet');
        const remoteWorkerFleet = getFleetCounts('remote_worker_fleet');
        const haulerFleet = getFleetCounts('hauler_fleet');
        const remoteHaulerFleet = getFleetCounts('remote_hauler_fleet');
        const fleetParts = [];
        if (workerFleet) fleetParts.push(`worker ${workerFleet.have}/${workerFleet.need}`);
        if (remoteWorkerFleet) fleetParts.push(`remote_worker ${remoteWorkerFleet.have}/${remoteWorkerFleet.need}`);
        if (haulerFleet) fleetParts.push(`hauler ${haulerFleet.have}/${haulerFleet.need}`);
        if (remoteHaulerFleet) fleetParts.push(`remote_hauler ${remoteHaulerFleet.have}/${remoteHaulerFleet.need}`);
        if (fleetParts.length > 0) {
            room.visual.text(
                `Fleet: ${fleetParts.join(' | ')}`,
                1,
                y,
                { align: 'left', color: '#aaccff', font: 0.5 }
            );
            y += 0.6;
        }
        const sortedMissions = [...missions].sort((a, b) => b.priority - a.priority);
        sortedMissions.forEach(m => {
            const assigned = m.census ? m.census.count : 0;
            const required = m.requirements ? m.requirements.count : 0;
            const filled = assigned >= required;
            const color = filled ? '#aaffaa' : '#ffaaaa';
            room.visual.text(`[${m.priority}] ${m.name} (${assigned}/${required})`, 1, y, {align: 'left', font: 0.4, color: color});
            y += 0.6;

            if (m.pos) {
                let label = `${m.type}${m.type === 'harvest' && m.data && m.data.mode ? ` (${m.data.mode})` : ''}`;
                if (m.type === 'mineral' && m.data && m.data.resourceType) {
                    label += ` (${m.data.resourceType})`;
                }
                label += `\n${assigned}/${required}`;
                room.visual.text(label, m.pos.x, m.pos.y - 0.5, { font: 0.3, color: color, stroke: '#000000', strokeWidth: 0.15, align: 'center' });
                if (m.type === 'harvest' || m.type === 'mineral') {
                    room.visual.circle(m.pos, {fill: 'transparent', radius: 0.7, stroke: color, strokeWidth: 0.1, lineStyle: 'dashed'});
                } 
            } else if (m.type === 'build' || m.type === 'repair') {
                const targetIds = m.targetId ? [m.targetId] : (m.targetIds || []);
                targetIds.forEach(id => {
                    const target = Game.getObjectById(id);
                    if (target) room.visual.text(`🔨 ${assigned}/${required}`, target.pos.x, target.pos.y, { font: 0.3, color: color, stroke: '#000000', strokeWidth: 0.15 });
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
