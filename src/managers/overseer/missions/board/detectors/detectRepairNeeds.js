const overseerOpportunisticRepair = require('managers_overseer_intel_overseer.opportunistic.repair');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

const FORTIFY_TARGET_CAP = 3;

function run({ room, intel, context, missionBoard }) {
    if (!room || !missionBoard) return;
    if (context && context.opState === 'EMERGENCY') return;
    if (!missionThrottle.shouldRunDetector('repair', room.name, Game.time)) return;

    const scan = overseerOpportunisticRepair.getRoomScan(room.name);
    if (!scan) return;

    const repairIds = Array.isArray(scan.repairIds) ? scan.repairIds : [];
    for (let i = 0; i < repairIds.length; i++) {
        const id = repairIds[i];
        missionBoard.createMission('repair', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            targetId: id,
            fortify: false,
            priority: 65
        }, { room, intel, context });
    }

    const fortifyPolicy = room.memory && room.memory.overseer && room.memory.overseer.fortifyPolicy
        ? room.memory.overseer.fortifyPolicy
        : null;
    const targetHits = Number.isFinite(fortifyPolicy && fortifyPolicy.target) ? fortifyPolicy.target : null;
    const economyState = context && context.economyState ? context.economyState : 'STOCKPILING';
    const allowFortifySpawn = economyState === 'UPGRADING' || !!scan.critical;

    const fortifyIds = Array.isArray(scan.fortifyIds) ? scan.fortifyIds : [];
    const cap = Math.max(1, FORTIFY_TARGET_CAP);
    for (let i = 0; i < Math.min(cap, fortifyIds.length); i++) {
        const id = fortifyIds[i];
        missionBoard.createMission('repair', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            targetId: id,
            fortify: true,
            targetHits,
            spawnAllowed: allowFortifySpawn,
            priority: allowFortifySpawn ? 55 : 35
        }, { room, intel, context });
    }
}

module.exports = {
    type: 'repair',
    run
};
