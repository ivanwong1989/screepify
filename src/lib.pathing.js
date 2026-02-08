/**
 * Module for efficient pathfinding using PathFinder and cached CostMatrices.
 * Saves CPU by reusing CostMatrices for static structures.
 */

let costMatrixCache = {};

var libPathing = {
    // Configuration for movement costs
    // Increasing plain/swamp costs relative to roads (1) encourages road usage.
    PLAIN_COST: 2,
    SWAMP_COST: 10,
    ROAD_COST: 1,

    /**
     * Gets or creates a cached CostMatrix for the room.
     * @param {string} roomName 
     * @returns {PathFinder.CostMatrix|undefined}
     */
    getCostMatrix: function(roomName) {
        if (costMatrixCache[roomName]) {
            return costMatrixCache[roomName];
        }

        const room = Game.rooms[roomName];
        // If we have no visibility, we cannot build a structure-aware matrix.
        // Return undefined so PathFinder uses default terrain.
        if (!room) return;

        const matrix = new PathFinder.CostMatrix();

        room.find(FIND_STRUCTURES).forEach(function(struct) {
            if (struct.structureType === STRUCTURE_ROAD) {
                // Favor roads
                matrix.set(struct.pos.x, struct.pos.y, libPathing.ROAD_COST);
            } else if (struct.structureType !== STRUCTURE_CONTAINER && 
                       (struct.structureType !== STRUCTURE_RAMPART || !struct.my)) {
                // Treat non-walkable structures as obstacles
                // Note: We assume friendly ramparts are walkable, hostile are not
                matrix.set(struct.pos.x, struct.pos.y, 0xff);
            }
        });

        costMatrixCache[roomName] = matrix;
        return matrix;
    },

    /**
     * Clears the cache for a specific room. Call this when structures change.
     * @param {string} roomName 
     */
    invalidateCache: function(roomName) {
        delete costMatrixCache[roomName];
    },

    /**
     * Clears the entire cache. Useful on global reset or periodically.
     */
    clearCache: function() {
        costMatrixCache = {};
    },

    /**
     * Wrapper for PathFinder.search using the cached CostMatrices.
     * @param {RoomPosition} origin
     * @param {RoomPosition|{pos:RoomPosition, range:number}[]} goal
     * @param {number} range
     */
    search: function(origin, goal, range = 1) {
        // Handle goal format
        let targets = [];
        if (Array.isArray(goal)) {
            targets = goal;
        } else {
            targets = [{pos: goal, range: range}];
        }

        return PathFinder.search(origin, targets, {
            plainCost: this.PLAIN_COST,
            swampCost: this.SWAMP_COST,
            roomCallback: function(roomName) {
                return libPathing.getCostMatrix(roomName);
            },
            maxOps: 2000 // Limit CPU usage
        });
    },

    run: function() {
        // Clear cache periodically to handle new structures/decay
        // This clears the cache every 100 ticks.
        if (Game.time % 100 === 0) {
            this.clearCache();
        }
    }
};

module.exports = libPathing;
