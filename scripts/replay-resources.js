'use strict';

// Offline only: fixture-backed Game/Memory mocks; never reads a token or network.
const { replay } = require('../test/helpers/resourceReplay');
const w = replay();
const market = require('../src/services/market');
const production = require('../src/services/productionMarket');
const energy = require('../src/services/energyExport');
const labs = require('../src/services/labs');
const value = market.valuer(w.ctx.config.market);
const rows = w.ctx.roomList.map(rc => ({ room: rc.name, ...energy.plan(rc, w.ctx.config) }));
const rc = w.ctx.roomList.find(rc => rc.name === 'W44S28');
const list = rc.stores.filter(s => s.structureType === 'lab');
const have = {};
for (const s of [rc.room.storage, rc.room.terminal, ...list]) {
    for (const r of Object.keys(s.store)) if (typeof s.store[r] === 'number' && !r.startsWith('_')) have[r] = (have[r] || 0) + s.store[r];
}
const decision = production.evaluate(rc.room, 'ZK', have, w.ctx.config.market, w.ctx.config.labs.production, value, w.ctx.config.labs.productCap);
const p = labs.plan(list, have, { ...w.ctx.config.labs, reaction: 'ZK' }, null);
const requests = require('../src/services/requests').build(rc.stores, {inc:{},out:{}}, {
    roomName:rc.name, terminal:w.ctx.config.terminal, miningContainers:new Set(), hasBuffer:true,
    labs:p.roles, labCfg:w.ctx.config.labs
});
const job = require('../src/services/matcher').pick(requests,{cap:500,touch:new Set(p.inputs)});
const log = console.log;
try { console.log = () => {}; energy.run(w.ctx,value); } finally { console.log=log; }
console.log(JSON.stringify({
    snapshot:{tick:w.fixture.tick,provenance:w.fixture.provenance},
    assumptions:['Read-only saved snapshot, not current game state.', 'Transport cost modeled as ceil(amount * 0.1); production rejects the real saved ZK book independently of this assumption.', 'Reagent access uses an explicit ZK recipe to isolate logistics; automatic production remains gated.'],
    reagent:{terminalZ:rc.room.terminal.store.Z,storageZ:rc.room.storage.store.Z||0,job},
    production:{ZKreference:value('ZK'),decision},
    energy:rows.map(p=>({room:p.room,storage:p.storage,terminal:p.terminal,buffered:p.buffered,active:p.active,terminalTarget:p.terminalTarget,reason:p.reason})),
    simulatedMarketActions:w.calls
},null,2));
