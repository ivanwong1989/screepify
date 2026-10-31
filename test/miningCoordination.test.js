'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { replayWorld, harness, fresh } = require('./helpers/miningReplay');
const { createWorld } = require('./helpers/sim');
const fixtures = ['W43S28', 'W44S28', 'W44S29'].map(r => require(`./fixtures/mining/${r}.json`));

for (const fixture of fixtures) test(`snapshot replay: ${fixture.room}, every source harvests and survives a VM reset`, () => {
    const sim = replayWorld(fixture);
    const original = Object.values(Game.creeps).filter(c => c.memory.a === 'miner').map(c => ({ c, pos: c.pos, binding: c.memory.b }));
    sim.run(60);
    for (const source of sim.world.sources) assert.ok(sim.bySource[source.id] > 0, `${source.id} harvested`);
    for (const { c, binding } of original) assert.equal(c.memory.b, binding, 'spawn binding preserved');
    if (fixture.room === 'W44S28') for (const { c, pos } of original) assert.ok(c.pos.isEqualTo(pos), 'healthy miner remains in place');
    const before = sim.totalHarvest;
    sim.reload(); sim.run(30);
    assert.ok(sim.totalHarvest > before, 'productive after heap reset');
    const health = require('../src/services/miningHealth').snapshot(fixture.room);
    for (const source of sim.world.sources) assert.ok(health[source.id].lastHarvest !== null);
});

test('observed W44S29 conflict resolves promptly and delivers new energy to storage', () => {
    const sim = replayWorld(fixtures[2]);
    const storage = sim.world.room.storage;
    const before = storage.store.energy;
    sim.run(120);
    assert.ok(sim.firstHarvest[sim.world.sources[0].id] - fixtures[2].time <= 5, 'harvest resumes within 5 simulated ticks');
    assert.ok(storage.store.energy > before, `storage energy ${before} -> ${storage.store.energy}`);
    const miners = Object.values(Game.creeps).filter(c => c.memory.a === 'miner');
    assert.ok(miners.find(c => c.memory.b.endsWith(':0')).pos.isEqualTo(new RoomPosition(36, 6, 'W44S29')));
    assert.ok(miners.find(c => c.memory.b.endsWith(':1')).pos.isEqualTo(new RoomPosition(37, 6, 'W44S29')));
});

function small(oneTile = false) {
    const walls = oneTile ? [[9,9],[10,9],[11,9],[9,10],[11,10],[9,11],[10,11]] : [];
    const w = createWorld({ spawn: [25,25], sources: [[10,10]], controller: [30,30], walls });
    fresh();w.controller.level=8;
    w.addStructure('storage', 24,25).store.energy=100000;
    const container=w.addStructure('container',11,11),source=w.sources[0];
    const make=(name,x,y,slot,ttl=1000,work=7)=>{
        const c=new Creep(w,x,y,name,[...Array(work).fill(WORK),CARRY,MOVE]);c.ticksToLive=ttl;
        c.memory={a:'miner',h:w.roomName,b:`harvest:${w.roomName}:${source.id}:${slot}`,m:`harvest:${source.id}`,s:'init'};return c;
    };
    const h=new Creep(w,13,13,'hauler',[CARRY,MOVE]);h.memory={a:'hauler',h:w.roomName};
    return { sim:harness(w), w, source, container, make, h };
}

test('one-tile source: replacement stages, incumbent works, then performs a handoff', () => {
    const {sim,make,source,container}=small(true);
    const old=make('old',11,11,0,80),incoming=make('incoming',12,12,0,1400);
    sim.run(10);
    assert.ok(old.pos.isEqualTo(container.pos), 'healthy incumbent kept');
    assert.ok(!incoming.pos.isEqualTo(container.pos), 'replacement stages');
    assert.ok(sim.bySource[source.id]>0);
    old.ticksToLive=30;
    sim.run(10);
    assert.ok(incoming.pos.isEqualTo(container.pos), 'replacement takes over');
    assert.ok(!old.pos.isEqualTo(container.pos), 'old miner yields');
});

test('blocked overflow tile: wait safely, then recover when it clears', () => {
    const {sim,make,w,source}=small(true);
    make('primary',11,11,0);
    const overflow=make('overflow',12,12,1);
    sim.run(5);
    assert.equal(require('../src/services/miningStations').assignment(overflow).reason,'waiting');
    w.terrain[10*50+11]=0;
    sim.run(10);
    assert.equal(require('../src/services/miningStations').assignment(overflow).reason,'overflow');
    assert.ok(overflow.pos.inRangeTo(source.pos,1));
});

test('harvest spawn fulfillment counts incoming and retained source miners once, across obsolete slots', () => {
    const {sim,make,w}=small();
    const retained=make('retained',11,11,1),replacement=make('replacement',13,13,0);
    sim.tick();
    const spawn=require('../src/processes/act/spawns');
    const list=spawn.contracts(sim.rc.missions,800).filter(c=>c.mission.type==='harvest');
    assert.equal(list.length,1);
    assert.equal(spawn.fulfillment(list,[retained],0)[list[0].key],1,'old slot still fulfills source');
    retained.ticksToLive=1;replacement.spawning=true;
    assert.equal(spawn.fulfillment(list,[retained,replacement],0)[list[0].key],1,'incoming replacement prevents duplicates');
});

test('hauling readiness: dedicated hauler keeps static mode without a generic hauler; grace expires', () => {
    const sim=replayWorld(fixtures[2]);
    for(const c of Object.values(Game.creeps)) if(c.memory.a==='hauler') {delete Game.creeps[c.name];sim.world.objects.delete(c.id);}
    sim.tick();assert.equal(sim.rc.missions.find(m=>m.type==='harvest').data.mode,'static');
    for(const c of Object.values(Game.creeps)) if(c.memory.a==='miningHauler') {delete Game.creeps[c.name];sim.world.objects.delete(c.id);}
    sim.run(10);assert.equal(sim.rc.missions.find(m=>m.type==='harvest').data.mode,'static','grace retains mode');
    sim.run(20);assert.equal(sim.rc.missions.find(m=>m.type==='harvest').data.mode,'mobile','fallback after grace');
    const h=new Creep(sim.world,33,12,'new-hauler',[CARRY,MOVE]);h.memory={a:'hauler',h:'W44S29'};
    sim.tick();assert.equal(sim.rc.missions.find(m=>m.type==='harvest').data.mode,'static','restored hauling switches back');
});

test('container destruction invalidates cached static tasks and falls back to drop mining', () => {
    const {sim,w,make,container,source}=small();
    const miner=make('primary',11,11,0);sim.run(3);
    w.structures.splice(w.structures.indexOf(container),1);w.objects.delete(container.id);
    sim.run(10);
    assert.equal(sim.rc.missions.find(m=>m.type==='harvest').data.mode,'static_drop');
    assert.ok(!miner.memory.t || miner.memory.t.i!==container.id);
    assert.ok(sim.bySource[source.id]>0);
});

test('health: real blockage triggers bounded recovery; depleted sources do not', () => {
    const {sim,make,source}=small();make('primary',15,15,0);
    const actions=require('../src/actions/index');const original=actions.actions.move;
    actions.actions.move=()=>0; // inaccessible movement while still near the source
    const c=Game.creeps.primary;c.pos=new RoomPosition(12,12,sim.world.roomName);
    sim.run(25);
    const health=require('../src/services/miningHealth');let h=health.snapshot(sim.world.roomName)[source.id];
    assert.equal(h.reason,'position_blocked');
    const recovery=require('../src/services/cache').store('mining.health')[source.id].recoveryAt;
    sim.run(5);assert.equal(require('../src/services/cache').store('mining.health')[source.id].recoveryAt,recovery);
    source.energy=0;sim.tick();h=health.snapshot(sim.world.roomName)[source.id];assert.equal(h.reason,'regenerating');assert.equal(h.blockedTicks,0);
    actions.actions.move=original;
});

for (const fixture of fixtures) test(`snapshot replacements: ${fixture.room}, every source hands over without duplicate spawning`, () => {
    const sim=replayWorld(fixture);sim.run(10);
    const stations=require('../src/services/miningStations'),cache=require('../src/services/cache');
    const incoming=[];
    for(const source of sim.world.sources) {
        const ownerName=cache.store('mining.stations')[`harvest:${source.id}`].owner;
        const owner=Game.creeps[ownerName];owner.ticksToLive=30;
        const tiles=[];
        for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) {
            const p=new RoomPosition(owner.pos.x+dx,owner.pos.y+dy,fixture.room);
            if((dx||dy)&&sim.world.terrain[p.y*50+p.x]!==TERRAIN_MASK_WALL&&
                !sim.world.room.lookForAt(LOOK_STRUCTURES,p.x,p.y).some(s=>![STRUCTURE_ROAD,STRUCTURE_CONTAINER].includes(s.structureType))&&
                !sim.world.room.lookForAt(LOOK_CREEPS,p.x,p.y).length&&!sim.world.sources.some(s=>s.pos.isEqualTo(p))) tiles.push(p);
        }
        assert.ok(tiles.length,'staging position available');
        const p=tiles[0],c=new Creep(sim.world,p.x,p.y,`replacement-${source.id}`,[...Array(7).fill(WORK),CARRY,MOVE]);
        c.memory={a:'miner',h:fixture.room,b:owner.memory.b,m:owner.memory.m,s:'init'};c.ticksToLive=1400;incoming.push({c,source});
    }
    sim.run(20);
    for(const {c,source} of incoming) {
        assert.equal(cache.store('mining.stations')[`harvest:${source.id}`].owner,c.name,'replacement owns source');
        assert.equal(stations.assignment(c).reason,'container');
        assert.ok(c.pos.isEqualTo(require('../src/missions/shared/state').obj(sim.rc.missionsById[c.memory.m].data.containerId).pos));
        const spawns=require('../src/processes/act/spawns');
        const list=spawns.contracts(sim.rc.missions,sim.world.room.energyCapacityAvailable).filter(c=>c.mission.id===`harvest:${source.id}`);
        const counts=spawns.fulfillment(list,Object.values(Game.creeps),0);
        assert.ok(list.every(c=>counts[c.key]>=c.desired),'no extra replacement requested');
    }
});

test('traffic cannot claim another miner’s reserved tile, and stale harvest tasks are invalidated', () => {
    const {sim,make,w,h}=small();const miner=make('primary',11,11,0);sim.tick();
    const stations=require('../src/services/miningStations');stations.reconcile(sim.rc);
    h.pos=new RoomPosition(12,12,w.roomName);
    assert.equal(require('../src/services/traffic').register(h,h.pos.getDirectionTo(11,11)),ERR_BUSY);
    miner.pos=new RoomPosition(12,11,w.roomName);miner.memory.t={a:'harvest',i:w.sources[0].id};
    stations.reconcile(sim.rc);assert.equal(miner.memory.t,undefined,'stale harvest does not bypass repositioning');
});

test('mobile/static topology changes invalidate the cached harvest plan immediately', () => {
    const {sim,make,h,w}=small();make('primary',11,11,0);sim.tick();
    const readiness=require('../src/services/miningReadiness');const before=readiness.signature(sim.rc);
    delete Game.creeps[h.name];w.objects.delete(h.id);
    Game.time+=26;
    assert.notEqual(readiness.signature(sim.rc),before,'hauling loss changes generator key after grace');
    const key=readiness.signature(sim.rc);sim.rc.intel.sources[0].containerId=null;
    assert.notEqual(readiness.signature(sim.rc),key,'container topology changes generator key');
});

test('weak retained miners do not hide a source WORK deficit', () => {
    const {sim,make}=small();const weak=make('weak',11,11,1,1000,1);sim.tick();
    const spawns=require('../src/processes/act/spawns');const list=spawns.contracts(sim.rc.missions,800).filter(c=>c.mission.type==='harvest');
    assert.equal(spawns.fulfillment(list,[weak],0)[list[0].key],0,'one WORK is insufficient for the source');
});

test('a ready replacement takes over a damaged miner before its TTL runs out', () => {
    const {sim,make,container}=small();const old=make('damaged',11,11,0,1000,1),replacement=make('strong',12,12,0,1400,7);
    sim.run(10);assert.ok(replacement.pos.isEqualTo(container.pos));assert.ok(!old.pos.isEqualTo(container.pos));
});

test('same-count container replacement refreshes source identity and mining assignments', () => {
    const {sim,w,make,container,source}=small();const miner=make('primary',11,11,0);sim.run(2);
    w.structures.splice(w.structures.indexOf(container),1);w.objects.delete(container.id);
    const replacement=w.addStructure('container',11,11);
    sim.run(5);
    assert.equal(sim.rc.intel.sources[0].containerId,replacement.id);
    assert.equal(sim.rc.missionsById[miner.memory.m].data.containerId,replacement.id);
    assert.ok(sim.bySource[source.id]>0);
});
