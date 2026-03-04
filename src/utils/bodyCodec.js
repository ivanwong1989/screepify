const PART_TO_ID = {
    [MOVE]: 0,
    [WORK]: 1,
    [CARRY]: 2,
    [ATTACK]: 3,
    [RANGED_ATTACK]: 4,
    [HEAL]: 5,
    [TOUGH]: 6,
    [CLAIM]: 7
};

const ID_TO_PART = [
    MOVE,
    WORK,
    CARRY,
    ATTACK,
    RANGED_ATTACK,
    HEAL,
    TOUGH,
    CLAIM
];

// --------------------------------------------
// Body codec v2 (lossless, preserves MOVE=0)
// --------------------------------------------
// v1 packed 3-bit IDs into a BigInt and base36-encoded it.
// That scheme is NOT length-preserving (MOVE=0 at the tail disappears),
// so decoded bodies can lose MOVE parts.
//
// v2 encodes each part as a single base36 digit (0-7), concatenated.
// Example: [WORK,CARRY,MOVE] => "120" (still compact, and lossless).
//
// decodeBody remains backward-compatible:
// - If the string is only [0-7], we treat it as v2.
// - Otherwise we attempt legacy v1 decode (still cannot recover trailing MOVE=0).
function encodeBody(body) {
    if (!Array.isArray(body) || body.length === 0) return '';
    let out = '';
    for (const part of body) {
        const id = PART_TO_ID[part];
        if (id === undefined) throw new Error(`[bodyCodec] unknown part: ${part}`);
        out += id.toString(36); // 0..7 => single char
    }
    return out;
}

function base36ToBigInt(str) {
    // Safe conversion (doesn't overflow Number like parseInt for long strings)
    let n = 0n;
    for (let i = 0; i < str.length; i++) {
        const digit = parseInt(str[i], 36);
        if (!Number.isFinite(digit) || digit < 0) throw new Error(`[bodyCodec] invalid base36: ${str}`);
        n = (n * 36n) + BigInt(digit);
    }
    return n;
}

function decodeBody(encoded) {
    if (!encoded || typeof encoded !== 'string') return [];

    // v2: direct digit stream 0..7
    if (/^[0-7]+$/.test(encoded)) {
        const body = [];
        for (let i = 0; i < encoded.length; i++) {
            const id = parseInt(encoded[i], 36);
            body.push(ID_TO_PART[id]);
        }
        return body;
    }

    // v1 legacy: BigInt base36 packed (cannot recover trailing MOVE=0)
    let bits;
    try {
        bits = base36ToBigInt(encoded);
    } catch (e) {
        // Defensive: if something is corrupted, fail safe to empty.
        return [];
    }

    const body = [];
    while (bits > 0n) {
        const id = Number(bits & 7n);
        body.push(ID_TO_PART[id]);
        bits >>= 3n;
    }
    return body;
}

module.exports = {
    encodeBody,
    decodeBody
};
