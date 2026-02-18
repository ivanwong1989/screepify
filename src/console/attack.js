const DEFAULT_ATTACK_BODY = [RANGED_ATTACK, MOVE, HEAL];
const DEFAULT_SUPPORT_BODY = [HEAL, MOVE, MOVE];
const DEFAULT_BODY_MODE = 'auto';
const ASSAULT_TUNING_KEYS = [
    'retreatAt',
    'reengageAt',
    'safeDamageRatio',
    'damageBuffer',
    'dangerRadius',
    'supportRange'
];

function normalizeBodyPart(part) {
    if (part === undefined || part === null) return null;
    if (typeof part === 'string') {
        const raw = part.trim();
        if (raw && BODYPART_COST && BODYPART_COST[raw]) return raw;
        const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
        const shorthand = {
            r: 'ranged_attack',
            ra: 'ranged_attack',
            range: 'ranged_attack',
            ranged: 'ranged_attack',
            a: 'attack',
            atk: 'attack',
            attack: 'attack',
            m: 'move',
            mv: 'move',
            move: 'move',
            t: 'tough',
            tough: 'tough',
            h: 'heal',
            heal: 'heal'
        };
        if (shorthand[normalized]) return shorthand[normalized];
        if (normalized && BODYPART_COST && BODYPART_COST[normalized]) return normalized;
        return null;
    }
    return null;
}

function normalizeBodyMode(mode) {
    if (!mode) return DEFAULT_BODY_MODE;
    if (typeof mode === 'string') {
        const normalized = mode.trim().toLowerCase();
        if (normalized === 'fixed' || normalized === 'exact' || normalized === 'static') return 'fixed';
    }
    return DEFAULT_BODY_MODE;
}

function normalizeBodyList(input) {
    if (Array.isArray(input)) {
        return input.map(normalizeBodyPart).filter(p => p);
    }
    if (typeof input === 'string') {
        const parts = input.split(/[,\s]+/).filter(p => p);
        return parts.map(normalizeBodyPart).filter(p => p);
    }
    return null;
}

function parseBodyInput(input) {
    const result = { hasMode: false, hasBody: false, mode: null, body: null, reset: false };

    if (input === undefined || input === null) return result;

    if (typeof input === 'string') {
        const raw = input.trim();
        if (!raw) return result;
        const lower = raw.toLowerCase();
        if (lower === 'reset' || lower === 'clear' || lower === 'default') {
            result.reset = true;
            return result;
        }

        const modeMatch = lower.match(/^(fixed|exact|static|auto|pattern|repeat|max|scale)(?:[:\s]+(.+))?$/);
        if (modeMatch) {
            result.hasMode = true;
            const token = modeMatch[1];
            result.mode = (token === 'fixed' || token === 'exact' || token === 'static') ? 'fixed' : 'auto';
            const rest = modeMatch[2];
            if (rest && rest.trim().length > 0) {
                result.hasBody = true;
                result.body = normalizeBodyList(rest);
            }
            return result;
        }

        result.hasBody = true;
        result.body = normalizeBodyList(raw);
        return result;
    }

    if (Array.isArray(input)) {
        result.hasBody = true;
        result.body = normalizeBodyList(input);
        return result;
    }

    if (typeof input === 'object') {
        const modeRaw = input.mode || (input.fixed ? 'fixed' : null) || (input.auto ? 'auto' : null);
        if (modeRaw) {
            result.hasMode = true;
            result.mode = normalizeBodyMode(modeRaw);
        }
        const bodyInput = (input.body !== undefined) ? input.body : ((input.parts !== undefined) ? input.parts : input.pattern);
        if (bodyInput !== undefined) {
            result.hasBody = true;
            result.body = normalizeBodyList(bodyInput);
        }
    }

    return result;
}

function ensureAttackMemory() {
    if (!Memory.military) Memory.military = {};
    if (!Memory.military.attack) Memory.military.attack = {};
    return Memory.military.attack;
}

function getStoredMode(memory, modeKey) {
    if (!memory || !modeKey) return DEFAULT_BODY_MODE;
    return memory[modeKey] === 'fixed' ? 'fixed' : DEFAULT_BODY_MODE;
}

function storeMode(memory, modeKey, mode) {
    if (!memory || !modeKey) return;
    if (mode === 'fixed') memory[modeKey] = 'fixed';
    else delete memory[modeKey];
}

function formatBody(body) {
    if (!Array.isArray(body) || body.length === 0) return '(none)';
    return body.join(',');
}

function setAttackBodyKey(key, modeKey, parts, label, defaultBody) {
    const memory = ensureAttackMemory();
    const current = Array.isArray(memory[key]) ? memory[key] : [];
    const currentMode = getStoredMode(memory, modeKey);

    if (parts === undefined || parts === null) {
        const fallback = Array.isArray(defaultBody) ? formatBody(defaultBody) : '(none)';
        const msg = `${label} body: ${formatBody(current)} (mode=${currentMode}, default=${fallback})`;
        console.log(msg);
        return msg;
    }

    const parsed = parseBodyInput(parts);
    if (parsed.reset) {
        delete memory[key];
        delete memory[modeKey];
        const fallback = Array.isArray(defaultBody) ? formatBody(defaultBody) : '(none)';
        const msg = `${label} body reset to default (${fallback})`;
        console.log(msg);
        return msg;
    }

    if (!parsed.hasBody && !parsed.hasMode) {
        return `Usage: ${label}Body("auto: move,attack,heal") OR ${label}Body("fixed: move,attack,heal") OR ${label}Body([MOVE, ATTACK, HEAL]) OR ${label}Body("reset")`;
    }

    if (parsed.hasBody && (!parsed.body || parsed.body.length === 0)) {
        return `Usage: ${label}Body("auto: move,attack,heal") OR ${label}Body("fixed: move,attack,heal") OR ${label}Body([MOVE, ATTACK, HEAL]) OR ${label}Body("reset")`;
    }

    if (parsed.hasMode) {
        storeMode(memory, modeKey, parsed.mode);
    }

    const effectiveMode = parsed.hasMode ? parsed.mode : currentMode;

    if (parsed.hasBody) {
        memory[key] = parsed.body;
        const msg = `${label} body set: ${formatBody(parsed.body)} (mode=${effectiveMode})`;
        console.log(msg);
        return msg;
    }

    const msg = `${label} body mode set: ${effectiveMode} (body=${formatBody(current)})`;
    console.log(msg);
    return msg;
}

module.exports = function registerAttackConsole() {
    global.attackBody = function(parts) {
        return setAttackBodyKey('body', 'bodyMode', parts, 'Attack', DEFAULT_ATTACK_BODY);
    };

    global.attackBodyLeader = function(parts) {
        return setAttackBodyKey('leaderBody', 'leaderBodyMode', parts, 'Attack leader', DEFAULT_ATTACK_BODY);
    };

    global.attackBodySupport = function(parts) {
        const memory = ensureAttackMemory();
        if (parts === undefined || parts === null) {
            const current = Array.isArray(memory.supportBody) ? memory.supportBody : [];
            const currentMode = getStoredMode(memory, 'supportBodyMode');
            const msg = `Attack support body: ${formatBody(current)} (mode=${currentMode}, set to enable duo; default=${formatBody(DEFAULT_SUPPORT_BODY)})`;
            console.log(msg);
            return msg;
        }

        const parsed = parseBodyInput(parts);
        if (parsed.reset) {
            delete memory.supportBody;
            delete memory.supportBodyMode;
            const msg = 'Attack support body cleared (duo disabled)';
            console.log(msg);
            return msg;
        }

        if (!parsed.hasBody && !parsed.hasMode) {
            return 'Usage: attackBodySupport("auto: move,heal,move") OR attackBodySupport("fixed: move,heal,move") OR attackBodySupport([MOVE, HEAL, MOVE]) OR attackBodySupport("reset")';
        }

        if (parsed.hasBody && (!parsed.body || parsed.body.length === 0)) {
            return 'Usage: attackBodySupport("auto: move,heal,move") OR attackBodySupport("fixed: move,heal,move") OR attackBodySupport([MOVE, HEAL, MOVE]) OR attackBodySupport("reset")';
        }

        const currentMode = getStoredMode(memory, 'supportBodyMode');
        if (parsed.hasMode) {
            storeMode(memory, 'supportBodyMode', parsed.mode);
        }

        const effectiveMode = parsed.hasMode ? parsed.mode : currentMode;

        if (parsed.hasBody) {
            memory.supportBody = parsed.body;
            const msg = `Attack support body set: ${formatBody(parsed.body)} (mode=${effectiveMode})`;
            console.log(msg);
            return msg;
        }

        const msg = `Attack support body mode set: ${effectiveMode} (body=${formatBody(current)})`;
        console.log(msg);
        return msg;
    };

    global.assaultTuning = function(input) {
        const memory = ensureAttackMemory();
        const lower = (typeof input === 'string') ? input.trim().toLowerCase() : '';

        if (input === undefined || input === null || lower === 'show') {
            const lines = ['Assault tuning overrides (Memory.military.attack):'];
            for (const key of ASSAULT_TUNING_KEYS) {
                const value = memory[key];
                if (Number.isFinite(value)) lines.push(`  ${key}: ${value}`);
                else lines.push(`  ${key}: (default)`);
            }
            lines.forEach(line => console.log(line));
            return lines.join('\n');
        }

        if (lower === 'reset' || lower === 'clear' || lower === 'default') {
            for (const key of ASSAULT_TUNING_KEYS) {
                delete memory[key];
            }
            const msg = 'Assault tuning overrides cleared (defaults restored).';
            console.log(msg);
            return msg;
        }

        if (typeof input !== 'object' || Array.isArray(input)) {
            const msg = 'Usage: assaultTuning() OR assaultTuning({ retreatAt: 0.6, damageBuffer: 50 }) OR assaultTuning("reset")';
            console.log(msg);
            return msg;
        }

        let changed = 0;
        for (const key of ASSAULT_TUNING_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
            const value = input[key];
            if (value === undefined || value === null) {
                delete memory[key];
                changed++;
            } else if (Number.isFinite(value)) {
                memory[key] = value;
                changed++;
            }
        }

        const msg = changed > 0
            ? 'Assault tuning overrides updated.'
            : 'No valid tuning keys provided. Use: assaultTuning({ retreatAt: 0.6, damageBuffer: 50 })';
        console.log(msg);
        return msg;
    };
};
