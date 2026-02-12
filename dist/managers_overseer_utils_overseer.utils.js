/**
 * Overseer Utils Module
 * Handles census, worker reassignment, and visualization.
 */
const overseerUtils = {
    analyzeCensus: function(missions, creeps) {
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
            if (c.memory.missionName && missionMap[c.memory.missionName]) {
                const m = missionMap[c.memory.missionName];
                if (!m.censusLocked) {
                    m.census.count++;
                    m.census.workParts += c.getActiveBodyparts(WORK);
                    m.census.carryParts += c.getActiveBodyparts(CARRY);
                }
            }
            if (c.memory.role && roleMissions[c.memory.role]) {
                roleMissions[c.memory.role].forEach(m => {
                    if (m.censusLocked) return;
                    m.census.count++;
                    m.census.workParts += c.getActiveBodyparts(WORK);
                    m.census.carryParts += c.getActiveBodyparts(CARRY);
                });
            }
        });
    },

    reassignWorkers: function(room, missions, intel) {
        const moveCreeps = (fromMissionName, toMission, count) => {
            if (!toMission || count <= 0) return 0;
            const fromCreeps = intel.myCreeps.filter(c => c.memory.missionName === fromMissionName);
            let moved = 0;
            for (let creep of fromCreeps) {
                if (moved >= count) break;
                creep.memory.missionName = toMission.name;
                delete creep.memory.task;
                creep.memory.taskState = 'init';
                const fromMission = missions.find(m => m.name === fromMissionName);
                if (fromMission && fromMission.census) fromMission.census.count--;
                if (toMission.census) toMission.census.count++;
                moved++;
            }
            return moved;
        };

        if (intel.constructionSites.length > 0) {
            const buildMissions = missions.filter(m => m.type === 'build');
            const upgradeMission = missions.find(m => m.name === 'upgrade:controller');
            if (buildMissions.length > 0 && upgradeMission) {
                const upgraders = intel.myCreeps.filter(c => c.memory.missionName === 'upgrade:controller');
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

        const parkingMission = missions.find(m => m.name === 'decongest:parking');
        if (parkingMission && parkingMission.census && parkingMission.census.count > 0) {
             const parkedCreeps = intel.myCreeps.filter(c => c.memory.missionName === 'decongest:parking');
             const sortedMissions = [...missions].sort((a, b) => b.priority - a.priority);
             for (const mission of sortedMissions) {
                 if (parkedCreeps.length === 0) break;
                 if (mission.name === 'decongest:parking' || mission.type === 'hauler_fleet' || mission.type === 'worker_fleet' || !mission.requirements || !mission.requirements.count) continue;
                 const deficit = mission.requirements.count - (mission.census ? mission.census.count : 0);
                 if (deficit > 0) {
                     const candidates = parkedCreeps.filter(c => c.memory.role === mission.requirements.archetype);
                     let movedCount = 0;
                     for (const creep of candidates) {
                         if (movedCount >= deficit) break;
                         creep.memory.missionName = mission.name;
                         delete creep.memory.task;
                         creep.memory.taskState = 'init';
                         if (parkingMission.census) parkingMission.census.count--;
                         if (mission.census) mission.census.count++;
                         parkedCreeps.splice(parkedCreeps.indexOf(creep), 1);
                         movedCount++;
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
