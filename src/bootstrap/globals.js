var registerRoomCache = require('utils_roomCache');

module.exports = function registerGlobals() {
    registerRoomCache();
    if (typeof global.DEBUG_TASKS === 'undefined') {
        global.DEBUG_TASKS = false;
    }
};
