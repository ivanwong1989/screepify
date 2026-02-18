module.exports = function registerConsole() {
    require('console_debug')();
    require('console_market')();
    require('console_remote')();
    require('console_economy')();
    require('console_allies')();
    require('console_mission')();
    require('console_attack')();
    require('console_help')();
};
