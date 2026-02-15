const managerLinks = require('managers_structures_manager.links');
// Importing the existing market manager from its current location
const managerMarket = require('managers_overseer_manager.room.economy.market');

/**
 * Unified Room Structure Manager.
 * Orchestrates interactions for various room structures like Links, Terminal (Market), and Labs.
 */
const managerStructures = {
    run: function(room) {
        // 1. Run Link Transfers
        managerLinks.run(room);

        // 2. Run Market (Terminal)
        managerMarket.run(room);
        
        // Future: Lab management can be added here
    }
};

module.exports = managerStructures;
