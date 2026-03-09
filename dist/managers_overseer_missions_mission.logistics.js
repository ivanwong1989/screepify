const managerTerminal = require('managers_structures_manager.terminal');
const heap = require('utils_heap');

module.exports = {
    /**
     * Build all hauling/transfer missions for the current tick.
     *
     * High-level flow:
     * 1) Reconstruct currently active haul routes from creep memory.
     * 2) Add urgent refill missions (spawn/extension/tower/lab energy).
     * 3) Add inflow routes (dropped energy, scavenge, mining containers, links, consolidation).
     * 4) Apply terminal energy target logic.
     * 5) Apply terminal mineral stock-target plan (fill/flush/hold with deadband).
     * 6) Push generated missions into the shared `missions` array.
     *
     * This function intentionally does all decisions per tick from live state; route "age"
     * is kept in heap (volatile) to bias scheduling without growing persistent Memory.
     */
    generate: function(room, intel, context, missions) {

        /*
        const t0 = Game.cpu.getUsed();
        const mark = (label, last) => {
            const now = Game.cpu.getUsed();
            if (now - last > 0.1) console.log(`[logi cpu] ${room.name} ${label} +${(now - last).toFixed(2)}`);
            return now;
        };
        let t = t0;
        */

        const { opState, budget, efficientSources } = context;
        const isEmergency = opState === 'EMERGENCY';
        const enableHaulers = efficientSources.size > 0;

        if (!enableHaulers) return;

        // Active mission set for this tick. Includes reconstructed + newly generated missions.
        const activeMissions = new Map();
        const coveredSources = new Set();
        const coveredSourceResources = new Set();
        const coveredTargets = new Set();
        // Slot-aware route coverage (`haul:source:target[:resource]:sN`) to prevent duplicate scheduling.
        const coveredRouteSlots = new Set();

        const miningContainerIds = new Set(intel.sources.map(s => s.containerId).filter(id => id));
        const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
        const miningContainers = allContainers.filter(c => miningContainerIds.has(c.id));
        const nonMiningContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
        const storage = room.storage;
        const terminal = room.terminal;
        const spawns = intel.structures[STRUCTURE_SPAWN] || [];

        // Soft cap keeps hauler sizing in a practical range even if budget allows larger bodies.
        const MAX_HAULER_CARRY_PARTS = 25;

        const estimatedCarryParts = Math.max(1, Math.floor((budget || 0) / 100));
        const uncappedCarryParts = estimatedCarryParts;
        const carryParts = Math.min(uncappedCarryParts, MAX_HAULER_CARRY_PARTS);

        const haulTargets = storage ? [storage] : spawns;
        if (haulTargets.length === 0) return;

        const links = intel.structures[STRUCTURE_LINK] || [];
        // --- Per-tick caches (behavior-preserving) ---
        // Local object and distance caches reduce CPU churn from repeated lookups/range calls.
        const _idCache = new Map();
        const _cacheObj = (o) => { if (o && o.id) _idCache.set(o.id, o); };
        const _cacheList = (list) => {
            if (!Array.isArray(list) || list.length === 0) return;
            for (let i = 0; i < list.length; i++) _cacheObj(list[i]);
        };

        // Cache common room objects / intel lists (visible objects only).
        _cacheObj(storage);
        _cacheObj(terminal);
        _cacheList(allContainers);
        _cacheList(links);
        _cacheList(spawns);
        if (intel && intel.structures) {
            for (const k in intel.structures) _cacheList(intel.structures[k]);
        }
        _cacheList(intel.sources);
        _cacheList(intel.dropped);
        _cacheList(intel.ruins);
        _cacheList(intel.tombstones);

        // Range cache key: `${source.id}:${target.id}` used by slot sizing.
        this._routeDistCache = new Map();

        const _posKey = (pos) => (pos ? `${pos.roomName}:${pos.x}:${pos.y}` : '');
        const _closestByRange = (pos, sinks) => {
            if (!pos || !Array.isArray(sinks) || sinks.length === 0) return null;
            let best = null;
            let bestR = Infinity;
            for (let i = 0; i < sinks.length; i++) {
                const s = sinks[i];
                if (!s || !s.pos) continue;
                const r = pos.getRangeTo(s.pos);
                if (r < bestR) { bestR = r; best = s; }
            }
            return best;
        };


        // --- Route age cache ---
        // Tracks "how long a route has been waiting with resources present".
        // Stored in heap (not Memory) to avoid serialization cost and long-term bloat.
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // Store shape:
        // {
        //   rooms: { [roomName]: { [routeKey]: firstSeenGameTime } },
        //   lastPrune: Game.time
        // }
        const ageRoot = heap.getStore('logisticsRouteAge');
        if (!ageRoot.rooms) ageRoot.rooms = Object.create(null);
        if (!Number.isFinite(ageRoot.lastPrune)) ageRoot.lastPrune = 0;

        const routeAgeMem =
            ageRoot.rooms[room.name] ||
            (ageRoot.rooms[room.name] = Object.create(null));

        // Prune occasionally to avoid unbounded heap growth.
        // - Drop entries older than PRUNE_TTL
        // - Cap max entries per room
        const PRUNE_EVERY = 200;
        const PRUNE_TTL = 2000;
        const MAX_KEYS_PER_ROOM = 1500;

        if ((Game.time - (ageRoot.lastPrune || 0)) >= PRUNE_EVERY) {
            ageRoot.lastPrune = Game.time;

            for (const rn in ageRoot.rooms) {
                const rm = ageRoot.rooms[rn];
                if (!rm) continue;

                // TTL prune
                for (const k in rm) {
                    const t = rm[k];
                    if (!t || (Game.time - t) > PRUNE_TTL) delete rm[k];
                }

                // Size cap prune (best-effort)
                const keys = Object.keys(rm);
                if (keys.length > MAX_KEYS_PER_ROOM) {
                    keys.sort((a, b) => rm[a] - rm[b]); // oldest first
                    const removeN = keys.length - MAX_KEYS_PER_ROOM;
                    for (let i = 0; i < removeN; i++) delete rm[keys[i]];
                }
            }
        }

        // t = mark('routeAge-prune', t);

        // Helpers are attached on `this` so downstream methods can use them with minimal refactor.
        this._getRoutePolicy = (type, resourceType, cap) => {
            // Non-energy should generally be moved immediately.
            if (resourceType && resourceType !== RESOURCE_ENERGY) return { minAmount: 1, maxAgeTicks: 0, allowPartial: true };

            // Energy policies
            if (type === 'link_out') return { minAmount: 1, maxAgeTicks: 20, allowPartial: true };
            if (type === 'outflow') return { minAmount: 1, maxAgeTicks: 0, allowPartial: true };
            if (type === 'drop_mining') return { minAmount: 1, maxAgeTicks: 15, allowPartial: true };
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

        // 1) Reconstruct active hauling missions from creep memory so we preserve continuity.
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
                            (c.memory && c.memory._haulHint !== undefined)
                                ? c.memory._haulHint
                                : null;

                        // Preserve per-mission transfer hint so each slot can avoid over-pulling.
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
                            requirements: { archetype: 'hauler', minCount: 1, maxCount: 1, spawn: false },
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

        // t = mark('active-scan', t);

        // 2) Generate new missions
        // Refill sinks in one pass and reserve target ids immediately to avoid duplicates this tick.
        const tryAddSupply = (list) => {
            if (!Array.isArray(list) || list.length === 0) return;
            for (let i = 0; i < list.length; i++) {
                const target = list[i];
                if (!target || !target.store) continue;
                if (coveredTargets.has(target.id)) continue;
                if (target.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) continue;
                this.addSupplyMission(activeMissions, target, isEmergency);
                // prevent duplicate scheduling within the same tick
                coveredTargets.add(target.id);
            }
        };

        tryAddSupply(intel.structures[STRUCTURE_SPAWN]);
        tryAddSupply(intel.structures[STRUCTURE_EXTENSION]);
        tryAddSupply(intel.structures[STRUCTURE_TOWER]);
        // NOTE: labs intentionally included here for energy refill; mineral hauling is handled elsewhere.
        tryAddSupply(intel.structures[STRUCTURE_LAB]);

        // t = mark('refill-sinks', t);

        const inflowSinks = [];
        if (storage && storage.store && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) inflowSinks.push(storage);
        if (nonMiningContainers && nonMiningContainers.length > 0) {
            for (let i = 0; i < nonMiningContainers.length; i++) {
                const c = nonMiningContainers[i];
                if (!c || !c.store) continue;
                if (c.store.getFreeCapacity(RESOURCE_ENERGY) > 0) inflowSinks.push(c);
            }
        }
        //...(intel.structures[STRUCTURE_SPAWN] || []).filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0)

        if (inflowSinks.length > 0) {
            // --- Drop-mine pickup (small piles near efficient sources) + normal scavenge ---
            const effSources = (intel.sources || []).filter(s => s && efficientSources.has(s.id));

            // Precompute tiles adjacent to efficient sources (range 1). Behavior: identical to `inRangeTo(source, 1)`.
            const effAdj = new Set();
            if (effSources.length > 0) {
                for (let i = 0; i < effSources.length; i++) {
                    const s = effSources[i];
                    if (!s || !s.pos) continue;
                    const rn = s.pos.roomName;
                    const sx = s.pos.x;
                    const sy = s.pos.y;
                    for (let dx = -1; dx <= 1; dx++) {
                        const x = sx + dx;
                        if (x < 0 || x > 49) continue;
                        for (let dy = -1; dy <= 1; dy++) {
                            const y = sy + dy;
                            if (y < 0 || y > 49) continue;
                            effAdj.add(`${rn}:${x}:${y}`);
                        }
                    }
                }
            }

            // Drop-mine pickup: allow ALL adjacent piles (like scavenge)
            for (let i = 0; i < intel.dropped.length; i++) {
                const r = intel.dropped[i];
                if (!r || r.resourceType !== RESOURCE_ENERGY || (r.amount || 0) <= 0) continue;

                // Only consider drops adjacent to efficient sources
                if (effAdj.size === 0) continue;
                if (!effAdj.has(_posKey(r.pos))) continue;

                const bestSink = _closestByRange(r.pos, inflowSinks);
                if (!bestSink) continue;

                this.addLogisticsMissionsForRoute(
                    activeMissions,
                    coveredRouteSlots,
                    r,
                    bestSink,
                    isEmergency,
                    'drop_mining',
                    RESOURCE_ENERGY,
                    carryParts
                );
            }

            // Normal scavenge (keep your >100 threshold)
            const scavengeSources = [];
            for (let i = 0; i < intel.dropped.length; i++) {
                const r = intel.dropped[i];
                if (!r) continue;
                if (r.resourceType === RESOURCE_ENERGY && (r.amount || 0) > 100) scavengeSources.push(r);
            }
            for (let i = 0; i < intel.ruins.length; i++) {
                const r = intel.ruins[i];
                if (!r || !r.store) continue;
                if ((r.store[RESOURCE_ENERGY] || 0) > 0) scavengeSources.push(r);
            }
            for (let i = 0; i < intel.tombstones.length; i++) {
                const t = intel.tombstones[i];
                if (!t || !t.store) continue;
                if ((t.store[RESOURCE_ENERGY] || 0) > 0) scavengeSources.push(t);
            }

            for (let i = 0; i < scavengeSources.length; i++) {
                const source = scavengeSources[i];
                const bestSink = _closestByRange(source.pos, inflowSinks);
                if (bestSink) {
                    this.addLogisticsMissionsForRoute(
                        activeMissions,
                        coveredRouteSlots,
                        source,
                        bestSink,
                        isEmergency,
                        'scavenge',
                        RESOURCE_ENERGY,
                        carryParts
                    );
                }
            }

            for (let i = 0; i < miningContainers.length; i++) {
                const source = miningContainers[i];
                if (!source || !source.store) continue;
                if ((source.store[RESOURCE_ENERGY] || 0) < (carryParts * 50)) continue;
                const bestSink = _closestByRange(source.pos, inflowSinks);
                if (bestSink) this.addLogisticsMissionsForRoute(activeMissions, coveredRouteSlots, source, bestSink, isEmergency, 'mining', RESOURCE_ENERGY, carryParts);
            }
        }

        // t = mark('inflow-missions', t);

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

        // t = mark('terminal-energy', t);

        // --- Mineral logistics with terminal stockTargets (Memory.market.rooms.<room>.stockTargets) ---
        const hasTerminal = !!terminal;
        const hasStorage = !!storage;

        // Read room stockTargets safely (no optional chaining needed)
        let stockTargets = null;
        if (Memory.market && Memory.market.rooms && Memory.market.rooms[room.name]) {
            stockTargets = Memory.market.rooms[room.name].stockTargets || null;
        }


        // Terminal minerals use a stateless planning pass:
        // - compute fill/flush/hold around target with deadband
        // - cap terminal fill by per-tick remaining need to avoid overshoot across slots
        // - keep terminal_stock as single-servicer (see getHaulSlotsForRoute)
        const haulCap = Math.max(50, carryParts * 50);

        // Stateless terminal plan (target-aware) using a percentage deadband.
        // We avoid persistent state (mode locks / reservations). Instead we:
        // - Use a deadband sized as a % of target so we don't thrash on tiny deltas.
        // - Enforce terminal_stock routes as single-servicer (see getHaulSlotsForRoute).
        // - Pull minerals into terminal primarily from storage; other sources consolidate to storage first.
        //
        // Deadband: clamp(ceil(target * 5%), 50, 2000)
        const getDeadband = (tgt) => clamp(Math.ceil(tgt * 0.05), 50, 2000);

        // Build per-mineral terminal intent:
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

        // t = mark('terminal-plan', t);

        // Decide where each mineral should end up this tick.
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



        // 1) Flush excess/untargeted minerals from terminal into storage.
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

        // t = mark('terminal-flush', t);

        // 2) Consolidate minerals from structures to the chosen sink.
        // If filling terminal, consume from `fillRemaining` so total scheduled intake stays bounded.
        const hasNonEnergy = (store) => {
            if (!store) return false;
            // Fast path for Store API
            if (typeof store.getUsedCapacity === 'function') {
                const used = store.getUsedCapacity();
                if (!used || used <= 0) return false;
                const usedEnergy = store.getUsedCapacity(RESOURCE_ENERGY) || 0;
                return (used - usedEnergy) > 0;
            }
            // Fallback (should be rare)
            for (const k in store) {
                if (k === RESOURCE_ENERGY) continue;
                if ((store[k] || 0) > 0) return true;
            }
            return false;
        };

        // Guard against accidental duplicate objects across structure lists.
        const seenStructures = Object.create(null);

        const structsByType = intel.structures || {};
        for (const stype in structsByType) {
            const list = structsByType[stype];
            if (!Array.isArray(list) || list.length === 0) continue;

            // Skip lists handled by dedicated systems/logic.
            if (stype === STRUCTURE_LAB) continue;      // labs generate lab haul missions elsewhere
            if (stype === STRUCTURE_TERMINAL) continue; // terminal handled by terminalPlan (avoid hold->storage drain)

            for (let i = 0; i < list.length; i++) {
                const source = list[i];
                if (!source || !source.store) continue;
                if (seenStructures[source.id]) continue;
                seenStructures[source.id] = 1;

                // Early-exit: skip scanning store keys if it has no non-energy resources.
                if (!hasNonEnergy(source.store)) continue;

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
            }
        }

        // t = mark('structure-minerals', t);

        // 3) Dropped minerals
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

        // 4) Ruins + tombstones minerals
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

        // t = mark('scavenge-minerals', t);

        // 5) Energy consolidation/link drain into storage when capacity exists.
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

        //console.log(`[logi cpu] ${room.name} total ${(Game.cpu.getUsed() - t0).toFixed(2)}`);
    },

    /**
     * Estimate concurrent hauler slots (0..3) needed for one route.
     *
     * Inputs:
     * - source/target: pickup and dropoff objects
     * - resourceType: null/undefined means energy by default
     * - carryParts: carry body parts for this room's hauler design
     * - explicitNeed: optional bounded quantity requested by caller
     * - type: route class (`mining`, `scavenge`, `terminal_stock`, ...)
     * - routeKey: stable key for age gating
     *
     * Behavior:
     * - terminal_stock is forced to one hauler to avoid contention.
     * - energy routes are gated by minAmount + age override (route policy).
     * - non-energy generally moves immediately.
     */
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


        // Energy route gating: allow small amounts only after they've aged long enough.
        if (!isNonEnergy && typeof this._getRoutePolicy === 'function' && typeof this._getRouteAgeTicks === 'function') {
            const policy = this._getRoutePolicy(type, resourceType, cap);
            const ageTicks = this._getRouteAgeTicks(routeKey, amount);
            if (policy && amount < policy.minAmount && ageTicks < policy.maxAgeTicks) return 0;
        }

        let dist = 0;
        const distCache = this._routeDistCache;
        if (distCache && source && target) {
            const k = `${source.id}:${target.id}`;
            const cached = distCache.get(k);
            if (cached !== undefined) {
                dist = cached;
            } else {
                dist = source.pos.getRangeTo(target.pos);
                distCache.set(k, dist);
            }
        } else {
            dist = source.pos.getRangeTo(target.pos);
        }
        const travelTicks = dist * 2 + 10;
        const roundTrip = travelTicks * 2 + 10;
        const demandTrips = amount / cap;
        const desiredClearTicks = 100;

        let slots = Math.ceil((demandTrips * roundTrip) / desiredClearTicks);
        slots = Math.max(slots, 1);
        slots = Math.min(Math.max(slots, 0), 3);

        // Anti-oversubscription: trim extra slots if they only cover a tiny remainder
        // and policy prefers batching over partial servicing.
        if (!isNonEnergy && (explicitNeed === undefined || explicitNeed === null) && slots > 1 &&
            typeof this._getRoutePolicy === 'function' && typeof this._getRouteAgeTicks === 'function') {
            const policy = this._getRoutePolicy(type, resourceType, cap);
            const ageTicks = this._getRouteAgeTicks(routeKey, amount);

            if (policy && !policy.allowPartial) {
                while (slots > 1) {
                    const tailAmount = Math.max(0, amount - (cap * (slots - 1)));
                    if (tailAmount >= policy.minAmount || ageTicks >= policy.maxAgeTicks) break;
                    slots -= 1;
                }
            }
        }

        return slots;
    },

    /**
     * Add one or more slot-scoped haul missions for a route.
     * Mission names are route+slot (`...:s0`, `...:s1`, ...) so each slot can be tracked independently.
     */
    addLogisticsMissionsForRoute: function(activeMissions, coveredRouteSlots, source, target, isEmergency, type, resourceType, carryParts, explicitNeed) {
        // If the target is full... no need to schedule this mission....
        const rt = resourceType || RESOURCE_ENERGY;
        if (target && target.store && target.store.getFreeCapacity(rt) <= 0) return;
        
        const baseName = `haul:${source.id}:${target.id}`;
        const routeKey = resourceType ? `${baseName}:${resourceType}` : baseName;
        const slots = this.getHaulSlotsForRoute(source, target, resourceType, carryParts, explicitNeed, type, routeKey);
        if (slots <= 0) return;

        const cap = Math.max(50, carryParts * 50);
        const policy = (typeof this._getRoutePolicy === 'function')
            ? this._getRoutePolicy(type, resourceType, cap)
            : null;
        const allowPartial = !!(policy && policy.allowPartial);
        const isNonEnergy = !!(resourceType && resourceType !== RESOURCE_ENERGY);

        // Figure out how much is currently visible / desired on this route.
        let visibleAmount = 0;
        if (explicitNeed !== undefined && explicitNeed !== null) {
            visibleAmount = Math.max(0, Math.floor(Number(explicitNeed)) || 0);
        } else if (source && source.store) {
            visibleAmount = source.store[rt] || 0;
        } else if (source && source.amount !== undefined && source.amount !== null) {
            visibleAmount = source.amount || 0;
        }

        if (visibleAmount <= 0) return;

        // Reserve amount for already-existing slots first.
        // This is the missing behavior: if s0 is already active/covered,
        // later slot creation should see less remaining amount.
        let remaining = visibleAmount;

        for (let i = 0; i < slots; i += 1) {
            const missionName = `${routeKey}:s${i}`;
            if (!activeMissions.has(missionName) && !coveredRouteSlots.has(missionName)) continue;

            let reserved = cap;
            const existing = activeMissions.get(missionName);
            if (
                existing &&
                existing.data &&
                existing.data.amountHint !== undefined &&
                existing.data.amountHint !== null &&
                Number.isFinite(Number(existing.data.amountHint))
            ) {
                reserved = Math.max(0, Math.floor(Number(existing.data.amountHint)));
            }

            remaining = Math.max(0, remaining - reserved);
        }

        // Preserve explicitNeed splitting behavior for callers that use it.
        const hasNeed =
            explicitNeed !== undefined &&
            explicitNeed !== null &&
            Number.isFinite(Number(explicitNeed)) &&
            Number(explicitNeed) > 0;

        const totalNeed = hasNeed ? Math.floor(Number(explicitNeed)) : null;
        const perSlotNeed = hasNeed ? Math.max(1, Math.ceil(totalNeed / slots)) : null;

        // Reuse existing age override concept for small tails.
        const ageTicks =
            (!isNonEnergy && typeof this._getRouteAgeTicks === 'function')
                ? this._getRouteAgeTicks(routeKey, visibleAmount)
                : 0;

        for (let i = 0; i < slots; i += 1) {
            const missionName = `${routeKey}:s${i}`;
            if (activeMissions.has(missionName)) continue;
            if (coveredRouteSlots.has(missionName)) continue;
            if (remaining <= 0) break;

            // For normal energy routes that do NOT allow partial servicing,
            // don't create a new extra slot for a tiny leftover tail unless age overrides it.
            if (
                !hasNeed &&
                !isNonEnergy &&
                policy &&
                !policy.allowPartial &&
                remaining < policy.minAmount &&
                ageTicks < policy.maxAgeTicks
            ) {
                break;
            }

            const amountHint = hasNeed
                ? Math.max(0, Math.min(perSlotNeed, remaining))
                : Math.max(0, Math.min(cap, remaining));

            if (amountHint <= 0) break;

            activeMissions.set(missionName, {
                name: missionName,
                type: 'transfer',
                archetype: 'hauler',
                targetId: target.id,
                data: {
                    sourceId: source.id,
                    resourceType: resourceType,
                    allowPartial: allowPartial,
                    amountHint: amountHint
                },
                requirements: { archetype: 'hauler', minCount: 1, maxCount: 1, spawn: false },
                priority: this.getLogisticsPriority(type, target, isEmergency)
            });

            coveredRouteSlots.add(missionName);
            remaining -= amountHint;
        }
    },

    /**
     * Add a generic "supply this structure with energy" mission.
     * Source is selected by the transfer behavior using mode='supply'.
     */
    addSupplyMission: function(activeMissions, target, isEmergency) {
        const missionName = `supply:${target.id}`;
        if (activeMissions.has(missionName)) return;
        activeMissions.set(missionName, {
            name: missionName,
            type: 'transfer',
            archetype: 'hauler',
            targetId: target.id,
            data: { resourceType: RESOURCE_ENERGY, mode: 'supply' },
            requirements: { archetype: 'hauler', minCount: 1, maxCount: 1, spawn: false },
            priority: this.getLogisticsPriority('outflow', target, isEmergency)
        });
    },

    /**
     * Priority model:
     * - `outflow` (spawn/extension/tower refill) is highest; boosted in emergency.
     * - throughput helpers (`link_out`, `scavenge`, `drop_mining`) are mid-tier.
     * - bulk background work (`mining`, `terminal_stock`, consolidation) is lower.
     */
    getLogisticsPriority: function(type, target, isEmergency) {
        if (type === 'outflow') {
            if (target.structureType === STRUCTURE_TOWER) return isEmergency ? 950 : 95;
            if (target.structureType === STRUCTURE_SPAWN || target.structureType === STRUCTURE_EXTENSION) return isEmergency ? 900 : 90;
            return 50;
        }
        if (type === 'link_out') return 55;
        if (type === 'scavenge') return 45;
        if (type === 'drop_mining') return 47;
        if (type === 'mining') return 30;
        if (type === 'terminal_stock') return 20;
        return 10;
    }
};
