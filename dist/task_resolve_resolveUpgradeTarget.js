'use strict';

module.exports = function resolveUpgradeTarget(room, intel) {
    if (room && room.controller && room.controller.my) {
        return room.controller.id;
    }
    return null;
};
