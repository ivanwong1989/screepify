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

    if(harvesters.length < 5) {
        var newName = 'Harvester' + Game.time;
        //console.log('Spawning new harvester: ' + newName);
        Game.spawns['Spawn1'].spawnCreep([WORK,CARRY,MOVE], newName, {
            memory: {role: 'harvester', random_source_target: 'NA'}
        });
    }

    // ensure that only enable below spawns when at least there are 2 harvesters minimum
    if(harvesters.length > 2) {
        if(upgraders.length < 4) {
            var newName = 'Upgrader' + Game.time;
            console.log('Spawning new upgrader: ' + newName);
            Game.spawns['Spawn1'].spawnCreep([WORK,CARRY,MOVE], newName, {
                memory: {role: 'upgrader'}
            });
        }
        
        if(builders.length < 1) {
            var newName = 'Builder' + Game.time;
            console.log('Spawning new Builder: ' + newName);
            Game.spawns['Spawn1'].spawnCreep([WORK,CARRY,MOVE], newName, {
                memory: {role: 'builder'}
            });
        }
    }
    // --- END SPAWNING LOGIC ---

    // --- GET TOWER LOGIC ---
    var towers = _.filter(Game.structures, (structure) = structure.structureType == STRUCTURE_TOWER);

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