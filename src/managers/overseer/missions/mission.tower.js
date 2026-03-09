const overseerOpportunisticRepair = require('managers_overseer_intel_overseer.opportunistic.repair');

module.exports = {

    generate: function(room, intel, context, missions) {

        const DEFENDER_DPS = 90;
        const RAMPART_INTERCEPT_RANGE = 8;
        const DEFENSE_RING_RADIUS = 8;
        const RING_SEARCH_RADIUS = 2;
        const debugCategories = Memory.debugCategories;
        const towerDebugEnabled = !!Memory.debug && (
            !debugCategories ||
            typeof debugCategories !== 'object' ||
            !!debugCategories['mission.tower']
        );
        const towerDebug = (buildMessage) => {
            if (!towerDebugEnabled) return;
            const message = (typeof buildMessage === 'function') ? buildMessage() : buildMessage;
            debug('mission.tower', message);
        };

        // --- Boost-aware helpers ---
        const getBoostedHealPowerPerPart = (boost, isRanged) => {
            // Base powers: heal=12, rangedHeal=4
            // Boost multipliers live in BOOSTS[HEAL][<mineral>].heal / .rangedHeal
            const base = isRanged ? 4 : 12;
            try {
                if (typeof BOOSTS !== 'undefined' && boost && BOOSTS[HEAL] && BOOSTS[HEAL][boost]) {
                    const mult = isRanged ? BOOSTS[HEAL][boost].rangedHeal : BOOSTS[HEAL][boost].heal;
                    return base * (mult || 1);
                }
            } catch (e) {}
            return base;
        };

        const towerDamageAtRange = (range) => {
            if (range <= 5) return 600;
            if (range >= 20) return 150;
            return 600 - (range - 5) * 30;
        };

        const estimateIncomingHealAtPos = (target, targetPos, hostiles) => {
            // Sum of all *possible* healing that could land on target this tick
            // - range <= 1 : heal() => 12 * mult per HEAL part
            // - range 2..3 : rangedHeal() => 4 * mult per HEAL part
            let incoming = 0;

            for (const h of hostiles) {
                if (!h || !h.body || h.body.length === 0 || !h.pos) continue;

                const r = h.id === target.id
                    ? 0
                    : Math.max(Math.abs(h.pos.x - targetPos.x), Math.abs(h.pos.y - targetPos.y));

                const isHeal = (r <= 1);
                const isRangedHeal = (!isHeal && r <= 3);
                if (!isHeal && !isRangedHeal) continue;

                for (const part of h.body) {
                    if (part.type !== HEAL || part.hits <= 0) continue;
                    incoming += getBoostedHealPowerPerPart(part.boost, isRangedHeal);
                }
            }

            return incoming;
        };

        const estimateTowerDamageVsTough = (rawDamage, hostile) => {
            // Approximation: apply an "expected damage multiplier" based on active TOUGH parts.
            // - unboosted TOUGH has multiplier 1 (no reduction)
            // - boosted TOUGH uses BOOSTS[TOUGH][boost].damage (e.g. 0.7 / 0.5 / 0.3)
            // We average multipliers across active body parts. This is not perfect (real damage
            // is applied in body order), but it's a good cheap signal for "tough brick".
            if (!hostile.body || hostile.body.length === 0) return rawDamage;

            let sumMult = 0;
            let count = 0;

            for (const part of hostile.body) {
                if (part.hits <= 0) continue;
                count++;

                if (part.type === TOUGH) {
                    let mult = 1;
                    try {
                        if (typeof BOOSTS !== 'undefined' && part.boost && BOOSTS[TOUGH] && BOOSTS[TOUGH][part.boost]) {
                            mult = BOOSTS[TOUGH][part.boost].damage || 1;
                        }
                    } catch (e) {}
                    sumMult += mult;
                } else {
                    sumMult += 1;
                }
            }

            if (count <= 0) return rawDamage;
            const expectedMult = sumMult / count;
            return rawDamage * expectedMult;
        };

        const estimateBoostedHealParts = (hostile) => {
            // Used only for scoring bias / debugging (how "healer-ish" this target is)
            if (!hostile.body || hostile.body.length === 0) return { parts: 0, healAt1: 0 };
            let parts = 0;
            let healAt1 = 0;
            for (const part of hostile.body) {
                if (part.type !== HEAL || part.hits <= 0) continue;
                parts++;
                healAt1 += getBoostedHealPowerPerPart(part.boost, false);
            }
            return { parts, healAt1 };
        };

        const activeTowers = (() => {
            const cache = global.getRoomCache(room);
            const towers = (cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_TOWER]) || [];
            return towers.filter(t => t && t.store && t.store[RESOURCE_ENERGY] >= 10);
        })();

        const roomTerrain = room.getTerrain ? room.getTerrain() : null;
        const cache = global.getRoomCache(room);
        const myRamparts = (cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_RAMPART]) || [];
        const mySpawns = (cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_SPAWN]) || [];
        const myStorage = room.storage || null;
        const defenseAnchor = (mySpawns && mySpawns.length > 0 ? mySpawns[0] : null) || myStorage || room.controller || null;

        const isWalkableTile = (x, y) => {
            if (x <= 0 || x >= 49 || y <= 0 || y >= 49) return false;
            if (roomTerrain && roomTerrain.get(x, y) === TERRAIN_MASK_WALL) return false;

            const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
            for (const s of structures) {
                if (!s) continue;
                const type = s.structureType;
                if (type === STRUCTURE_ROAD || type === STRUCTURE_CONTAINER || type === STRUCTURE_RAMPART) continue;
                return false;
            }

            const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
            for (const s of sites) {
                if (!s) continue;
                const type = s.structureType;
                if (type === STRUCTURE_ROAD || type === STRUCTURE_CONTAINER || type === STRUCTURE_RAMPART) continue;
                return false;
            }

            return true;
        };

        const getTowerDamageAtPos = (pos, hostile) => {
            let raw = 0;
            for (const tower of activeTowers) {
                raw += towerDamageAtRange(tower.pos.getRangeTo(pos.x, pos.y));
            }
            return estimateTowerDamageVsTough(raw, hostile);
        };

        const hasFriendlyRampartAt = (x, y) => {
            for (const r of myRamparts) {
                if (r && r.pos.x === x && r.pos.y === y) return true;
            }
            return false;
        };

        const findRampartIntercept = (hostile, anchor) => {
            if (!hostile || !anchor || !hostile.pos) return null;
            const hostileToAnchor = hostile.pos.getRangeTo(anchor);
            let best = null;

            for (const rampart of myRamparts) {
                if (!rampart || !rampart.pos) continue;

                const distToHostile = hostile.pos.getRangeTo(rampart);
                if (distToHostile > RAMPART_INTERCEPT_RANGE) continue;

                const distToAnchor = rampart.pos.getRangeTo(anchor);
                if (distToAnchor >= hostileToAnchor) continue;
                if (!isWalkableTile(rampart.pos.x, rampart.pos.y)) continue;

                const towerDamage = getTowerDamageAtPos(rampart.pos, hostile);
                const score = (towerDamage * 1000) - (distToHostile * 100) - distToAnchor;

                if (!best || score > best.score) {
                    best = {
                        interceptType: 'rampart',
                        interceptPos: { x: rampart.pos.x, y: rampart.pos.y, roomName: rampart.pos.roomName },
                        towerDamage,
                        score,
                        distToHostile,
                        distToAnchor
                    };
                }
            }

            return best;
        };

        const findRingIntercept = (hostile, anchor) => {
            if (!hostile || !anchor || !hostile.pos || !anchor.pos) return null;

            const dx = hostile.pos.x - anchor.pos.x;
            const dy = hostile.pos.y - anchor.pos.y;
            const dist = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)));
            const ratio = Math.min(1, DEFENSE_RING_RADIUS / dist);
            const idealX = Math.max(1, Math.min(48, Math.round(anchor.pos.x + (dx * ratio))));
            const idealY = Math.max(1, Math.min(48, Math.round(anchor.pos.y + (dy * ratio))));

            let best = null;
            for (let ox = -RING_SEARCH_RADIUS; ox <= RING_SEARCH_RADIUS; ox++) {
                for (let oy = -RING_SEARCH_RADIUS; oy <= RING_SEARCH_RADIUS; oy++) {
                    const x = idealX + ox;
                    const y = idealY + oy;
                    if (!isWalkableTile(x, y)) continue;

                    const pos = { x, y, roomName: room.name };
                    const towerDamage = getTowerDamageAtPos(pos, hostile);
                    const hostileRange = hostile.pos.getRangeTo(x, y);
                    const anchorRange = anchor.pos.getRangeTo(x, y);
                    const onRampart = hasFriendlyRampartAt(x, y) ? 1 : 0;
                    const idealSlack = Math.max(Math.abs(ox), Math.abs(oy));
                    const score = (onRampart * 1000000) + (towerDamage * 1000) - (hostileRange * 100) - (anchorRange * 10) - idealSlack;

                    if (!best || score > best.score) {
                        best = {
                            interceptType: 'ring',
                            interceptPos: pos,
                            towerDamage,
                            score,
                            distToHostile: hostileRange,
                            distToAnchor: anchorRange,
                            onRampart: !!onRampart
                        };
                    }
                }
            }

            return best;
        };

        const evaluateDefenseAssist = () => {
            const empty = {
                evaluated: false,
                hostileCount: intel.hostiles.length,
                targetId: null,
                currentTowerDamage: 0,
                currentNetDps: 0,
                interceptType: null,
                interceptPos: null,
                interceptTowerDamage: 0,
                incomingHeal: 0,
                interceptNetDps: 0,
                defenderDps: DEFENDER_DPS,
                needsMeleeAssist: false
            };

            if (!intel.hostiles || intel.hostiles.length === 0) return Object.assign({}, empty, { evaluated: true });
            if (!defenseAnchor || activeTowers.length === 0) return Object.assign({}, empty, { evaluated: true });

            let best = null;

            for (const hostile of intel.hostiles) {
                if (!hostile || !hostile.pos) continue;

                const currentTowerDamage = getTowerDamageAtPos(hostile.pos, hostile);
                const currentIncomingHeal = estimateIncomingHealAtPos(hostile, hostile.pos, intel.hostiles);
                const currentNetDps = currentTowerDamage - currentIncomingHeal;

                const rampartIntercept = findRampartIntercept(hostile, defenseAnchor);
                const ringIntercept = findRingIntercept(hostile, defenseAnchor);
                const intercept = rampartIntercept || ringIntercept;
                if (!intercept) continue;

                const incomingHeal = estimateIncomingHealAtPos(hostile, intercept.interceptPos, intel.hostiles);
                const interceptNetDps = intercept.towerDamage - incomingHeal;
                const flipsWithOne = interceptNetDps <= 0 && (interceptNetDps + DEFENDER_DPS) > 0;
                const flipMargin = interceptNetDps + DEFENDER_DPS;
                const score = flipsWithOne
                    ? (flipMargin * 1000000) + (intercept.towerDamage * 1000) - intercept.distToHostile
                    : (interceptNetDps * 1000) - intercept.distToHostile;

                const cand = {
                    evaluated: true,
                    hostileCount: intel.hostiles.length,
                    targetId: hostile.id,
                    currentTowerDamage,
                    currentNetDps,
                    interceptType: intercept.interceptType,
                    interceptPos: intercept.interceptPos,
                    interceptTowerDamage: intercept.towerDamage,
                    incomingHeal,
                    interceptNetDps,
                    defenderDps: DEFENDER_DPS,
                    needsMeleeAssist: flipsWithOne,
                    score,
                    flipMargin
                };

                if (!best) {
                    best = cand;
                    continue;
                }

                if (cand.needsMeleeAssist && !best.needsMeleeAssist) {
                    best = cand;
                    continue;
                }
                if (cand.needsMeleeAssist === best.needsMeleeAssist && cand.score > best.score) {
                    best = cand;
                }
            }

            return best || Object.assign({}, empty, { evaluated: true });
        };

        intel.defenseAssist = evaluateDefenseAssist();

        if (intel.defenseAssist && intel.defenseAssist.evaluated) {
            towerDebug(() =>
                `[TowerAssist] ${room.name} ` +
                `hostiles=${intel.defenseAssist.hostileCount} ` +
                `target=${intel.defenseAssist.targetId || 'none'} ` +
                `type=${intel.defenseAssist.interceptType || 'none'} ` +
                `curNet=${Math.round(intel.defenseAssist.currentNetDps || 0)} ` +
                `intNet=${Math.round(intel.defenseAssist.interceptNetDps || 0)} ` +
                `melee=${intel.defenseAssist.needsMeleeAssist ? 1 : 0}`
            );
        }

        // --- Priority 0: Defense (Smart + Focus Fire + Anti-Waste) ---
        if (intel.hostiles.length === 0) {
            towerDebug(() => '[Tower] ' + room.name + ' defense: no hostiles');
        } else {
            if (activeTowers.length === 0) {
                towerDebug(() => '[Tower] ' + room.name + ' hostiles present but towers=0 (cache?)');
            } else {
                let bestTarget = null;
                let bestScore = -Infinity;
                let bestDbg = null;

                for (const hostile of intel.hostiles) {
                    // Raw sum tower damage on this hostile
                    let rawTowerDamage = 0;
                    for (const tower of activeTowers) {
                        rawTowerDamage += towerDamageAtRange(tower.pos.getRangeTo(hostile));
                    }

                    // Approximate TOUGH reduction (boost-aware)
                    const towerDamage = estimateTowerDamageVsTough(rawTowerDamage, hostile);
                    const incomingHeal = estimateIncomingHealAtPos(hostile, hostile.pos, intel.hostiles);
                    const effectiveDps = towerDamage - incomingHeal;
                    
                    // Scoring:
                    // - must be killable (effectiveDps > 0)
                    // - prefer lower hits (finish targets)
                    // - bias: killing a healer is good (boost-aware)
                    const healInfo = estimateBoostedHealParts(hostile);
                    const healerBias = healInfo.healAt1 * 5;
                    const score = (effectiveDps * 2) - hostile.hits + healerBias;

                    towerDebug(() =>
                        '[Tower] ' + room.name +
                        ' cand id=' + (hostile.name || hostile.id) +
                        ' hits=' + hostile.hits +
                        ' raw=' + Math.round(rawTowerDamage) +
                        ' tough=' + Math.round(towerDamage) +
                        ' healIn=' + Math.round(incomingHeal) +
                        ' eff=' + Math.round(effectiveDps) +
                        ' score=' + Math.round(score)
                    );

                    if (score > bestScore) {
                        bestScore = score;
                        bestTarget = hostile;
                        bestDbg = {
                            rawTowerDamage,
                            towerDamage,
                            incomingHeal,
                            effectiveDps,
                            hits: hostile.hits,
                            healParts: healInfo.parts,
                            healAt1: healInfo.healAt1,
                            score
                        };
                    }
                }
                // Summary before gate decision
                towerDebug(() =>
                    '[Tower] ' + room.name +
                    ' best=' + (bestTarget ? (bestTarget.name || bestTarget.id) : 'none') +
                    ' bestEff=' + (bestDbg ? Math.round(bestDbg.effectiveDps) : 'n/a') +
                    ' bestScore=' + (bestDbg ? Math.round(bestDbg.score) : 'n/a') +
                    ' towers=' + activeTowers.length
                );

                // Only attack if we can actually make net damage progress against healing
                if (bestTarget && bestDbg && bestDbg.effectiveDps > 0) {
                    missions.push({
                        name: 'tower:defense',
                        type: 'tower_attack',
                        targetIds: [bestTarget.id], // focus fire
                        priority: 1000
                    });

                    // Debug scoring (keep it one-line friendly)
                    towerDebug(() =>
                        `[Tower] ${room.name} focus=${bestTarget.name || bestTarget.id} ` +
                        `towers=${activeTowers.length} ` +
                        `rawDmg=${Math.round(bestDbg.rawTowerDamage)} toughDmg=${Math.round(bestDbg.towerDamage)} ` +
                        `incomingHeal=${Math.round(bestDbg.incomingHeal)} eff=${Math.round(bestDbg.effectiveDps)} ` +
                        `hits=${bestDbg.hits} healParts=${bestDbg.healParts} healAt1=${Math.round(bestDbg.healAt1)} ` +
                        `score=${Math.round(bestDbg.score)}`
                    );
                } else {
                    towerDebug(() =>
                        `[Tower] ${room.name} skip-attack (cannot outdamage heal/tough) ` +
                        `hostiles=${intel.hostiles.length} towers=${activeTowers.length}`
                    );
                }
            }
        }

        // --- Priority 0.5: Heal ---
        // Avoid allocating arrays when there are no damaged creeps.
        let damagedCreepIds = null;
        for (const c of intel.myCreeps) {
            if (c && c.hits < c.hitsMax) {
                if (damagedCreepIds === null) damagedCreepIds = [];
                damagedCreepIds.push(c.id);
            }
        }
        if (damagedCreepIds && damagedCreepIds.length > 0) {
            missions.push({
                name: 'tower:heal',
                type: 'tower_heal',
                targetIds: damagedCreepIds,
                priority: 950
            });
            towerDebug(() => `[Tower] ${room.name} heal targets=${damagedCreepIds.length}`);
        }

        // --- Priority 4.5: Repair ---
        // Reuse opportunistic repair heap scan instead of re-scanning all structures here.
        if (intel.energyAvailable > intel.energyCapacityAvailable * 0.5) {
            const repairScan = overseerOpportunisticRepair.getRoomScan(room.name);
            const targetIds = (repairScan && repairScan.repairIds && repairScan.repairIds.length > 0)
                ? repairScan.repairIds
                : null;
            if (targetIds) {
                missions.push({
                    name: 'tower:repair',
                    type: 'tower_repair',
                    targetIds,
                    priority: 40
                });
                towerDebug(() => `[Tower] ${room.name} repair targets=${targetIds.length}`);
            }
        }
    }
};
