const managerLinks = require('managers_structures_manager.links');
const managerRamparts = require('managers_structures_manager.ramparts');
const managerTerminal = require('managers_structures_manager.terminal');

/**
 * Unified Room Structure Manager.
 * Orchestrates interactions for various room structures like Links, Terminal (Market), and Labs.
 */
const managerStructures = {
    run: function(room) {
        // 1. Run Link Transfers
        managerLinks.run(room);

        // 2. Run Rampart Access Control
        managerRamparts.run(room);

        // 3. Run Market (Terminal)
        managerTerminal.run(room);
        
        // Future: Lab management can be added here
    }
};

module.exports = managerStructures;
