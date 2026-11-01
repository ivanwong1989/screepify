'use strict';
const path=require('path');
const {createWorld,Store}=require('./sim');
const fixture=require('../fixtures/economy/live.json');
const ROOT=path.join(__dirname,'../..');
function fresh(){
    createWorld({spawn:[25,25],sources:[[10,10]],controller:[40,40]});
    for(const key of Object.keys(require.cache))if(key.startsWith(path.join(ROOT,'src')))delete require.cache[key];
    delete global.__v2heap;
}
function replay(){
    fresh();Game.time=fixture.tick;
    const calls=[];
    const objects={};
    const rooms=Object.entries(fixture.rooms).map(([name,list])=>{
        const stores=list.map(v=>{
            const s={id:v._id,structureType:v.type,my:true,pos:new RoomPosition(v.x,v.y,name),store:new Store(v.type==='lab'?5000:v.storeCapacity,false),cooldown:0};
            Object.assign(s.store,v.store);
            if(v.type==='lab'){
                s.store.getCapacity=r=>r==='energy'?2000:3000;
                s.store.getFreeCapacity=r=>s.store.getCapacity(r)-(s.store[r]||0);
            }
            objects[s.id]=s;return s;
        });
        const room={name,controller:{my:true,level:8},storage:stores.find(s=>s.structureType==='storage'),terminal:stores.find(s=>s.structureType==='terminal'),find:()=>stores};
        for(const s of stores)s.room=room;
        return {name,room,kind:'owned',policy:{state:'GROW',phase:'LABS'},stores};
    });
    Game.rooms=Object.fromEntries(rooms.map(rc=>[rc.name,rc.room]));Game.getObjectById=id=>objects[id]||null;
    Game.market={credits:fixture.credits,orders:Object.fromEntries(fixture.orders.map(o=>[o._id,{...o,id:o._id}])),
        getHistory:r=>fixture.histories[r]||[],
        getAllOrders:f=>(fixture.books[f.resourceType]||[]).filter(o=>o.type===f.type).map(o=>({...o,id:o._id})),
        calcTransactionCost:n=>Math.ceil(n*.1),
        createOrder:o=>{calls.push({action:'create',...o});const id='new'+calls.length;Game.market.orders[id]={...o,id,remainingAmount:o.totalAmount,created:Game.time};return OK;},
        changeOrderPrice:(id,price)=>{calls.push({action:'price',id,price});Game.market.orders[id].price=price;return OK;},
        extendOrder:(id,amount)=>{calls.push({action:'extend',id,amount});Game.market.orders[id].remainingAmount+=amount;return OK;},
        cancelOrder:id=>{calls.push({action:'cancel',id});delete Game.market.orders[id];return OK;}
    };
    return {ctx:{config:require('../../src/config').get(),roomList:rooms},calls,fixture};
}
module.exports={replay,fresh,fixture};
