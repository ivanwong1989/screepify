// @ts-check
'use strict';

const roomData = require('../../services/roomData');

/**
 * Links (port of v1 manager.links).
 *
 * Source links (range 2 of a source) send to receivers: controller links
 * (range 3) if any, else spawn links, else any other link. Only transfers more
 * than 600 energy at a time.
 */

const MIN_TRANSFER = 600;

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'act.links',
    phase: 'ACT',
    scope: 'room',
    kinds: ['owned'],
    tier: 'normal',
    priority: 30,
    run(ctx, rc) {
        const room = rc.room;
        const links = roomData.myByType(room, STRUCTURE_LINK);
        if (links.length < 2) return;
        const sources = roomData.sources(room);
        const senders = links.filter(l => sources.some(s => l.pos.inRangeTo(s.pos, 2)));
        if (senders.length === 0) return;
        const others = links.filter(l => senders.indexOf(l) === -1);
        if (others.length === 0) return;

        const ctrl = room.controller;
        const spawns = roomData.myByType(room, STRUCTURE_SPAWN);
        const ctrlLinks = ctrl ? others.filter(l => l.pos.inRangeTo(ctrl.pos, 3)) : [];
        const spawnLinks = others.filter(l => spawns.some(s => l.pos.inRangeTo(s.pos, 3)));
        const receivers = (ctrlLinks.length ? ctrlLinks : spawnLinks.length ? spawnLinks : others)
            .filter(l => l.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
            .sort((a, b) => b.store.getFreeCapacity(RESOURCE_ENERGY) - a.store.getFreeCapacity(RESOURCE_ENERGY));
        if (receivers.length === 0) return;

        const ready = senders.filter(l => l.cooldown === 0 && l.store[RESOURCE_ENERGY] > 0)
            .sort((a, b) => b.store[RESOURCE_ENERGY] - a.store[RESOURCE_ENERGY]);
        for (const sender of ready) {
            const receiver = receivers.find(l => l.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            if (!receiver) break;
            const amount = Math.min(sender.store[RESOURCE_ENERGY], receiver.store.getFreeCapacity(RESOURCE_ENERGY));
            if (amount <= MIN_TRANSFER) continue;
            sender.transferEnergy(receiver, amount);
        }
    }
};
