const assault = require('managers_admiral_tactics_assault_index');

module.exports = {
    runAssault: function(creep, mission, context) {
        return assault.runAssault(creep, mission, context);
    },
    executeAssault: function(creep, mission, context) {
        return assault.executeAssault(creep, mission, context);
    },
    planForPair: function(mission, leader, support, context) {
        return assault.planForPair(mission, leader, support, context);
    }
};
