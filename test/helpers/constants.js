'use strict';

/**
 * The subset of Screeps game constants the bot and the simulator use.
 * Values match the official engine.
 */
module.exports = {
    OK: 0, ERR_NOT_OWNER: -1, ERR_NO_PATH: -2, ERR_NAME_EXISTS: -3, ERR_BUSY: -4, ERR_NOT_FOUND: -5,
    ERR_NOT_ENOUGH_ENERGY: -6, ERR_NOT_ENOUGH_RESOURCES: -6, ERR_INVALID_TARGET: -7, ERR_FULL: -8,
    ERR_NOT_IN_RANGE: -9, ERR_INVALID_ARGS: -10, ERR_TIRED: -11, ERR_NO_BODYPART: -12, ERR_RCL_NOT_ENOUGH: -14,

    FIND_EXIT_TOP: 1, FIND_EXIT_RIGHT: 3, FIND_EXIT_BOTTOM: 5, FIND_EXIT_LEFT: 7,
    FIND_CREEPS: 101, FIND_MY_CREEPS: 102, FIND_HOSTILE_CREEPS: 103, FIND_SOURCES_ACTIVE: 104, FIND_SOURCES: 105,
    FIND_DROPPED_RESOURCES: 106, FIND_STRUCTURES: 107, FIND_MY_STRUCTURES: 108, FIND_HOSTILE_STRUCTURES: 109,
    FIND_FLAGS: 110, FIND_CONSTRUCTION_SITES: 111, FIND_MY_SPAWNS: 112, FIND_HOSTILE_SPAWNS: 113,
    FIND_MY_CONSTRUCTION_SITES: 114, FIND_HOSTILE_CONSTRUCTION_SITES: 115, FIND_MINERALS: 116, FIND_NUKES: 117,
    FIND_TOMBSTONES: 118, FIND_POWER_CREEPS: 119, FIND_MY_POWER_CREEPS: 120, FIND_HOSTILE_POWER_CREEPS: 121,
    FIND_DEPOSITS: 122, FIND_RUINS: 123,

    TOP: 1, TOP_RIGHT: 2, RIGHT: 3, BOTTOM_RIGHT: 4, BOTTOM: 5, BOTTOM_LEFT: 6, LEFT: 7, TOP_LEFT: 8,

    LOOK_CREEPS: 'creep', LOOK_ENERGY: 'energy', LOOK_RESOURCES: 'resource', LOOK_SOURCES: 'source',
    LOOK_MINERALS: 'mineral', LOOK_STRUCTURES: 'structure', LOOK_FLAGS: 'flag',
    LOOK_CONSTRUCTION_SITES: 'constructionSite', LOOK_TERRAIN: 'terrain',

    TERRAIN_MASK_WALL: 1, TERRAIN_MASK_SWAMP: 2,

    MOVE: 'move', WORK: 'work', CARRY: 'carry', ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack',
    TOUGH: 'tough', HEAL: 'heal', CLAIM: 'claim',
    BODYPART_COST: { move: 50, work: 100, attack: 80, carry: 50, heal: 250, ranged_attack: 150, tough: 10, claim: 600 },

    CREEP_LIFE_TIME: 1500, CREEP_CLAIM_LIFE_TIME: 600, CREEP_SPAWN_TIME: 3, CARRY_CAPACITY: 50,
    HARVEST_POWER: 2, REPAIR_POWER: 100, BUILD_POWER: 5, UPGRADE_CONTROLLER_POWER: 1, DISMANTLE_POWER: 50,
    SOURCE_ENERGY_CAPACITY: 3000, ENERGY_REGEN_TIME: 300, SPAWN_ENERGY_CAPACITY: 300, SPAWN_ENERGY_START: 300,
    EXTENSION_ENERGY_CAPACITY: { 0: 50, 1: 50, 2: 50, 3: 50, 4: 50, 5: 50, 6: 50, 7: 100, 8: 200 },
    CONTAINER_CAPACITY: 2000, CONTAINER_HITS: 250000, STORAGE_CAPACITY: 1000000,
    CONTAINER_DECAY: 5000, CONTAINER_DECAY_TIME: 100, CONTAINER_DECAY_TIME_OWNED: 500,
    ROAD_HITS: 5000, ROAD_DECAY_AMOUNT: 100, ROAD_DECAY_TIME: 1000,
    TOWER_CAPACITY: 1000, TOWER_ENERGY_COST: 10, TOWER_POWER_ATTACK: 600, TOWER_POWER_HEAL: 400,
    TOWER_POWER_REPAIR: 800, TOWER_OPTIMAL_RANGE: 5, TOWER_FALLOFF_RANGE: 20, TOWER_FALLOFF: 0.75,

    STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_ROAD: 'road',
    STRUCTURE_WALL: 'constructedWall', STRUCTURE_RAMPART: 'rampart', STRUCTURE_KEEPER_LAIR: 'keeperLair',
    STRUCTURE_PORTAL: 'portal', STRUCTURE_CONTROLLER: 'controller', STRUCTURE_LINK: 'link',
    STRUCTURE_STORAGE: 'storage', STRUCTURE_TOWER: 'tower', STRUCTURE_OBSERVER: 'observer',
    STRUCTURE_POWER_BANK: 'powerBank', STRUCTURE_POWER_SPAWN: 'powerSpawn', STRUCTURE_EXTRACTOR: 'extractor',
    STRUCTURE_LAB: 'lab', STRUCTURE_TERMINAL: 'terminal', STRUCTURE_CONTAINER: 'container',
    STRUCTURE_NUKER: 'nuker', STRUCTURE_FACTORY: 'factory', STRUCTURE_INVADER_CORE: 'invaderCore',

    CONSTRUCTION_COST: {
        spawn: 15000, extension: 3000, road: 300, constructedWall: 1, rampart: 1, link: 5000, storage: 30000,
        tower: 5000, observer: 8000, powerSpawn: 100000, extractor: 5000, lab: 50000, terminal: 100000,
        container: 5000, nuker: 100000, factory: 100000
    },
    CONTROLLER_LEVELS: { 1: 200, 2: 45000, 3: 135000, 4: 405000, 5: 1215000, 6: 3645000, 7: 10935000 },
    CONTROLLER_STRUCTURES: {
        spawn: { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 },
        extension: { 0: 0, 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 },
        link: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2, 6: 3, 7: 4, 8: 6 },
        road: { 0: 2500, 1: 2500, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500 },
        constructedWall: { 1: 0, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500 },
        rampart: { 1: 0, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500 },
        storage: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
        tower: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 },
        container: { 0: 5, 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5, 7: 5, 8: 5 },
        lab: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 3, 7: 6, 8: 10 },
        terminal: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 1 }
    },
    OBSTACLE_OBJECT_TYPES: ['spawn', 'creep', 'powerCreep', 'source', 'mineral', 'deposit', 'controller',
        'constructedWall', 'extension', 'link', 'storage', 'tower', 'observer', 'powerSpawn', 'powerBank', 'lab',
        'terminal', 'nuker', 'factory', 'invaderCore'],
    RESOURCE_ENERGY: 'energy',
    BOOSTS: {}
};
