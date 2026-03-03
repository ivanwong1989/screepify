const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const managerTerminal = require('managers_structures_manager.terminal');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { opState, budget, efficientSources } = context;
        const isEmergency = opState === 'EMERGENCY';
        const enableHaulers = efficientSources.size > 0;

        if (!enableHaulers) return;

        const activeMissions = new Map();
        const coveredSources = new Set();
        const coveredSourceResources = new Set();
        const coveredTargets = new Set();
        const coveredRouteSlots = new Set();

        const miningContainerIds = new Set(intel.sources.map(s => s.containerId).filter(id => id));
        const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
        const miningContainers = allContainers.filter(c => miningContainerIds.has(c.id));
        const nonMiningContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
        const storage = room.storage;
        const terminal = room.terminal;
        const spawns = intel.structures[STRUCTURE_SPAWN] || [];

        const MAX_HAULER_CARRY_PARTS = 16;

        const haulerStats = managerSpawner.checkBody('hauler', budget);
        const uncappedCarryParts = haulerStats.carry || 1;
        const carryParts = Math.min(uncappedCarryParts, MAX_HAULER_CARRY_PARTS);

        const haulTargets = storage ? [storage] : spawns;
        if (haulTargets.length === 0) return;

        const links = intel.structures[STRUCTURE_LINK] || [];

        // --- Route gating helpers (scalable for tiny -> giga haulers) ---
        // Problem this solves: once haulers get large, "amount < cap * X" gating causes small-but-important sources
        // (e.g., storage links, leftovers) to never generate hauling missions.
        //
        // Solution:
        //  - Use bounded absolute min amounts (clamped by cap but never exploding).
        //  - Add an "age override" so small leftovers are eventually cleaned up.
        const roomMem = (Memory.rooms && Memory.rooms[room.name]) ? Memory.rooms[room.name] : (Memory.rooms[room.name] = {});
        const routeAgeMem = roomMem._logisticsRouteAge || (roomMem._logisticsRouteAge = {});
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // Attach to module instance so other methods can use them without refactoring callsites.
        this._getRoutePolicy = (type, resourceType, cap) => {
            // Non-energy should generally be moved immediately.
            if (resourceType && resourceType !== RESOURCE_ENERGY) return { minAmount: 1, maxAgeTicks: 0, allowPartial: true };

            // Energy policies
            if (type === 'link_out') return { minAmount: 1, maxAgeTicks: 20, allowPartial: true };
            if (type === 'outflow') return { minAmount: 1, maxAgeTicks: 0, allowPartial: true };
            if (type === 'scavenge') return { minAmount: clamp(Math.floor(cap * 0.15), 50, 300), maxAgeTicks: 200, allowPartial: true };
            if (type === 'mining') return { minAmount: clamp(Math.floor(cap * 0.35), 100, 800), maxAgeTicks: 450, allowPartial: false };
            if (type === 'consolidation') return { minAmount: clamp(Math.floor(cap * 0.25), 100, 800), maxAgeTicks: 650, allowPartial: false };
            if (type === 'terminal_stock') return { minAmount: clamp(Math.floor(cap * 0.25), 50, 800), maxAgeTicks: 650, allowPartial: false };
            return { minAmount: clamp(Math.floor(cap * 0.25), 50, 800), maxAgeTicks: 650, allowPartial: false };
        };

        this._getRouteAgeTicks = (routeKey, amount) => {
            if (!routeKey) return 0;
            if (!amount || amount <= 0) {
                if (routeAgeMem[routeKey]) delete routeAgeMem[routeKey];
                return 0;
            }
            if (!routeAgeMem[routeKey]) routeAgeMem[routeKey] = Game.time;
            return Math.max(0, Game.time - routeAgeMem[routeKey]);
        };

        // 1. Identify active hauling missions
        intel.myCreeps.forEach(c => {
            if (c.memory.missionName && c.memory.missionName.startsWith('haul:')) {
                const parts = c.memory.missionName.split(':');
                if (parts.length >= 3) {
                    const sourceId = parts[1];
                    const targetId = parts[2];
                    const lastPart = parts[parts.length - 1];
                    const hasSlot = lastPart && lastPart.startsWith('s');
                    const slot = hasSlot ? lastPart : null;
                    const resourceType = parts[3] && !parts[3].startsWith('s') ? parts[3] : undefined;
                    const source = Game.getObjectById(sourceId);
                    const target = Game.getObjectById(targetId);
                    
                    if (source && target) {
                        let type = 'misc';
                        if ([STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER].includes(target.structureType)) {
                            type = 'outflow';
                        } else if (source instanceof Resource || source instanceof Tombstone || source instanceof Ruin) {
                            type = 'scavenge';
                        } else if (target.structureType === STRUCTURE_STORAGE) {
                            if (source.structureType === STRUCTURE_LINK) {
                                type = 'link_out';
                            } else {
                                type = miningContainerIds.has(source.id) ? 'mining' : 'consolidation';
                            }
                        } else if (target.structureType === STRUCTURE_TERMINAL) {
                            type = 'terminal_stock';
                        } else if (target.structureType === STRUCTURE_CONTAINER) {
                            type = miningContainerIds.has(source.id) ? 'mining' : 'scavenge';
                        }

                        const baseName = `haul:${sourceId}:${targetId}`;
                        const routeKey = resourceType ? `${baseName}:${resourceType}` : baseName;
                        const fullMissionName = slot ? `${routeKey}:${slot}` : routeKey;
                        // --- preserve hint from creep memory (written by transfer.js) ---
                        const amountHint =
                            c.memory &&
                            c.memory._haulHints &&
                            c.memory._haulHints[fullMissionName] !== undefined
                                ? c.memory._haulHints[fullMissionName]
                                : null;

                        const mission = {
                            name: fullMissionName,
                            type: 'transfer',
                            archetype: 'hauler',
                            targetId: targetId,
                            data: {
                                sourceId: sourceId,
                                resourceType: resourceType,
                                amountHint: amountHint
                            },
                            requirements: { archetype: 'hauler', count: 1, spawn: false },
                            priority: this.getLogisticsPriority(type, target, isEmergency)
                        };
                        activeMissions.set(fullMissionName, mission);
                        coveredRouteSlots.add(fullMissionName);
                        coveredSources.add(sourceId);
                        if (resourceType) coveredSourceResources.add(`${sourceId}:${resourceType}`);
                        coveredTargets.add(targetId);
                    }
                }
            }
        });

        // 2. Generate New Missions
        const refillSinks = [
            ...(intel.structures[STRUCTURE_SPAWN] || []),
            ...(intel.structures[STRUCTURE_EXTENSION] || []),
            ...(intel.structures[STRUCTURE_TOWER] || []),
            ...(intel.structures[STRUCTURE_LAB] || [])
        ].filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);

        refillSinks.forEach(target => {
            if (coveredTargets.has(target.id)) return;
            this.addSupplyMission(activeMissions, target, isEmergency);
        });

        const inflowSinks = [
            ...(storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? [storage] : []),
            ...nonMiningContainers.filter(c => c.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
        ];

        if (inflowSinks.length > 0) {
            const scavengeSources = [
                ...intel.dropped.filter(r => r.resourceType === RESOURCE_ENERGY && r.amount > 100),
                ...intel.ruins.filter(r => r.store[RESOURCE_ENERGY] > 0),
                ...intel.tombstones.filter(t => t.store[RESOURCE_ENERGY] > 0)
            ];
            scavengeSources.forEach(source => {
                const bestSink = source.pos.findClosestByRange(inflowSinks);
                if (bestSink) this.addLogisticsMissionsForRoute(activeMissions, coveredRouteSlots, source, bestSink, isEmergency, 'scavenge', RESOURCE_ENERGY, carryParts);
            });

            miningContainers.filter(c => c.store[RESOURCE_ENERGY] >= (carryParts * 50)).forEach(source => {
                const bestSink = source.pos.findClosestByRange(inflowSinks);
                if (bestSink) this.addLogisticsMissionsForRoute(activeMissions, coveredRouteSlots, source, bestSink, isEmergency, 'mining', RESOURCE_ENERGY, carryParts);
            });
        }

        if (storage && terminal) {
            const baseCfg = managerTerminal.getConfig();
            const roomOverride = (baseCfg.rooms && baseCfg.rooms[room.name]) || null;
            const roomCfg = roomOverride ? Object.assign({}, baseCfg, roomOverride) : baseCfg;
            const target = roomCfg.terminalEnergyTarget || 0;

            if (target > 0) {
                const cur = terminal.store[RESOURCE_ENERGY] || 0;
                if (cur < target) {
                    const stor = storage.store[RESOURCE_ENERGY] || 0;
                    if (stor > 0) {
                        const need = Math.min(target - cur, stor);
                        if (need > 0) {
                            const missionName = `haul:${storage.id}:${terminal.id}:${RESOURCE_ENERGY}`;
                            if (!activeMissions.has(missionName)) {
                                this.addLogisticsMissionsForRoute(activeMissions, coveredRouteSlots, storage, terminal, isEmergency, 'terminal_stock', RESOURCE_ENERGY, carryParts, need);
                                debug('mission.logistics', `[TerminalStock] ${room.name} refill terminal energy cur=${cur} target=${target} need=${need}`);
                            }
                        }
                    }
                }
            }
        }

        // --- Mineral logistics with terminal stockTargets (Memory.market.rooms.<room>.stockTargets) ---
        const hasTerminal = !!terminal;
        const hasStorage = !!storage;

        // Read room stockTargets safely (no optional chaining needed)
        let stockTargets = null;
        if (Memory.market && Memory.market.rooms && Memory.market.rooms[room.name]) {
            stockTargets = Memory.market.rooms[room.name].stockTargets || null;
        }


        // Terminal stockTargets can create "ping-pong" near the target (flush then refill).
        // Fix: add per-mineral MODE LOCK + per-tick RESERVATIONS so we never schedule both directions
        // and never overshoot targets due to multiple haulers/slots.
        //
        // Notes:
        // - This only affects terminal <-> storage decisions for minerals (and later could be reused for terminal energy target).
        // - Energy logistics elsewhere remains untouched.
        const haulCap = Math.max(50, carryParts * 50);

        // Stateless terminal plan (target-aware) using a percentage deadband.
        // We avoid persistent state (mode locks / reservations). Instead we:
        // - Use a deadband sized as a % of target so we don't thrash on tiny deltas.
        // - Enforce terminal_stock routes as single-servicer (see getHaulSlotsForRoute).
        // - Pull minerals into terminal primarily from storage; other sources consolidate to storage first.
        //
        // Deadband: clamp(ceil(target * 5%), 50, 2000)
        const getDeadband = (tgt) => clamp(Math.ceil(tgt * 0.05), 50, 2000);

        // Build a per-mineral terminal plan (stateless).
        // - targeted (tgt > 0): FILL / FLUSH / HOLD around target with deadband
        // - untargeted (tgt <= 0): flush_all if terminal has any
        const terminalPlan = {};
        if (hasTerminal) {
            const keys = new Set();
            if (stockTargets) Object.keys(stockTargets).forEach(k => keys.add(k));
            Object.keys(terminal.store || {}).forEach(k => keys.add(k));

            keys.forEach(resourceType => {
                if (!resourceType || resourceType === RESOURCE_ENERGY) return;

                const tgt = (stockTargets && stockTargets[resourceType]) ? stockTargets[resourceType] : 0;
                const termAmt = terminal.store[resourceType] || 0;

                if (tgt > 0) {
                    const db = getDeadband(tgt);
                    const lo = tgt - db;
                    const hi = tgt + db;

                    if (termAmt < lo) {
                        terminalPlan[resourceType] = { action: 'fill', need: Math.max(0, tgt - termAmt), tgt: tgt, termAmt: termAmt, db: db };
                    } else if (termAmt > hi) {
                        terminalPlan[resourceType] = { action: 'flush', excess: Math.max(0, termAmt - tgt), tgt: tgt, termAmt: termAmt, db: db };
                    } else {
                        terminalPlan[resourceType] = { action: 'hold', tgt: tgt, termAmt: termAmt, db: db };
                    }
                } else {
                    if (termAmt > 0) terminalPlan[resourceType] = { action: 'flush_all', excess: termAmt, tgt: 0, termAmt: termAmt, db: 0 };
                }
            });
        }

        // Decide desired sink for a mineral based on the terminal plan.
        // - If plan says FILL: sink=terminal (but we will only source from storage)
        // - Else: prefer storage (hold zone, or while flushing)

        // - If plan says FILL: sink=terminal, with remaining need
        // - Else: prefer storage (hold zone, or while flushing)
        const decideMineralSink = (resourceType, source) => {
            const plan = terminalPlan ? terminalPlan[resourceType] : null;

            if (hasTerminal && plan && plan.action === 'fill') {
                // To keep terminal_stock single-servicer and predictable, pull from storage only.
                if (source && source.structureType === STRUCTURE_STORAGE) {
                    return { sink: terminal, sinkType: 'terminal_stock', need: plan.need };
                }
            }

            if (hasStorage) return { sink: storage, sinkType: 'consolidation', need: null };

            return { sink: terminal, sinkType: 'terminal_stock', need: null };
        };

        // Track remaining terminal fill need per mineral for THIS tick (stateless, prevents overscheduling).
        const fillRemaining = {};
        if (terminalPlan) {
            for (const r in terminalPlan) {
                const plan = terminalPlan[r];
                if (plan && plan.action === 'fill' && plan.need > 0) fillRemaining[r] = plan.need;
            }
        }
        const takeFill = (resourceType, available) => {
            const rem = fillRemaining[resourceType] || 0;
            if (rem <= 0 || !available || available <= 0) return 0;
            const take = Math.min(rem, available, haulCap);
            if (take > 0) fillRemaining[resourceType] = rem - take;
            return take;
        };



        // 1) Flush excess/untargeted minerals OUT of terminal into storage (only when plan says FLUSH/FLUSH_ALL).
        if (hasTerminal && hasStorage) {
            for (const resourceType in terminalPlan) {
                const plan = terminalPlan[resourceType];
                if (!plan) continue;
                if (plan.action !== 'flush' && plan.action !== 'flush_all') continue;

                const amount = plan.excess || 0;
                if (amount <= 0) continue;

                const termNow = terminal.store[resourceType] || 0;
                const flushAmt = Math.min(amount, termNow);
                if (flushAmt <= 0) continue;
                this.addLogisticsMissionsForRoute(
                    activeMissions,
                    coveredRouteSlots,
                    terminal,
                    storage,
                    isEmergency,
                    'consolidation',
                    resourceType,
                    carryParts,
                    flushAmt
                );
            }
        }

        // 2) Consolidate minerals from structures to the chosen sink per mineral (policy-driven).
        // IMPORTANT: if filling terminal, cap by remaining need (per-tick fillRemaining) so we don't overshoot.
        const allStructureLists = Object.values(intel.structures || {});
        const seenStructures = new Set();

        allStructureLists.forEach(list => {
            if (!Array.isArray(list)) return;
            list.forEach(source => {
                if (!source || !source.store) return;
                if (source.structureType === STRUCTURE_LAB) return;
                if (source.structureType === STRUCTURE_TERMINAL) return; // terminal handled by terminalPlan (avoid hold->storage drain)
                if (seenStructures.has(source.id)) return;
                seenStructures.add(source.id);

                for (const resourceType in source.store) {
                    if (resourceType === RESOURCE_ENERGY) continue;

                    const amt = source.store[resourceType] || 0;
                    if (amt <= 0) continue;

                    const decision = decideMineralSink(resourceType, source);
                    const sink = decision.sink;
                    if (!sink) continue;
                    if (source.id === sink.id) continue;

                    if (sink === terminal && decision.need !== null && decision.need !== undefined) {
                    const take = takeFill(resourceType, Math.min(decision.need, amt));
                    if (take <= 0) continue;

                        this.addLogisticsMissionsForRoute(
                            activeMissions,
                            coveredRouteSlots,
                            source,
                            sink,
                            isEmergency,
                            decision.sinkType,
                            resourceType,
                            carryParts,
                            take
                        );
                    } else {
                        this.addLogisticsMissionsForRoute(
                            activeMissions,
                            coveredRouteSlots,
                            source,
                            sink,
                            isEmergency,
                            decision.sinkType,
                            resourceType,
                            carryParts
                        );
                    }
                }
            });
        });

        // Dropped minerals
        intel.dropped.forEach(source => {
            if (!source || source.resourceType === RESOURCE_ENERGY || source.amount <= 0) return;

            const resourceType = source.resourceType;
            const decision = decideMineralSink(resourceType, source);
            const sink = decision.sink;
            if (!sink) return;

            if (sink === terminal && decision.need !== null && decision.need !== undefined) {
                const take = takeFill(resourceType, Math.min(decision.need, source.amount));
                if (take <= 0) return;

                this.addLogisticsMissionsForRoute(
                    activeMissions,
                    coveredRouteSlots,
                    source,
                    sink,
                    isEmergency,
                    decision.sinkType,
                    resourceType,
                    carryParts,
                    take
                );
            } else {
                this.addLogisticsMissionsForRoute(activeMissions, coveredRouteSlots, source, sink, isEmergency, 'scavenge', resourceType, carryParts);
            }
        });

        // Ruins + tombstones minerals
        const scavengeStores = [
            ...(intel.ruins || []),
            ...(intel.tombstones || [])
        ];
        scavengeStores.forEach(source => {
            const store = source && source.store ? source.store : null;
            if (!store) return;

            for (const resourceType in store) {
                if (resourceType === RESOURCE_ENERGY) continue;

                const amt = store[resourceType] || 0;
                if (amt <= 0) continue;

                const decision = decideMineralSink(resourceType, source);
                const sink = decision.sink;
                if (!sink) continue;

                if (sink === terminal && decision.need !== null && decision.need !== undefined) {
                    const take = takeFill(resourceType, Math.min(decision.need, amt));
                    if (take <= 0) continue;

                    this.addLogisticsMissionsForRoute(
                        activeMissions,
                        coveredRouteSlots,
                        source,
                        sink,
                        isEmergency,
                        decision.sinkType,
                        resourceType,
                        carryParts,
                        take
                    );
                } else {
                    this.addLogisticsMissionsForRoute(activeMissions, coveredRouteSlots, source, sink, isEmergency, 'scavenge', resourceType, carryParts);
                }
            }
        });

        if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            nonMiningContainers.filter(c => c.store[RESOURCE_ENERGY] >= 500 && c.id !== intel.controllerContainerId).forEach(source => {
                this.addLogisticsMissionsForRoute(activeMissions, coveredRouteSlots, source, storage, isEmergency, 'consolidation', RESOURCE_ENERGY, carryParts);
            });

            links.filter(l => l.store[RESOURCE_ENERGY] > 0 && (l.pos.inRangeTo(storage.pos, 3) || spawns.some(s => l.pos.inRangeTo(s.pos, 3)))).forEach(link => {
                if (room.controller && link.pos.inRangeTo(room.controller.pos, 3)) return;
                this.addLogisticsMissionsForRoute(activeMissions, coveredRouteSlots, link, storage, isEmergency, 'link_out', RESOURCE_ENERGY, carryParts);
            });
        }

        for (const m of activeMissions.values()) missions.push(m);
    },

    getHaulSlotsForRoute: function(source, target, resourceType, carryParts, explicitNeed, type, routeKey) {
        const cap = Math.max(50, carryParts * 50);
        let amount = 0;

        // terminal_stock is intentionally single-servicer to avoid contention/ping-pong.
        if (type === 'terminal_stock') {
            // We'll compute amount below; return 1 slot if there is any meaningful amount.
        }
        const isNonEnergy = resourceType && resourceType !== RESOURCE_ENERGY;
        if (explicitNeed !== undefined && explicitNeed !== null) {
            amount = explicitNeed;
        } else if (source && source.store) {
            const type = resourceType || RESOURCE_ENERGY;
            amount = source.store[type] || 0;
        } else if (source && source.amount !== undefined && source.amount !== null) {
            amount = source.amount || 0;
        }

        if (amount <= 0) {
            // Clear age memory if we stop seeing resources on this route.
            if (this._getRouteAgeTicks) this._getRouteAgeTicks(routeKey, 0);
            return 0;
        }

        if (type === 'terminal_stock') {
            // Always cap to a single hauler for terminal stock management.
            return 1;
        }


        // Scalable gating (energy only): bounded min threshold + age override.
        if (!isNonEnergy && typeof this._getRoutePolicy === 'function' && typeof this._getRouteAgeTicks === 'function') {
            const policy = this._getRoutePolicy(type, resourceType, cap);
            const ageTicks = this._getRouteAgeTicks(routeKey, amount);
            if (policy && amount < policy.minAmount && ageTicks < policy.maxAgeTicks) return 0;
        }

        const dist = source.pos.getRangeTo(target.pos);
        const travelTicks = dist * 2 + 10;
        const roundTrip = travelTicks * 2 + 10;
        const demandTrips = amount / cap;
        const desiredClearTicks = 100;

        let slots = Math.ceil((demandTrips * roundTrip) / desiredClearTicks);
        slots = Math.max(slots, 1);
        return Math.min(Math.max(slots, 0), 3);
    },

    addLogisticsMissionsForRoute: function(activeMissions, coveredRouteSlots, source, target, isEmergency, type, resourceType, carryParts, explicitNeed) {
        const baseName = `haul:${source.id}:${target.id}`;
        const routeKey = resourceType ? `${baseName}:${resourceType}` : baseName;
        const slots = this.getHaulSlotsForRoute(source, target, resourceType, carryParts, explicitNeed, type, routeKey);
        if (slots <= 0) return;

        const cap = Math.max(50, carryParts * 50);
        const policy = (typeof this._getRoutePolicy === 'function') ? this._getRoutePolicy(type, resourceType, cap) : null;
        const allowPartial = !!(policy && policy.allowPartial);

        // If an explicitNeed is provided, distribute it across slots so multiple haulers don't each pull the full need.
        const hasNeed = (explicitNeed !== undefined && explicitNeed !== null && Number.isFinite(Number(explicitNeed)) && Number(explicitNeed) > 0);
        const totalNeed = hasNeed ? Math.floor(Number(explicitNeed)) : null;
        const perSlotNeed = hasNeed ? Math.max(1, Math.ceil(totalNeed / slots)) : null;

        for (let i = 0; i < slots; i += 1) {
            const missionName = `${routeKey}:s${i}`;
            if (activeMissions.has(missionName)) continue;
            if (coveredRouteSlots.has(missionName)) continue;
            activeMissions.set(missionName, {
                name: missionName,
                type: 'transfer',
                archetype: 'hauler',
                targetId: target.id,
                data: {
                    sourceId: source.id,
                    resourceType: resourceType,
                    allowPartial: allowPartial,
                    amountHint: (hasNeed ? Math.max(0, Math.min(perSlotNeed, totalNeed - (i * perSlotNeed))) : null)
                },
                requirements: { archetype: 'hauler', count: 1, spawn: false },
                priority: this.getLogisticsPriority(type, target, isEmergency)
            });
        }
    },

    addSupplyMission: function(activeMissions, target, isEmergency) {
        const missionName = `supply:${target.id}`;
        if (activeMissions.has(missionName)) return;
        activeMissions.set(missionName, {
            name: missionName,
            type: 'transfer',
            archetype: 'hauler',
            targetId: target.id,
            data: { resourceType: RESOURCE_ENERGY, mode: 'supply' },
            requirements: { archetype: 'hauler', count: 1, spawn: false },
            priority: this.getLogisticsPriority('outflow', target, isEmergency)
        });
    },

    getLogisticsPriority: function(type, target, isEmergency) {
        if (type === 'outflow') {
            if (target.structureType === STRUCTURE_TOWER) return isEmergency ? 950 : 95;
            if (target.structureType === STRUCTURE_SPAWN || target.structureType === STRUCTURE_EXTENSION) return isEmergency ? 900 : 90;
            return 50;
        }
        if (type === 'link_out') return 55;
        if (type === 'scavenge') return 45;
        if (type === 'mining') return 30;
        if (type === 'terminal_stock') return 20;
        return 10;
    }
};
