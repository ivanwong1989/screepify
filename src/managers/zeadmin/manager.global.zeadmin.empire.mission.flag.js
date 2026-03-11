const empireBoard = require('managers_zeadmin_manager.global.zeadmin.empire.board');

const FLAG_NAME = 'Empire1';
const MISSION_ID = `empire:flag:${FLAG_NAME}`;

function listOwnedSpawnRooms() {
    const out = [];
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) continue;
        const spawns = room.find(FIND_MY_SPAWNS);
        if (spawns && spawns.length > 0) out.push(room.name);
    }
    return out;
}

function resolveNearestSponsorRoom(targetRoom) {
    const owned = listOwnedSpawnRooms();
    if (owned.length === 0) return null;
    if (!targetRoom) return owned[0];

    let best = owned[0];
    let bestDist = Infinity;
    for (let i = 0; i < owned.length; i++) {
        const roomName = owned[i];
        const dist = Game.map.getRoomLinearDistance(roomName, targetRoom);
        if (dist < bestDist) {
            best = roomName;
            bestDist = dist;
        }
    }
    return best;
}

module.exports = {
    sync: function() {
        const flag = Game.flags[FLAG_NAME];
        if (!flag) {
            empireBoard.remove(MISSION_ID);
            return { present: false, missionId: MISSION_ID };
        }

        const sponsorRoom = resolveNearestSponsorRoom(flag.pos.roomName);
        const canSpawn = !!sponsorRoom;

        const mission = {
            id: MISSION_ID,
            scope: 'empire',
            owner: 'zeadmin',
            type: 'empire_move_flag',
            priority: 65,
            archetype: 'empire_universal',
            sponsorRoom,
            requirements: {
                archetype: 'empire_universal',
                minCount: 1,
                maxCount: 1,
                // Control-only mode when there is no spawn infrastructure.
                // Existing empire creeps remain assignable/executable.
                spawn: canSpawn
            },
            targetPos: {
                x: flag.pos.x,
                y: flag.pos.y,
                roomName: flag.pos.roomName
            },
            data: {
                flagName: FLAG_NAME,
                missionTag: `flag_${FLAG_NAME}`,
                targetRoom: flag.pos.roomName
            }
        };

        empireBoard.upsert(mission);
        return { present: true, missionId: MISSION_ID, sponsorRoom, canSpawn };
    }
};
