module.exports = {

    generate: function(room, intel, context, missions) {

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

        const estimateIncomingHeal = (target, hostiles) => {
            // Sum of all *possible* healing that could land on target this tick
            // - range <= 1 : heal() => 12 * mult per HEAL part
            // - range 2..3 : rangedHeal() => 4 * mult per HEAL part
            let incoming = 0;

            for (const h of hostiles) {
                if (!h.body || h.body.length === 0) continue;

                const r = h.pos.getRangeTo(target);
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

        // --- Priority 0: Defense (Smart + Focus Fire + Anti-Waste) ---
        if (intel.hostiles.length === 0) {
            debug('mission.tower', '[Tower] ' + room.name + ' defense: no hostiles');
        } else {
            const cache = global.getRoomCache(room);
            const towers = (cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_TOWER]) || [];

            if (towers.length === 0) {
                debug('mission.tower', '[Tower] ' + room.name + ' hostiles present but towers=0 (cache?)');
            } else {
                const towerDamageAtRange = (range) => {
                    if (range <= 5) return 600;
                    if (range >= 20) return 150;
                    return 600 - (range - 5) * 30; // linear falloff 5..20
                };

                let bestTarget = null;
                let bestScore = -Infinity;
                let bestDbg = null;

                for (const hostile of intel.hostiles) {
                    // Raw sum tower damage on this hostile
                    let rawTowerDamage = 0;
                    for (const tower of towers) {
                        rawTowerDamage += towerDamageAtRange(tower.pos.getRangeTo(hostile));
                    }

                    // Approximate TOUGH reduction (boost-aware)
                    const towerDamage = estimateTowerDamageVsTough(rawTowerDamage, hostile);

                    // Estimated incoming heal from enemy + adjacent friends (boost-aware)
                    const incomingHeal = estimateIncomingHeal(hostile, intel.hostiles);

                    const effectiveDps = towerDamage - incomingHeal;

                    // Scoring:
                    // - must be killable (effectiveDps > 0)
                    // - prefer lower hits (finish targets)
                    // - bias: killing a healer is good (boost-aware)
                    const healInfo = estimateBoostedHealParts(hostile);
                    const healerBias = healInfo.healAt1 * 5; // tuneable
                    const score = (effectiveDps * 2) - hostile.hits + healerBias;

                    debug(
                        'mission.tower',
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
                debug(
                    'mission.tower',
                    '[Tower] ' + room.name +
                    ' best=' + (bestTarget ? (bestTarget.name || bestTarget.id) : 'none') +
                    ' bestEff=' + (bestDbg ? Math.round(bestDbg.effectiveDps) : 'n/a') +
                    ' bestScore=' + (bestDbg ? Math.round(bestDbg.score) : 'n/a') +
                    ' towers=' + towers.length
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
                    debug(
                        'mission.tower',
                        `[Tower] ${room.name} focus=${bestTarget.name || bestTarget.id} ` +
                        `towers=${towers.length} ` +
                        `rawDmg=${Math.round(bestDbg.rawTowerDamage)} toughDmg=${Math.round(bestDbg.towerDamage)} ` +
                        `incomingHeal=${Math.round(bestDbg.incomingHeal)} eff=${Math.round(bestDbg.effectiveDps)} ` +
                        `hits=${bestDbg.hits} healParts=${bestDbg.healParts} healAt1=${Math.round(bestDbg.healAt1)} ` +
                        `score=${Math.round(bestDbg.score)}`
                    );
                } else {
                    debug(
                        'mission.tower',
                        `[Tower] ${room.name} skip-attack (cannot outdamage heal/tough) ` +
                        `hostiles=${intel.hostiles.length} towers=${towers.length}`
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
            debug('mission.tower', `[Tower] ${room.name} heal targets=${damagedCreepIds.length}`);
        }

        // --- Priority 4.5: Repair ---
        // Only if we have reasonable energy and normal repair creep missions fail to keep up, meaning very lot HP
        if (intel.energyAvailable > intel.energyCapacityAvailable * 0.5) {
            // Avoid flattening + double-filtering the entire structures set.
            // Preserve original ordering bias: critical forts first, then other damaged structures.
            let criticalIds = null;
            let damagedIds = null;

            const byType = intel.structures || {};
            for (const type in byType) {
                const list = byType[type];
                if (!list || list.length === 0) continue;

                for (const s of list) {
                    if (!s) continue;
                    if (s.hits >= s.hitsMax) continue;

                    const st = s.structureType;
                    if (st === STRUCTURE_WALL || st === STRUCTURE_RAMPART) {
                        if (s.hits < 5000) {
                            if (criticalIds === null) criticalIds = [];
                            criticalIds.push(s.id);
                        }
                        continue;
                    }

                    // Non-fort structures: only repair if <60% hp
                    if ((s.hits / s.hitsMax) < 0.6) {
                        if (damagedIds === null) damagedIds = [];
                        damagedIds.push(s.id);
                    }
                }
            }

            const hasRepairs = (criticalIds && criticalIds.length) || (damagedIds && damagedIds.length);
            if (hasRepairs) {
                const targetIds = criticalIds && criticalIds.length
                    ? (damagedIds && damagedIds.length ? criticalIds.concat(damagedIds) : criticalIds)
                    : damagedIds;

                missions.push({
                    name: 'tower:repair',
                    type: 'tower_repair',
                    targetIds,
                    priority: 40
                });
                debug('mission.tower', `[Tower] ${room.name} repair targets=${targetIds.length}`);
            }
        }
    }
};