var libPathing = require('lib.pathing');

var managerRoomVisualizer = {
    run: function() {
        if (Game.flags['FlagVisual']) {
            this.visualize(Game.flags['FlagVisual'].pos.roomName);
        }
    },

    visualize: function(roomName) {
        const room = Game.rooms[roomName];
        if (!room) return;

        const visual = room.visual;
        const terrain = Game.map.getRoomTerrain(roomName);

        // Use cached CostMatrix from libPathing
        const matrix = libPathing.getCostMatrix(roomName);

        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                const t = terrain.get(x, y);
                
                // Skip walls
                if (t & TERRAIN_MASK_WALL) continue;

                // Determine cost based on matrix or terrain defaults
                let cost = 0;
                let isObstacle = false;
                
                // Check matrix value (0 means default terrain)
                let matrixVal = matrix ? matrix.get(x, y) : 0;

                if (matrixVal === 0xff) {
                    isObstacle = true;
                } else if (matrixVal > 0) {
                    cost = matrixVal;
                } else {
                    // Default terrain costs matching libPathing config
                    cost = (t & TERRAIN_MASK_SWAMP) ? libPathing.SWAMP_COST : libPathing.PLAIN_COST;
                }

                if (isObstacle) {
                    visual.text('X', x, y + 0.2, {color: '#ff0000', font: 0.5});
                    continue;
                } else {
                    // Show movement cost
                    visual.text(cost.toString(), x, y + 0.2, {
                        color: cost <= 2 ? '#dddddd' : '#ffaa00', 
                        font: 0.35,
                        opacity: 0.7
                    });

                    // Highlight high cost tiles (Swamps without roads)
                    if (cost >= 10) {
                        visual.rect(x - 0.4, y - 0.4, 0.8, 0.8, {fill: '#ffff00', opacity: 0.1});
                    }
                }
            }
        }
    }
};

module.exports = managerRoomVisualizer;
