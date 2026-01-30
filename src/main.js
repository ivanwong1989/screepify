var roleHarvester = require('role.harvester');
var roleUpgrader = require('role.upgrader');
var roleBuilder = require('role.builder');
var roleTower = require('role.tower');
var roleDefender = require('role.defender');
const { forEach } = require('lodash');

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
    var defenders = _.filter(Game.creeps, (creep) => creep.memory.role == 'defender');

    // Small vs Big Harvester logic, based on the room's energy capacity.
    const bigHarvesterCost = 350;
    const roomEnergyCapacity = Game.spawns['Spawn1'].room.energyCapacityAvailable;
    
    if(roomEnergyCapacity < bigHarvesterCost) {
        // Not enough capacity for big harvesters, spawn small ones.
        if(harvesters.length < 10) {
            var newName = 'Harvester' + Game.time;
            //console.log('Spawning new harvester: ' + newName);
            Game.spawns['Spawn1'].spawnCreep([WORK,CARRY,MOVE], newName, {
                memory: {role: 'harvester', random_source_target_id: 'NA'}
            });
        }
    } else {
        // We have enough capacity for big harvesters.
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
        
        if(builders.length < 4) {
            var newName = 'Builder' + Game.time;
            console.log('Spawning new Builder: ' + newName);
            Game.spawns['Spawn1'].spawnCreep([WORK,CARRY,MOVE], newName, {
                memory: {role: 'builder'}
            });
        }

        if(defenders.length < 2) {
            var newName = 'Defender' + Game.time;
            console.log('Spawning new Defender: ' + newName);
            Game.spawns['Spawn1'].spawnCreep([ATTACK,MOVE], newName, {
                memory: {role: 'defender'}
            });
        }
    }
    // --- END SPAWNING LOGIC ---

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
        if(creep.memory.role == 'defender') {
            roleDefender.run(creep);
        }
    }
    // --- END CREEP RUN LOGIC ---

    // --- TOWER RUN LOGIC ---
        // --- Tower Search Logic ---
    var towers = Game.spawns['Spawn1'].room.find(FIND_STRUCTURES, {
            filter: (structure) => {
                return (structure.structureType == STRUCTURE_TOWER);
            }
    });

    //if(towers) {
    //   forEach(towers, tower => {
    //      roleTower.run(tower);
    //    });
    //}
    // --- END Tower Search Logic ---
}