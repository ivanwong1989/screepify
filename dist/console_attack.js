const bodyCodec = require('utils_bodyCodec');
const DEFAULT_ATTACK_BODY = [RANGED_ATTACK, MOVE, HEAL];
const DEFAULT_SUPPORT_BODY = [HEAL, MOVE, MOVE];
const DEFAULT_BODY_MODE = 'auto';
// --- Dismantle mission body tuning (stored in Memory.military.dismantle) ---
const DEFAULT_DISMANTLE_BODY = [WORK, MOVE];
const ASSAULT_TUNING_KEYS = [
    'retreatAt',
    'reengageAt',
    'safeDamageRatio',
    'damageBuffer',
    'dangerRadius',
    'supportRange'
];


function printAssaultTuningHelp() {
    const lines = [
        'assaultTuning — Assault mission tuning',
        '',
        'GLOBAL TUNING (stored in Memory.military.attack):',
        '  assaultTuning()',
        '  assaultTuning("show")',
        '      Show current global assault tuning values',
        '',
        '  assaultTuning({ dangerRadius: 3, supportRange: 2 })',
        '      dangerRadius  : distance to trigger kiting (ranged)',
        '      supportRange  : allowed leader-support spacing',
        '      retreatAt     : HP ratio to retreat (0–1)',
        '      reengageAt    : HP ratio to reengage (0–1)',
        '      safeDamageRatio, damageBuffer',
        '',
        'PER-FLAG AO (stored in Flag.memory):',
        '  assaultTuning({ aoRadius: 7 }, "AttackFlag")',
        '      Set AO radius for a specific attack flag',
        '',
        '  assaultTuning("ao show AttackFlag")',
        '  assaultTuning("ao 7 AttackFlag")',
        '  assaultTuning("ao clear AttackFlag")',
        '',
        'NOTES:',
        '  • mission.data.ao.radius overrides flag AO radius',
        '  • aoRadius = 0 means "no AO boundary"',
        '  • AO radius is enforced only during ENGAGE',
    ];

    lines.forEach(l => console.log(l));
    return lines.join('\n');
}

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
            heal: 'heal',
            w: 'work',
            work: 'work',
            wrk: 'work'
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

function getBodyCost(body) {
    if (!Array.isArray(body) || body.length === 0) return 0;
    return body.reduce((sum, part) => sum + (BODYPART_COST[part] || 0), 0);
}

function decodeStoredBody(value) {
    if (Array.isArray(value)) return normalizeBodyList(value) || [];
    if (typeof value !== 'string' || !value) return [];
    return normalizeBodyList(bodyCodec.decodeBody(value)) || [];
}

function encodeBodyForStorage(body) {
    if (!Array.isArray(body) || body.length === 0) return '';
    try {
        return bodyCodec.encodeBody(body);
    } catch (e) {
        return '';
    }
}

function setAttackBodyKey(key, modeKey, parts, label, defaultBody) {
    const memory = ensureAttackMemory();
    const current = decodeStoredBody(memory[key]);
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
        const cost = Array.isArray(defaultBody) ? getBodyCost(defaultBody) : 0;
        const msg = `${label} body reset to default (${fallback}, cost=${cost})`;
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
        const encoded = encodeBodyForStorage(parsed.body);
        memory[key] = encoded || parsed.body;
        const cost = getBodyCost(parsed.body);
        const msg = `${label} body set: ${formatBody(parsed.body)} (mode=${effectiveMode}, cost=${cost})`;
        console.log(msg);
        return msg;
    }

    const msg = `${label} body mode set: ${effectiveMode} (body=${formatBody(current)})`;
    console.log(msg);
    return msg;
}


function ensureDismantleMemory() {
    if (!Memory.military) Memory.military = {};
    if (!Memory.military.dismantle) Memory.military.dismantle = {};
    return Memory.military.dismantle;
}

function setDismantleBodyKey(key, modeKey, parts, label, defaultBody) {
    const memory = ensureDismantleMemory();
    const current = decodeStoredBody(memory[key]);
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
        const cost = Array.isArray(defaultBody) ? getBodyCost(defaultBody) : 0;
        const msg = `${label} body reset to default (${fallback}, cost=${cost})`;
        console.log(msg);
        return msg;
    }

    if (!parsed.hasBody && !parsed.hasMode) {
        return `Usage: ${label}Body("auto: work,move") OR ${label}Body("fixed: work,move") OR ${label}Body([WORK, MOVE]) OR ${label}Body("reset")`;
    }

    if (parsed.hasBody && (!parsed.body || parsed.body.length === 0)) {
        return `Usage: ${label}Body("auto: work,move") OR ${label}Body("fixed: work,move") OR ${label}Body([WORK, MOVE]) OR ${label}Body("reset")`;
    }

    if (parsed.hasMode) {
        storeMode(memory, modeKey, parsed.mode);
    }

    const effectiveMode = parsed.hasMode ? parsed.mode : currentMode;

    if (parsed.hasBody) {
        const encoded = encodeBodyForStorage(parsed.body);
        memory[key] = encoded || parsed.body;
        const cost = getBodyCost(parsed.body);
        const msg = `${label} body set: ${formatBody(parsed.body)} (mode=${effectiveMode}, cost=${cost})`;
        console.log(msg);
        return msg;
    }

    const msg = `${label} body mode set: ${effectiveMode} (body=${formatBody(current)})`;
    console.log(msg);
    return msg;
}


function getFlagByName(name) {
    if (!name || typeof name !== 'string') return null;
    const n = name.trim();
    if (!n) return null;
    return (typeof Game !== 'undefined' && Game.flags) ? Game.flags[n] : null;
}

function setFlagAoRadius(flagName, radiusValue) {
    const flag = getFlagByName(flagName);
    if (!flag) {
        const msg = `assaultTuning: flag not found: ${flagName}`;
        console.log(msg);
        return msg;
    }
    if (!flag.memory) flag.memory = {}; // usually exists, but safe

    if (radiusValue === undefined) {
        const cur = flag.memory.aoRadius;
        const msg = `AO radius for flag ${flag.name}: ${Number.isFinite(cur) ? cur : '(default/none)'}`;
        console.log(msg);
        return msg;
    }

    if (radiusValue === null) {
        delete flag.memory.aoRadius;
        const msg = `AO radius cleared for flag ${flag.name}`;
        console.log(msg);
        return msg;
    }

    const r = Number(radiusValue);
    if (!Number.isFinite(r) || r < 0) {
        const msg = `assaultTuning: invalid aoRadius (must be >=0 number): ${radiusValue}`;
        console.log(msg);
        return msg;
    }

    // clamp to something sensible; room range is 0..49-ish, but AO > 25 is silly
    const clamped = Math.min(25, Math.floor(r));
    flag.memory.aoRadius = clamped;

    const msg = `AO radius set for flag ${flag.name}: ${clamped}`;
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
        const current = decodeStoredBody(memory.supportBody);
        if (parts === undefined || parts === null) {
            const currentMode = getStoredMode(memory, 'supportBodyMode');
            const msg = `Attack support body: ${formatBody(current)} (mode=${currentMode}, set to enable duo; default=${formatBody(DEFAULT_SUPPORT_BODY)})`;
            console.log(msg);
            return msg;
        }

        const parsed = parseBodyInput(parts);
        if (parsed.reset) {
            delete memory.supportBody;
            delete memory.supportBodyMode;
            const msg = 'Attack support body cleared (duo disabled, cost=0)';
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
            const encoded = encodeBodyForStorage(parsed.body);
            memory.supportBody = encoded || parsed.body;
            const cost = getBodyCost(parsed.body);
            const msg = `Attack support body set: ${formatBody(parsed.body)} (mode=${effectiveMode}, cost=${cost})`;
            console.log(msg);
            return msg;
        }

        const msg = `Attack support body mode set: ${effectiveMode} (body=${formatBody(current)})`;
        console.log(msg);
        return msg;
    };

    // Dismantle mission body (Z + D AO)
    global.dismantleBody = function(parts) {
        return setDismantleBodyKey('body', 'bodyMode', parts, 'Dismantle', DEFAULT_DISMANTLE_BODY);
    };

    global.assaultTuning = function(input, flagName) {
        const memory = ensureAttackMemory();

        // ---- NEW: string shortcuts for AO ----
        if (typeof input === 'string') {
            const raw = input.trim();
            const lower = raw.toLowerCase();

            // existing show/reset support remains
            if (!raw || lower === 'show') {
                return printAssaultTuningHelp();
            }

            if (lower === 'reset' || lower === 'clear' || lower === 'default') {
                for (const key of ASSAULT_TUNING_KEYS) delete memory[key];
                const msg = 'Assault tuning overrides cleared (defaults restored).';
                console.log(msg);
                return msg;
            }

            // NEW: "ao ..." commands
            // examples:
            //  "ao show FlagName"
            //  "ao 7 FlagName"
            //  "ao:7 FlagName"
            //  "ao clear FlagName"
            const aoMatch = raw.match(/^ao(?::|\s+)?(show|clear|reset|\d+)?(?:\s+(.+))?$/i);
            if (aoMatch) {
                const op = (aoMatch[1] || 'show').toLowerCase();
                const name = (aoMatch[2] || flagName || '').trim();
                if (!name) {
                    const msg = 'Usage: assaultTuning("ao 7 FlagName") OR assaultTuning({aoRadius:7}, "FlagName")';
                    console.log(msg);
                    return msg;
                }
                if (op === 'show') return setFlagAoRadius(name, undefined);
                if (op === 'clear' || op === 'reset') return setFlagAoRadius(name, null);
                // numeric
                return setFlagAoRadius(name, Number(op));
            }

            // fall through: unknown string usage
            const msg = 'Usage: assaultTuning() OR assaultTuning({ dangerRadius: 3 }) OR assaultTuning({ aoRadius: 7 }, "FlagName") OR assaultTuning("ao 7 FlagName")';
            console.log(msg);
            return msg;
        }

        // ---- Object input: support new aoRadius with optional flagName ----
        if (input === undefined || input === null) {
            return printAssaultTuningHelp();
        }

        if (typeof input !== 'object' || Array.isArray(input)) {
            const msg = 'Usage: assaultTuning() OR assaultTuning({ retreatAt: 0.6, damageBuffer: 50 }) OR assaultTuning({ aoRadius: 7 }, "FlagName") OR assaultTuning("ao 7 FlagName")';
            console.log(msg);
            return msg;
        }

        // NEW: handle aoRadius per flag if provided
        if (Object.prototype.hasOwnProperty.call(input, 'aoRadius')) {
            const name = (flagName || '').trim();
            if (!name) {
                const msg = 'assaultTuning: to set aoRadius, provide flag name: assaultTuning({ aoRadius: 7 }, "FlagName")';
                console.log(msg);
                return msg;
            }
            const v = input.aoRadius;
            if (v === undefined) {
                return setFlagAoRadius(name, undefined);
            } else if (v === null) {
                return setFlagAoRadius(name, null);
            } else {
                return setFlagAoRadius(name, v);
            }
        }

        // existing global tuning behavior unchanged
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
            : 'No valid tuning keys provided. Use: assaultTuning({ retreatAt: 0.6, damageBuffer: 50 }) OR assaultTuning({ aoRadius: 7 }, "FlagName")';
        console.log(msg);
        return msg;
    };
};
