'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {replay}=require('./helpers/resourceReplay');
const {createWorld}=require('./helpers/sim');
const {fresh}=require('./helpers/resourceReplay');

function labRequests(w){
    const rc=w.ctx.roomList.find(r=>r.name==='W44S28'),labs=require('../src/services/labs');
    const list=rc.stores.filter(s=>s.structureType==='lab');
    const plan=labs.plan(list,{}, {...w.ctx.config.labs,reaction:'ZK'},null);
    const info={roomName:rc.name,terminal:w.ctx.config.terminal,miningContainers:new Set(),hasBuffer:true,labs:plan.roles,labCfg:w.ctx.config.labs};
    return {rc,plan,info,build:(ledger={inc:{},out:{}})=>require('../src/services/requests').build(rc.stores,ledger,info,{})};
}

test('live reagent replay: Z trapped in terminal becomes a funded lab job',()=>{
    const w=replay(),{rc,plan,build}=labRequests(w);const req=build();
    assert.equal(rc.room.storage.store.Z||0,0);assert.equal(rc.room.terminal.store.Z,10360);
    const j=require('../src/services/matcher').pick(req,{cap:500,touch:new Set(plan.inputs)});
    assert.equal(j.r,'Z');assert.equal(j.f,rc.room.terminal.id);assert.equal(j.q,500);
    assert.ok(plan.inputs.includes(j.d));
});

test('lab access preserves terminal targets, active sell commitments, and outgoing jobs',()=>{
    let w=replay(),c=labRequests(w);c.info.terminal={...c.info.terminal,stock:{Z:10360}};
    assert.equal(c.build().byRes.Z.off.length,0,'explicit terminal reserve kept');
    w=replay();c=labRequests(w);const id=c.rc.room.terminal.id;
    Game.market.orders.reserved={id:'reserved',type:ORDER_SELL,resourceType:'Z',roomName:'W44S28',remainingAmount:10000};
    assert.equal(c.build().byRes.Z.off[0].amount,360,'advertised goods not borrowed');
    const l={inc:{[id]:{Z:5000}},out:{[id]:{Z:10360}}};
    assert.equal(c.build(l).byRes.Z.off.length,0,'incoming promises do not fund outgoing goods twice');
});

test('unrequested terminal resources are not flushed globally',()=>{
    const w=replay(),c=labRequests(w),req=c.build();
    assert.equal(req.byRes.H?.off.length||0,0);assert.equal(req.byRes.X?.off.length||0,0);
});

test('live production replay: historical ZK price cannot substitute for profitable buyers',()=>{
    const w=replay(),rc=w.ctx.roomList.find(r=>r.name==='W44S28');
    const value=require('../src/services/market').valuer(w.ctx.config.market),p=require('../src/services/productionMarket');
    const decision=p.evaluate(rc.room,'ZK',{ZK:500},w.ctx.config.market,w.ctx.config.labs.production,value,20000);
    assert.ok(value('ZK')>130);assert.equal(decision.allowed,false);assert.equal(decision.depth,0);
});

test('production requires a configured exit, transport-adjusted margin, and sufficient remaining depth',()=>{
    const w=replay(),rc=w.ctx.roomList[0],cfg=w.ctx.config.market,production=w.ctx.config.labs.production;
    const p=require('../src/services/productionMarket');const value=r=>({energy:10,K:10,Z:10,ZK:50}[r]??null);
    Game.market.getAllOrders=()=>[{id:'buyer',type:'buy',price:55,amount:5000,roomName:'W1N1'}];
    let d=p.evaluate(rc.room,'ZK',{},cfg,production,value,20000);assert.ok(d.allowed);assert.equal(d.target,5000);
    d=p.evaluate(rc.room,'ZK',{ZK:4500},cfg,production,value,20000);assert.equal(d.allowed,false,'already-produced stock consumes depth');
    Game.market.calcTransactionCost=n=>n*4;d=p.evaluate(rc.room,'ZK',{},cfg,production,value,20000);assert.equal(d.allowed,false,'transport wipes margin');
    d=p.evaluate(rc.room,'UL',{},cfg,production,value,20000);assert.equal(d.reason,'no_executable_sales_policy');
});

test('explicit production stock targets work without market demand and stop at target',()=>{
    const w=replay(),rc=w.ctx.roomList[0],p=require('../src/services/productionMarket'),prod={...w.ctx.config.labs.production,stock:{ZK:2000}};
    const cfg={...w.ctx.config.market,enabled:false};
    assert.equal(p.evaluate(rc.room,'ZK',{ZK:1000},cfg,prod,()=>null,20000).reason,'stock_target');
    assert.equal(p.evaluate(rc.room,'ZK',{ZK:2000},cfg,prod,()=>null,20000).allowed,false);
});

test('live energy replay: two donor rooms advertise bounded batches; W44S29 is protected',()=>{
    const w=replay(),p=require('../src/services/energyExport'),value=require('../src/services/market').valuer(w.ctx.config.market);
    p.run(w.ctx,value);const offers=w.calls.filter(c=>c.action==='create');
    assert.deepEqual(offers.map(c=>c.roomName),['W43S28','W44S28']);
    assert.ok(offers.every(c=>c.resourceType==='energy'&&c.totalAmount===5000));
    assert.equal(p.snapshot('W44S29').active,false);
    assert.equal(p.snapshot('W43S28').terminalTarget,50000);
});

test('energy staging does not create a start/stop loop and resumes terminal targets after export',()=>{
    const w=replay(),rc=w.ctx.roomList[0],e=require('../src/services/energyExport');
    assert.equal(e.plan(rc,w.ctx.config).active,true);
    rc.room.storage.store.energy-=30000;rc.room.terminal.store.energy+=30000;
    assert.equal(e.plan(rc,w.ctx.config).active,true,'moving energy is not selling it');
    rc.room.storage.store.energy=370000;rc.room.terminal.store.energy=50000;
    const stopped=e.plan(rc,w.ctx.config);assert.equal(stopped.active,false);assert.equal(stopped.terminalTarget,20000);
    rc.room.storage.store.energy=400000;rc.room.terminal.store.energy=20000;
    assert.equal(e.plan(rc,w.ctx.config).active,false,'draining staged surplus does not restart exports');
});

test('energy reserve/protected rooms cancel open orders; depleted terminals cannot advertise unsafe quantities',()=>{
    const w=replay(),e=require('../src/services/energyExport'),rc=w.ctx.roomList[0],value=()=>20;
    e.run(w.ctx,value);assert.ok(Object.values(Game.market.orders).some(o=>o.roomName===rc.name&&o.resourceType==='energy'));
    rc.policy.state='DEFENSIVE';w.calls.length=0;e.run(w.ctx,value);assert.ok(w.calls.some(c=>c.action==='cancel'));
    rc.policy.state='GROW';rc.room.storage.store.energy=290000;assert.equal(e.plan(rc,w.ctx.config).reason,'hard_reserve');
    rc.room.storage.store.energy=500000;rc.room.terminal.store.energy=10500;w.calls.length=0;e.run(w.ctx,value);
    assert.ok(!w.calls.some(c=>c.action==='create'&&c.roomName===rc.name));
});

test('energy order fees respect a shared credit budget across rooms even if the API credit field is stale',()=>{
    const w=replay(),e=require('../src/services/energyExport');Game.market.getAllOrders=()=>[];
    const reserve=w.ctx.config.market.buy.creditReserve;Game.market.credits=reserve+6000;
    e.run(w.ctx,()=>20);assert.equal(w.calls.filter(c=>c.action==='create').length,1,'one 5,000-credit fee fits; two do not');
});

test('disabled exporter cancels its outstanding sales',()=>{
    const w=replay(),e=require('../src/services/energyExport');e.run(w.ctx,()=>20);
    w.ctx.config.market.energyExport.enabled=false;w.calls.length=0;e.run(w.ctx,()=>20);
    assert.equal(w.calls.filter(c=>c.action==='cancel').length,2);
});

test('completed energy orders are extended rather than leaked as new orders',()=>{
    const w=replay(),e=require('../src/services/energyExport');Game.market.orders={done:{id:'done',type:'sell',resourceType:'energy',roomName:'W43S28',remainingAmount:0,price:20,created:1}};
    e.run(w.ctx,()=>20);assert.ok(w.calls.some(c=>c.action==='extend'&&c.id==='done'));
    assert.ok(!w.calls.some(c=>c.action==='create'&&c.roomName==='W43S28'));
});


test('console energy stop and global market stop cancel automatic orders',()=>{
    for (const stop of ['resource','global']) {
        const w=replay(),e=require('../src/services/energyExport');e.run(w.ctx,()=>20);
        if(stop==='resource') w.ctx.config.market.sell.energy=null;
        else w.ctx.config.market.enabled=false;
        w.calls.length=0;require('../src/processes/act/market').run(w.ctx);
        assert.equal(w.calls.filter(c=>c.action==='cancel').length,2);
    }
});

test('lab-only terminal offers cannot be diverted to storage or unrelated requests',()=>{
    const w=replay(),c=labRequests(w),req=c.build(),m=require('../src/services/matcher');
    assert.equal(m.pick(req,{cap:500,res:'Z',to:new Set([req.buffer.id])}),null);
    for(const r of req.byRes.Z.req)r.amount=0;
    req.byRes.Z.req.push({id:'unrelated',amount:500,prio:100,x:1,y:1});
    assert.equal(m.pick(req,{cap:500,res:'Z'}),null);
});

test('production honors the actual seller floor anchor after historical prices fall',()=>{
    const w=replay(),rc=w.ctx.roomList[0],p=require('../src/services/productionMarket');
    Memory.rooms[rc.name]={mk:{ZK:{p:100,t:Game.time}}};
    Game.market.getAllOrders=()=>[{id:'buyer',type:'buy',price:55,amount:5000,roomName:'W1N1'}];
    const d=p.evaluate(rc.room,'ZK',{},w.ctx.config.market,w.ctx.config.labs.production,r=>({energy:10,K:10,Z:10,ZK:50}[r]??null),20000);
    assert.equal(d.allowed,false);assert.equal(d.floor,100);
});

test('selling and terminal staging retain explicit production stock',()=>{
    const w=replay(),rc=w.ctx.roomList[0],cfg=w.ctx.config;
    cfg.market.sell={ZK:{mode:'deal',keep:0,batch:5000}};cfg.market.energyExport.enabled=false;
    cfg.labs.production.stock.ZK=2500;
    rc.room.storage.store.ZK=2500;rc.room.terminal.store.ZK=1000;
    const m=require('../src/services/market');
    assert.deepEqual(m.stockFor(rc.room,cfg.market,undefined,cfg.labs),{ZK:1000});
    Game.market.getHistory=r=>[{date:'2026-10-31',avgPrice:{ZK:50,Z:10,K:10,energy:10}[r]||10,volume:100000,transactions:1000}];
    Game.market.getAllOrders=()=>[{id:'buyer',type:'buy',price:55,amount:5000,remainingAmount:5000,roomName:'W1N1'}];
    const sales=[];Game.market.deal=(id,n,room)=>{sales.push({id,n,room});return OK;};
    require('../src/processes/act/market').run(w.ctx);
    assert.deepEqual(sales,[{id:'buyer',n:1000,room:rc.name}]);
    cfg.market.sell.ZK.mode='order';
    Game.market.orders.reserved={id:'reserved',type:ORDER_SELL,resourceType:'ZK',roomName:rc.name,remainingAmount:5000,price:55};
    require('../src/processes/act/market').run(w.ctx);
    assert.ok(w.calls.some(c=>c.action==='cancel'&&c.id==='reserved'),'old orders cannot consume newly protected production stock');
});

test('energy sale lifecycle drains surplus in batches without selling below the stop reserve',()=>{
    const w=replay(),e=require('../src/services/energyExport'),rc=w.ctx.roomList[0];
    w.ctx.roomList=[rc];Game.market.orders={};Game.market.getAllOrders=()=>[];
    let sold=0;
    for(let i=0;i<25;i++){
        const p=e.plan(rc,w.ctx.config);
        const move=Math.max(0,p.terminalTarget-rc.room.terminal.store.energy);
        rc.room.storage.store.energy-=move;rc.room.terminal.store.energy+=move;
        e.run(w.ctx,()=>20);
        const o=Object.values(Game.market.orders).find(o=>o.remainingAmount>0);
        if(!o)break;
        assert.ok(o.remainingAmount<=5000);
        rc.room.terminal.store.energy-=o.remainingAmount;sold+=o.remainingAmount;o.remainingAmount=0;
        Game.time+=50;
    }
    const p=e.plan(rc,w.ctx.config);
    assert.equal(sold,70000);
    assert.ok(p.buffered>=400000&&p.buffered<401000);
    assert.ok(rc.room.storage.store.energy>=300000);
    assert.ok(!Object.values(Game.market.orders).some(o=>o.remainingAmount>0));
});
