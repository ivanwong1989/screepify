const assault = require('managers_admiral_tactics_assault_index');

module.exports = {
    executeAssault: function(creep, mission, context) {
        return assault.executeAssault(creep, mission, context);
    },
    planForPair: function(mission, leader, support, context) {
        return assault.planForPair(mission, leader, support, context);
    },
    planForSolo: function(mission, creep, context) {
        return assault.planForSolo(mission, creep, context);
    }
};
