var roleHarvester = require('role.harvester');
var roleUpgrader = require('role.upgrader');
var roleBuilder = require('role.builder');
var roleTower = require('role.tower');

module.exports.loop = function () {

    // --- Memory name garbage clearing ---
    for(var name in Memory.creeps) {
        if(!Game.creeps[name]) {
            delete Memory.creeps[name];
            console.log('Clearing non-existing creep memory:', name);
        }
    }
    // --- SPAWNING LOGIC ---
    var harvesters = _.filter(Game.creeps, (creep) => creep.memory.role == 'harvester');
    var upgraders = _.filter(Game.creeps, (creep) => creep.memory.role == 'upgrader');
    var builders = _.filter(Game.creeps, (creep) => creep.memory.role == 'builder');

    // Small vs Big Harvester logic, when extension buildings are less than 2, use small harvesters
    // when extension buildings are more than 2, use big harvesters
    var room_extensions = Game.spawns['Spawn1'].room.find(FIND_STRUCTURES, {
            filter: (structure) => {
                return (structure.structureType == STRUCTURE_EXTENSION);
            }
    });

    if(room_extensions.length < 4) {
        if(harvesters.length < 10) {
            var newName = 'Harvester' + Game.time;
            //console.log('Spawning new harvester: ' + newName);
            Game.spawns['Spawn1'].spawnCreep([WORK,CARRY,MOVE], newName, {
                memory: {role: 'harvester', random_source_target_id: 'NA'}
            });
        }
    } else {
        if(harvesters.length < 5) {
            var newName = 'BigHarvester' + Game.time;
            //console.log('Spawning new harvester: ' + newName);
            Game.spawns['Spawn1'].spawnCreep([WORK,WORK,CARRY,MOVE,MOVE], newName, {
                memory: {role: 'harvester', random_source_target_id: 'NA'}
            });
        }
    }


    // ensure that only enable below spawns when at least there are 2 harvesters minimum
    if(harvesters.length > 4) {
        if(upgraders.length < 5) {
            var newName = 'Upgrader' + Game.time;
            console.log('Spawning new upgrader: ' + newName);
            Game.spawns['Spawn1'].spawnCreep([WORK,CARRY,MOVE], newName, {
                memory: {role: 'upgrader'}
            });
        }
        
        if(builders.length < 2) {
            var newName = 'Builder' + Game.time;
            console.log('Spawning new Builder: ' + newName);
            Game.spawns['Spawn1'].spawnCreep([WORK,CARRY,MOVE], newName, {
                memory: {role: 'builder'}
            });
        }
    }
    // --- END SPAWNING LOGIC ---

    // --- GET TOWER LOGIC ---
    var towers = _.filter(Game.structures, (structure) => structure.structureType == STRUCTURE_TOWER);

    // --- CREEP RUN LOGIC ---
    for(var name in Game.creeps) {
        var creep = Game.creeps[name];
        if(creep.memory.role == 'harvester') {
            roleHarvester.run(creep);
        }
        if(creep.memory.role == 'upgrader') {
            roleUpgrader.run(creep);
        }
        if(creep.memory.role == 'builder') {
            roleBuilder.run(creep);
        }
    }
    // --- END CREEP RUN LOGIC ---

    // --- TOWER RUN LOGIC ---
    // --- END TOWER RUN LOGIC ---

}