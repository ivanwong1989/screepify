const ACTION_SLOTS = {
    move: 'move',
    work: 'work',
    transfer: 'transfer',
    attack: 'attack',
    heal: 'heal',
    claim: 'claim',
    drop: 'drop',
    reserve: 'reserve',
    repair: 'repair',
    build: 'build',
    upgrade: 'upgrade',
    harvest: 'harvest',
    pickup: 'pickup',
    withdraw: 'withdraw',
    rangedAttack: 'rangedAttack',
    rangedHeal: 'rangedHeal',
    rangedMassAttack: 'rangedMassAttack',
    dismantle: 'dismantle',
};

function createActionState(creep) {
    return {
        creepName: creep.name,
        used: {}, // slot -> boolean
        results: {} // slot -> result code
    };
}

function canUse(state, slot) {
    if (!state) return true;
    return !state.used[slot];
}

function claim(state, slot, meta) {
    if (!state) return true;
    if (state.used[slot]) return false;
    state.used[slot] = true;
    return true;
}

function recordResult(state, slot, result) {
    if (!state) return;
    state.results[slot] = result;
}

module.exports = {
    createActionState,
    canUse,
    claim,
    recordResult,
    SLOTS: ACTION_SLOTS
};
