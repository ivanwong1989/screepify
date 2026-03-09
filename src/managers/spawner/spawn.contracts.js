const assaultMemory = require('managers_admiral_tactics_assault_common_memory');

const spawnContracts = {
    buildContracts: function(room, missions, options) {
        const entries = [];
        const byId = Object.create(null);
        const homeRoom = room.name;
        const getBodyStats = options && options.getBodyStats;
        debug('spawner', `[SpawnContracts] ${homeRoom} missions=${(missions || []).length}`);

        (missions || []).forEach(mission => {
            const req = mission.requirements || {};
            if (req.spawn === false) return;

            // Admiral's side special handling
            let desiredOverride = null;

            if (mission.type === 'assault' && mission.data && mission.data.mode === 'DUO') {
                const runtimeKey = mission.data.squadKey || mission.name;
                const runtime = assaultMemory.getDuoRuntime(runtimeKey);

                if (runtime && runtime.assembled && runtime.assembled.done) {
                    // ✅ "No fulfill": keep contract, but set desired to 0 so SpawnPlanner won't spawn replacements mid-fight.
                    desiredOverride = 0;
                    debug('spawner', `[SpawnContracts] duo gate mission=${mission.name} assembled=1 -> desired=0 (no fulfill)`);
                }
            }

            if (mission.type === 'assault' && mission.data && mission.data.mode === 'SOLO') {
                const runtimeKey = mission.data.squadKey || mission.name;
                const runtime = assaultMemory.getSoloRuntime && assaultMemory.getSoloRuntime(runtimeKey);

                if (runtime && runtime.assembled && runtime.assembled.done) {
                    // ✅ "No fulfill": keep contract, but set desired to 0 so SpawnPlanner won't spawn replacements mid-fight.
                    desiredOverride = 0;
                    debug('spawner', `[SpawnContracts] solo gate mission=${mission.name} assembled=1 -> desired=0 (no fulfill)`);
                }
            }
            // ----

            const role = mission.archetype || req.archetype;
            if (!role) return;

            const desiredRaw = this.getDesiredCount(mission, room, getBodyStats);
            const desired = (desiredOverride !== null) ? desiredOverride : desiredRaw;
            const priority = mission.priority || 0;
            const bodySpec = this.getBodySpec(mission);
            const metadata = this.getContractMetadata(mission);

            if (req.spawnFromFleet) {
                const contract = this.makeContract({
                    homeRoom,
                    role,
                    desired,
                    priority,
                    bindMode: 'pool',
                    bindId: null,
                    bodySpec,
                    metadata
                });
                this.mergeContract(byId, entries, contract, mission, 'pool');
                debug('spawner', `[SpawnContracts] pool ${contract.contractId} desired=${desired} mission=${mission.name}`);
                return;
            }

            const targetKeys = this.getTargetKeys(mission, homeRoom, desired);
            if (targetKeys.length > 0) {
                for (const key of targetKeys) {
                    const contract = this.makeContract({
                        homeRoom,
                        role,
                        desired: 1,
                        priority,
                        bindMode: 'target',
                        bindId: key,
                        bodySpec,
                        metadata
                    });
                    this.mergeContract(byId, entries, contract, mission, 'target');
                    debug('spawner', `[SpawnContracts] target ${contract.contractId} desired=1 mission=${mission.name}`);
                }
                return;
            }

            const contract = this.makeContract({
                homeRoom,
                role,
                desired,
                priority,
                bindMode: 'mission',
                bindId: mission.name,
                bodySpec,
                metadata
            });
            this.mergeContract(byId, entries, contract, mission, 'mission');
            debug('spawner', `[SpawnContracts] mission ${contract.contractId} desired=${desired} mission=${mission.name}`);
        });

        debug('spawner', `[SpawnContracts] ${homeRoom} contracts=${entries.length}`);
        return entries;
    },

    mergeContract: function(byId, entries, contract, mission, kind) {
        const existing = byId[contract.contractId];
        if (!existing) {
            const entry = { contract, mission };
            byId[contract.contractId] = entry;
            entries.push(entry);
            return;
        }

        existing.contract.desired += contract.desired;
        if (contract.priority > existing.contract.priority) {
            existing.contract.priority = contract.priority;
        }

        this.mergeContractMetadata(existing.contract, contract);

        if (kind === 'pool' && existing.contract.bindMode === 'pool') {
            // Keep the first mission as representative; no-op for now.
        }
    },

    mergeContractMetadata: function(existingContract, newContract) {
        const existingLead = Number(existingContract && existingContract.replaceLeadTicks);
        const newLead = Number(newContract && newContract.replaceLeadTicks);

        if (Number.isFinite(newLead)) {
            if (!Number.isFinite(existingLead) || newLead > existingLead) {
                existingContract.replaceLeadTicks = newLead;
            }
        }

        if (!existingContract.travelFromSpawnId && newContract.travelFromSpawnId) {
            existingContract.travelFromSpawnId = newContract.travelFromSpawnId;
        }
        if (!Number.isFinite(existingContract.sourceDistance) && Number.isFinite(newContract.sourceDistance)) {
            existingContract.sourceDistance = newContract.sourceDistance;
        }
        if (!Number.isFinite(existingContract.travelTicks) && Number.isFinite(newContract.travelTicks)) {
            existingContract.travelTicks = newContract.travelTicks;
        }
    },

    makeContract: function(fields) {
        const bindLabel = fields.bindMode === 'pool' ? 'pool' : fields.bindId;
        const contractId = `home=${fields.homeRoom}|role=${fields.role}|bind=${fields.bindMode}:${bindLabel}`;
        const contract = {
            contractId,
            homeRoom: fields.homeRoom,
            role: fields.role,
            desired: fields.desired,
            priority: fields.priority,
            bindMode: fields.bindMode,
            bindId: fields.bindId,
            bodySpec: fields.bodySpec || { budget: 0 }
        };

        const metadata = fields.metadata || null;
        if (metadata) {
            if (Number.isFinite(metadata.replaceLeadTicks)) contract.replaceLeadTicks = metadata.replaceLeadTicks;
            if (Number.isFinite(metadata.sourceDistance)) contract.sourceDistance = metadata.sourceDistance;
            if (Number.isFinite(metadata.travelTicks)) contract.travelTicks = metadata.travelTicks;
            if (metadata.travelFromSpawnId) contract.travelFromSpawnId = metadata.travelFromSpawnId;
        }

        return contract;
    },

    getBodySpec: function(mission) {
        if (mission && mission.bodySpec) return mission.bodySpec;
        return { budget: 0 };
    },

    getDesiredCount: function(mission, room, getBodyStats) {
        const req = mission && mission.requirements ? mission.requirements : {};
        const minCount = Number.isFinite(req.minCount) ? Math.max(0, req.minCount) : 1;
        const maxCount = Number.isFinite(req.maxCount) ? Math.max(0, req.maxCount) : Infinity;
        const requiredWork = Number.isFinite(req.requiredWork) ? Math.max(0, req.requiredWork) : 0;
        const requiredCarry = Number.isFinite(req.requiredCarry) ? Math.max(0, req.requiredCarry) : 0;
        const requiredClaim = Number.isFinite(req.requiredClaim) ? Math.max(0, req.requiredClaim) : 0;

        let desired = minCount;
        const hasDemand = requiredWork > 0 || requiredCarry > 0 || requiredClaim > 0;
        if (hasDemand && typeof getBodyStats === 'function') {
            const budget = room && Number.isFinite(room.energyCapacityAvailable) ? room.energyCapacityAvailable : 0;
            const stats = getBodyStats(mission, budget) || {};
            const workPer = Math.max(1, stats.work || 0);
            const carryPer = Math.max(1, stats.carry || 0);
            const claimPer = Math.max(1, stats.claim || 0);

            const byWork = requiredWork > 0 ? Math.ceil(requiredWork / workPer) : 0;
            const byCarry = requiredCarry > 0 ? Math.ceil(requiredCarry / carryPer) : 0;
            const byClaim = requiredClaim > 0 ? Math.ceil(requiredClaim / claimPer) : 0;

            desired = Math.max(minCount, byWork, byCarry, byClaim);
        }

        if (Number.isFinite(maxCount)) {
            desired = Math.min(desired, maxCount);
        }
        return Math.max(0, desired);
    },

    getContractMetadata: function(mission) {
        const data = mission && mission.data;
        if (!data) return null;

        const out = {};
        let hasAny = false;

        if (Number.isFinite(data.preSpawnLeadTicks)) {
            out.replaceLeadTicks = data.preSpawnLeadTicks;
            hasAny = true;
        }
        if (Number.isFinite(data.sourceDistance)) {
            out.sourceDistance = data.sourceDistance;
            hasAny = true;
        }
        if (Number.isFinite(data.travelTicks)) {
            out.travelTicks = data.travelTicks;
            hasAny = true;
        }
        if (data.travelFromSpawnId) {
            out.travelFromSpawnId = data.travelFromSpawnId;
            hasAny = true;
        }

        return hasAny ? out : null;
    },

    getTargetKeys: function(mission, roomName, desired) {
        if (mission.spawnSlots && mission.spawnSlots.length > 0) {
            const wanted = Math.max(0, desired || 0);
            return mission.spawnSlots.slice(0, wanted);
        }
        const baseKey = this.getAssignmentKeyBase(mission, roomName);
        if (!baseKey) return [];
        const count = Math.max(1, desired || 1);

        if (mission.type === 'harvest') {
            const keys = [];
            for (let i = 0; i < count; i++) {
                keys.push(`${baseKey}:${i}`);
            }
            return keys;
        }

        if (count <= 1) return [baseKey];

        const keys = [];
        for (let i = 0; i < count; i++) {
            keys.push(`${baseKey}:${i}`);
        }
        return keys;
    },

    getAssignmentKeyBase: function(mission, roomName) {
        if (mission.type === 'harvest') return `harvest:${roomName}:${mission.sourceId}`;
        if (mission.type === 'remote_reserve') return `reserve:${roomName}:${mission.data.targetRoom}`;
        if (mission.type === 'defend') return `defend:${roomName}:${mission.data.targetRoom}`;
        if (mission.type === 'remote_build') return `build:${roomName}:${mission.data.targetRoom}:${mission.data.groupId || 'main'}`;
        return null;
    }
};

module.exports = spawnContracts;
