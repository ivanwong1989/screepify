const PROPOSED = 'proposed';
const ACTIVE = 'active';
const BLOCKED = 'blocked';
const COMPLETING = 'completing';
const DONE = 'done';
const CANCELLED = 'cancelled';
const EXPIRED = 'expired';

const TERMINAL_STATES = new Set([DONE, CANCELLED, EXPIRED]);
const LIVE_STATES = new Set([PROPOSED, ACTIVE, BLOCKED, COMPLETING]);

module.exports = {
    PROPOSED,
    ACTIVE,
    BLOCKED,
    COMPLETING,
    DONE,
    CANCELLED,
    EXPIRED,
    TERMINAL_STATES,
    LIVE_STATES
};

