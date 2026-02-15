var userMissions = require('userMissions');
var shared = require('console_shared');

function formatMissionTarget(pos, targetRoom) {
    if (pos && pos.roomName !== undefined && pos.x !== undefined && pos.y !== undefined) {
        return `${pos.roomName}:${pos.x},${pos.y}`;
    }
    if (targetRoom) return targetRoom;
    return 'n/a';
}

function listUserMissions() {
    const all = userMissions.getAll();
    if (all.length === 0) {
        console.log('No user missions.');
        return 'No user missions.';
    }
    console.log(`User missions (${all.length}):`);
    for (const m of all) {
        const enabled = m.enabled === false ? 'off' : 'on';
        const target = formatMissionTarget(m.targetPos, m.targetRoom);
        const sponsor = m.sponsorRoom || '(auto)';
        const label = m.label ? ` label="${m.label}"` : '';
        console.log(`${m.id} type=${m.type} ${enabled} sponsor=${sponsor} target=${target} priority=${m.priority}${label}`);
    }
    return `Listed ${all.length} user missions.`;
}

function showMissionHelp() {
    const defs = userMissions.getDefinitions();
    const types = Object.keys(defs);
    const lines = [
        'mission()                         - show this help',
        'mission(\"types\")                  - list available user mission types',
        'mission(\"list\")                   - list user missions',
        'mission(\"add\",\"dismantle\", room, x, y, sponsorRoom?, priority?, persist?, label?)',
        'mission(\"add\",\"dismantle\", { roomName, x, y, sponsorRoom, priority, persist, label })',
        'mission(\"add\",\"drainer\", roomName, x?, y?, sponsorRoom?, priority?, persist?, label?)',
        'mission(\"add\",\"drainer\", { roomName, x, y, sponsorRoom, priority, persist, label })',
        'mission(\"add\",\"reserve\", roomName, sponsorRoom?, priority?, persist?, label?)',
        'mission(\"add\",\"reserve\", { roomName, sponsorRoom, priority, persist, label })',
        'mission(\"add\",\"transfer\", sourceId, targetId, resourceType?, sponsorRoom?, priority?, persist?, label?)',
        'mission(\"add\",\"transfer\", { sourceId, targetId, resourceType, sponsorRoom, priority, persist, label, sourceRoom, targetRoom })',
        'mission(\"set\", id, { sponsorRoom, priority, persist, label, x, y, roomName, targetRoom, sourceId, targetId, resourceType, sourceRoom })',
        'mission(\"enable\", id) / mission(\"disable\", id)',
        'mission(\"remove\", id)',
        `available types: ${types.join(', ') || '(none)'}`
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

function normalizeMissionPatch(patch) {
    if (!patch || typeof patch !== 'object') return null;
    const next = {};
    if ('enabled' in patch) next.enabled = patch.enabled === false ? false : true;
    if ('priority' in patch) {
        const priority = Number(patch.priority);
        if (Number.isFinite(priority)) next.priority = priority;
    }
    if ('sponsorRoom' in patch) {
        const sponsor = userMissions.normalizeRoomName(patch.sponsorRoom);
        next.sponsorRoom = sponsor || null;
    }
    if ('persist' in patch) {
        const raw = patch.persist;
        const persist = (raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'yes' || raw === 'y');
        next.persist = persist;
    }
    if ('label' in patch) next.label = patch.label ? ('' + patch.label).trim() : '';
    if ('targetId' in patch) next.targetId = patch.targetId ? ('' + patch.targetId).trim() : null;
    if ('sourceId' in patch) next.sourceId = patch.sourceId ? ('' + patch.sourceId).trim() : null;
    if ('resourceType' in patch) next.resourceType = patch.resourceType ? ('' + patch.resourceType).trim() : null;
    if ('sourceRoom' in patch) {
        const sourceRoom = userMissions.normalizeRoomName(patch.sourceRoom);
        next.sourceRoom = sourceRoom || null;
    }
    if ('roomName' in patch || 'targetRoom' in patch) {
        const targetRoom = userMissions.normalizeRoomName(patch.roomName || patch.targetRoom);
        next.targetRoom = targetRoom || null;
    }

    const posInput = patch.targetPos || patch.pos || patch.target || patch;
    const pos = userMissions.normalizeTargetPos(posInput);
    if (pos) {
        next.targetPos = pos;
        if (!next.targetRoom) next.targetRoom = pos.roomName;
    }

    return next;
}

module.exports = function registerMissionConsole() {
    global.mission = function(action, typeOrData, ...args) {
        const cmd = action ? ('' + action).trim().toLowerCase() : 'help';
        if (!cmd || cmd === 'help' || cmd === 'h') return showMissionHelp();

        if (cmd === 'types') {
            const defs = userMissions.getDefinitions();
            const keys = Object.keys(defs);
            if (keys.length === 0) return 'No mission types registered.';
            for (const key of keys) {
                const def = defs[key];
                const req = (def.required || []).join(', ');
                const opt = (def.optional || []).join(', ');
                console.log(`${key}: ${def.label || ''} required=[${req}] optional=[${opt}]`);
            }
            return `Types: ${keys.join(', ')}`;
        }

        if (cmd === 'list' || cmd === 'ls') {
            return listUserMissions();
        }

        if (cmd === 'add') {
            let type = null;
            let data = null;
            if (typeOrData && typeof typeOrData === 'object') {
                data = typeOrData;
                type = data.type;
            } else {
                type = typeOrData;
            }
            const key = type ? ('' + type).trim().toLowerCase() : '';
            if (!key) return 'Usage: mission(\"add\", \"dismantle\", room, x, y, sponsorRoom?, priority?, persist?, label?) OR mission(\"add\", \"drainer\", roomName, x?, y?, sponsorRoom?, priority?, persist?, label?) OR mission(\"add\", \"reserve\", roomName, sponsorRoom?, priority?, persist?, label?)';

            if (!data) {
                if (key === 'dismantle') {
                    data = {
                        roomName: args[0],
                        x: args[1],
                        y: args[2],
                        sponsorRoom: args[3],
                        priority: args[4],
                        persist: args[5],
                        label: args[6]
                    };
                } else if (key === 'drainer') {
                    data = {
                        roomName: args[0],
                        x: args[1],
                        y: args[2],
                        sponsorRoom: args[3],
                        priority: args[4],
                        persist: args[5],
                        label: args[6]
                    };
                } else if (key === 'reserve') {
                    data = {
                        roomName: args[0],
                        sponsorRoom: args[1],
                        priority: args[2],
                        persist: args[3],
                        label: args[4]
                    };
                } else if (key === 'transfer') {
                    data = {
                        sourceId: args[0],
                        targetId: args[1],
                        resourceType: args[2],
                        sponsorRoom: args[3],
                        priority: args[4],
                        persist: args[5],
                        label: args[6]
                    };
                } else {
                    data = {};
                }
            }

            if (key === 'dismantle') {
                const targetPos = userMissions.normalizeTargetPos(data.targetPos || data);
                if (targetPos) {
                    if (!data.sponsorRoom) {
                        const sponsorRoom = shared.resolveSponsorRoomForTargetPos(targetPos);
                        if (sponsorRoom) data.sponsorRoom = sponsorRoom;
                    }
                    if (!data.targetId) {
                        const targetId = shared.tryResolveTargetIdForPos(targetPos);
                        if (targetId) data.targetId = targetId;
                    }
                }
            } else if (key === 'drainer') {
                const targetPos = userMissions.normalizeTargetPos(data.targetPos || data);
                if (targetPos) {
                    data.targetPos = targetPos;
                    if (!data.roomName) data.roomName = targetPos.roomName;
                }
                if (!data.sponsorRoom) {
                    const sponsorRoom = targetPos
                        ? shared.resolveSponsorRoomForTargetPos(targetPos)
                        : shared.resolveSponsorRoomForTargetRoom(data.roomName || data.targetRoom);
                    if (sponsorRoom) data.sponsorRoom = sponsorRoom;
                }
            } else if (key === 'reserve') {
                if (!data.sponsorRoom) {
                    const sponsorRoom = shared.resolveSponsorRoomForTargetRoom(data.roomName || data.targetRoom);
                    if (sponsorRoom) data.sponsorRoom = sponsorRoom;
                }
            } else if (key === 'transfer') {
                if (!data.sponsorRoom) {
                    const sponsorRoom = shared.resolveSponsorRoomForTransfer(data.sourceId, data.targetId);
                    if (sponsorRoom) data.sponsorRoom = sponsorRoom;
                }
                if (!data.targetRoom) {
                    const targetRoom = shared.resolveRoomNameForObjectId(data.targetId);
                    if (targetRoom) data.targetRoom = targetRoom;
                }
                if (!data.sourceRoom) {
                    const sourceRoom = shared.resolveRoomNameForObjectId(data.sourceId);
                    if (sourceRoom) data.sourceRoom = sourceRoom;
                }
            }

            const result = userMissions.addMission(key, data);
            if (result && result.error) return result.error;
            const mission = result.mission;
            console.log(`Added mission ${mission.id} type=${mission.type} target=${formatMissionTarget(mission.targetPos, mission.targetRoom)}`);
            return mission.id;
        }

        if (cmd === 'set' || cmd === 'update') {
            const id = typeOrData ? ('' + typeOrData).trim() : '';
            const patch = normalizeMissionPatch(args[0]);
            if (!id || !patch) return 'Usage: mission(\"set\", id, { sponsorRoom, priority, persist, label, x, y, roomName, targetRoom })';
            const updated = userMissions.updateMission(id, patch);
            if (!updated) return `Unknown mission id: ${id}`;
            return `Updated mission ${id}`;
        }

        if (cmd === 'enable' || cmd === 'disable') {
            const id = typeOrData ? ('' + typeOrData).trim() : '';
            if (!id) return `Usage: mission(\"${cmd}\", id)`;
            const updated = userMissions.updateMission(id, { enabled: cmd === 'enable' });
            if (!updated) return `Unknown mission id: ${id}`;
            return `${cmd}d mission ${id}`;
        }

        if (cmd === 'remove' || cmd === 'rm' || cmd === 'del') {
            const id = typeOrData ? ('' + typeOrData).trim() : '';
            if (!id) return 'Usage: mission(\"remove\", id)';
            const removed = userMissions.removeMission(id);
            return removed ? `Removed mission ${id}` : `Unknown mission id: ${id}`;
        }

        return showMissionHelp();
    };
};
