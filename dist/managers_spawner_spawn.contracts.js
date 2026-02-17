const spawnContracts = {
    buildContracts: function(room, missions) {
        const entries = [];
        const byId = Object.create(null);
        const homeRoom = room.name;
        debug('spawner', `[SpawnContracts] ${homeRoom} missions=${(missions || []).length}`);

        (missions || []).forEach(mission => {
            const req = mission.requirements || {};
            if (req.spawn === false) return;

            const role = mission.archetype || req.archetype;
            if (!role) return;

            const desired = Math.max(1, req.count || 1);
            const priority = mission.priority || 0;

            if (req.spawnFromFleet) {
                const contract = this.makeContract({
                    homeRoom,
                    role,
                    desired,
                    priority,
                    bindMode: 'pool',
                    bindId: null
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
                        bindId: key
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
                bindId: mission.name
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

        if (kind === 'pool' && existing.contract.bindMode === 'pool') {
            // Keep the first mission as representative; no-op for now.
        }
    },

    makeContract: function(fields) {
        const bindLabel = fields.bindMode === 'pool' ? 'pool' : fields.bindId;
        const contractId = `home=${fields.homeRoom}|role=${fields.role}|bind=${fields.bindMode}:${bindLabel}`;
        return {
            contractId,
            homeRoom: fields.homeRoom,
            role: fields.role,
            desired: fields.desired,
            priority: fields.priority,
            bindMode: fields.bindMode,
            bindId: fields.bindId,
            bodySpec: fields.bodySpec || { budget: 0 }
        };
    },

    getTargetKeys: function(mission, roomName, desired) {
        if (mission.spawnSlots && mission.spawnSlots.length > 0) {
            return mission.spawnSlots.slice();
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
        if (mission.assignmentKey) return mission.assignmentKey;
        if (mission.type === 'harvest') return `harvest:${roomName}:${mission.sourceId}`;
        if (mission.type === 'remote_reserve') return `reserve:${roomName}:${mission.data.targetRoom}`;
        if (mission.type === 'defend') return `defend:${roomName}:${mission.data.targetRoom}`;
        if (mission.type === 'remote_build') return `build:${roomName}:${mission.data.targetRoom}:${mission.data.groupId || 'main'}`;
        return null;
    }
};

module.exports = spawnContracts;
