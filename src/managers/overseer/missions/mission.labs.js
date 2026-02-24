const managerLabs = require('managers_structures_manager.labs');

module.exports = {
    generate: function(room, intel, context, missions) {
        const labMissions = managerLabs.getLogisticsMissions(room);
        if (!labMissions || labMissions.length === 0) return;
        for (const mission of labMissions) missions.push(mission);
    }
};
