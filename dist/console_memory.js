function isSafeMemoryKey(key) {
    if (typeof key !== 'string') return false;
    if (!key) return false;
    return key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
}

function parseMemoryPath(path) {
    if (typeof path !== 'string') {
        return { ok: false, error: 'Path must be a string.' };
    }
    var raw = path.trim();
    if (!raw) {
        return { ok: false, error: 'Path cannot be empty.' };
    }

    var tokens = raw.split('.');
    if (!tokens || tokens.length === 0) {
        return { ok: false, error: 'Invalid path.' };
    }

    var parts = [];
    for (var i = 0; i < tokens.length; i++) {
        var part = (tokens[i] || '').trim();
        if (!part) {
            return { ok: false, error: 'Invalid path segment.' };
        }
        if (!isSafeMemoryKey(part)) {
            return { ok: false, error: 'Unsafe path segment.' };
        }
        parts.push(part);
    }

    if (parts.length === 0) {
        return { ok: false, error: 'Invalid path.' };
    }

    return { ok: true, parts: parts, path: parts.join('.') };
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function getAtPath(root, parts) {
    var node = root;
    for (var i = 0; i < parts.length; i++) {
        if (!node || typeof node !== 'object') {
            return { exists: false, value: undefined };
        }
        var key = parts[i];
        if (!Object.prototype.hasOwnProperty.call(node, key)) {
            return { exists: false, value: undefined };
        }
        node = node[key];
    }
    return { exists: true, value: node };
}

function setAtPath(root, parts, value) {
    var node = root;
    for (var i = 0; i < parts.length - 1; i++) {
        var key = parts[i];
        if (!isSafeMemoryKey(key)) return { ok: false, error: 'Unsafe path segment.' };
        if (!Object.prototype.hasOwnProperty.call(node, key) || !node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) {
            node[key] = {};
        }
        node = node[key];
    }
    var last = parts[parts.length - 1];
    if (!isSafeMemoryKey(last)) return { ok: false, error: 'Unsafe path segment.' };
    node[last] = value;
    return { ok: true };
}

function deleteAtPath(root, parts) {
    var node = root;
    for (var i = 0; i < parts.length - 1; i++) {
        var key = parts[i];
        if (!node || typeof node !== 'object') return { ok: true, deleted: false };
        if (!Object.prototype.hasOwnProperty.call(node, key)) return { ok: true, deleted: false };
        node = node[key];
    }
    if (!node || typeof node !== 'object') return { ok: true, deleted: false };
    var last = parts[parts.length - 1];
    if (!Object.prototype.hasOwnProperty.call(node, last)) return { ok: true, deleted: false };
    delete node[last];
    return { ok: true, deleted: true };
}

function mergePlainObject(target, patch) {
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (!isSafeMemoryKey(key)) {
            return { ok: false, error: 'Unsafe patch key.' };
        }
        var value = patch[key];
        if (isPlainObject(value)) {
            if (!isPlainObject(target[key])) target[key] = {};
            var nested = mergePlainObject(target[key], value);
            if (!nested.ok) return nested;
        } else {
            target[key] = value;
        }
    }
    return { ok: true };
}

function patchAtPath(root, parts, patch) {
    if (!isPlainObject(patch)) {
        return { ok: false, error: 'Patch must be a plain object.' };
    }
    var got = getAtPath(root, parts);
    if (!got.exists || !isPlainObject(got.value)) {
        var created = setAtPath(root, parts, {});
        if (!created.ok) return created;
        got = getAtPath(root, parts);
    }
    if (!got.exists || !isPlainObject(got.value)) {
        return { ok: false, error: 'Target is not patchable.' };
    }
    return mergePlainObject(got.value, patch);
}

function logResult(result) {
    var op = result && result.op ? result.op : 'mem';
    if (result && result.ok) {
        console.log('[' + op + '] ok ' + (result.path || ''));
    } else {
        console.log('[' + op + '] fail ' + (result && result.error ? result.error : 'unknown'));
    }
}

function asErrorResult(op, path, error) {
    return {
        ok: false,
        op: op,
        path: (typeof path === 'string' ? path : ''),
        error: error || 'Unknown error'
    };
}

function memwrite(path, value) {
    try {
        var parsed = parseMemoryPath(path);
        if (!parsed.ok) {
            var bad = asErrorResult('write', path, parsed.error);
            logResult(bad);
            return bad;
        }
        var written = setAtPath(Memory, parsed.parts, value);
        if (!written.ok) {
            var failed = asErrorResult('write', parsed.path, written.error);
            logResult(failed);
            return failed;
        }
        var result = { ok: true, op: 'write', path: parsed.path, value: value };
        logResult(result);
        return result;
    } catch (err) {
        var trapped = asErrorResult('write', path, err && err.message ? err.message : 'Unexpected error');
        logResult(trapped);
        return trapped;
    }
}

function memread(path) {
    try {
        var parsed = parseMemoryPath(path);
        if (!parsed.ok) {
            var bad = asErrorResult('read', path, parsed.error);
            logResult(bad);
            return bad;
        }
        var got = getAtPath(Memory, parsed.parts);
        var result = { ok: true, op: 'read', path: parsed.path, value: got.value };
        logResult(result);
        return result;
    } catch (err) {
        var trapped = asErrorResult('read', path, err && err.message ? err.message : 'Unexpected error');
        logResult(trapped);
        return trapped;
    }
}

function memdelete(path) {
    try {
        var parsed = parseMemoryPath(path);
        if (!parsed.ok) {
            var bad = asErrorResult('delete', path, parsed.error);
            logResult(bad);
            return bad;
        }
        var deleted = deleteAtPath(Memory, parsed.parts);
        if (!deleted.ok) {
            var failed = asErrorResult('delete', parsed.path, deleted.error);
            logResult(failed);
            return failed;
        }
        var result = { ok: true, op: 'delete', path: parsed.path, deleted: !!deleted.deleted };
        logResult(result);
        return result;
    } catch (err) {
        var trapped = asErrorResult('delete', path, err && err.message ? err.message : 'Unexpected error');
        logResult(trapped);
        return trapped;
    }
}

function mempatch(path, patch) {
    try {
        var parsed = parseMemoryPath(path);
        if (!parsed.ok) {
            var bad = asErrorResult('patch', path, parsed.error);
            logResult(bad);
            return bad;
        }
        var merged = patchAtPath(Memory, parsed.parts, patch);
        if (!merged.ok) {
            var failed = asErrorResult('patch', parsed.path, merged.error);
            logResult(failed);
            return failed;
        }
        var result = { ok: true, op: 'patch', path: parsed.path };
        logResult(result);
        return result;
    } catch (err) {
        var trapped = asErrorResult('patch', path, err && err.message ? err.message : 'Unexpected error');
        logResult(trapped);
        return trapped;
    }
}

module.exports = function registerMemoryConsole() {
    global.memwrite = memwrite;
    global.memread = memread;
    global.memdelete = memdelete;
    global.mempatch = mempatch;
};

module.exports.parseMemoryPath = parseMemoryPath;
module.exports.isSafeMemoryKey = isSafeMemoryKey;
module.exports.getAtPath = getAtPath;
module.exports.setAtPath = setAtPath;
module.exports.deleteAtPath = deleteAtPath;
module.exports.patchAtPath = patchAtPath;

/*
Manual console checks:
memwrite("market.globalEnabled", true)
memread("market.globalEnabled")
memwrite("market.rooms.W44S28.buy.energy.enabled", true)
memwrite("market.rooms.W44S28.buy.energy.maxPrice", 0.85)
mempatch("market.rooms.W44S28.buy.energy", {"enabled":true,"maxPrice":0.85,"desiredAmount":20000})
memdelete("market.rooms.W44S28.buy.energy.desiredAmount")
memwrite("__proto__.x", 1)
memwrite("market..bad", 1)
mempatch("market.rooms.W44S28.buy.energy", 123)
*/
