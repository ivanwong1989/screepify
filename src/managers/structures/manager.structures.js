const managerLinks = require('managers_structures_manager.links');
const managerLabs = require('managers_structures_manager.labs');
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

        // 3. Run Lab Manager
        managerLabs.run(room);

        // 4. Run Market (Terminal)
        managerTerminal.run(room);
    }
};

module.exports = managerStructures;
