// @ts-check
'use strict';

const config = require('../config');
const telemetry = require('../kernel/telemetry');

/**
 * Console commands (DESIGN §14). Each returns a string, which the game console prints.
 *
 *   help()                        list commands
 *   stats()                       CPU, bucket, top processes, room CPU
 *   proc.list()                   processes with tier/cadence/state
 *   proc.enable(id) / proc.disable(id) / proc.every(id, n) / proc.reset(id)
 *   config.get(path?) / config.set(path, value) / config.reset(path) / config.reload()
 */

/**
 * @param {string|number} v
 * @param {number} width
 */
function pad(v, width) {
    const s = String(v);
    return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** @param {number} n */
function fmt(n) {
    return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * @param {string} path
 * @param {any} obj
 */
function getPath(path, obj) {
    if (!path) return obj;
    let node = obj;
    for (const key of config.splitPath(path)) {
        if (node === null || node === undefined) return undefined;
        node = node[key];
    }
    return node;
}

/**
 * @param {ReturnType<import('../kernel/kernel').createKernel>} kernel
 */
function register(kernel) {
    const g = /** @type {any} */ (global);

    g.help = () => [
        'stats()                         CPU, bucket, top processes, room CPU',
        'proc.list()                     processes and their state',
        'proc.enable(id) / proc.disable(id)',
        'proc.every(id, n) / proc.reset(id)',
        'config.get(path?) / config.set(path, value) / config.reset(path) / config.reload()'
    ].join('\n');

    g.stats = () => {
        const t = telemetry.state().tick;
        const lines = [
            `CPU avg ${fmt(t.cpuAvg)} / ${Game.cpu.limit}  bucket ${Game.cpu.bucket}  ` +
            `kernel ${fmt(t.kernelAvg)}  skipped/tick ${fmt(t.skippedAvg)}`,
            '',
            `${pad('process', 24)}${pad('cpu/tick', 10)}${pad('cpu/run', 10)}${pad('max', 8)}runs`
        ];
        for (const p of telemetry.topProcesses(15)) {
            lines.push(`${pad(p.id, 24)}${pad(fmt(p.tickAvg), 10)}${pad(fmt(p.runAvg), 10)}${pad(fmt(p.max), 8)}${p.runs}`);
        }
        const rooms = telemetry.state().rooms;
        const names = Object.keys(rooms).sort();
        if (names.length) {
            lines.push('', 'room CPU/tick: ' + names.map(n => `${n} ${fmt(rooms[n])}`).join('  '));
        }
        return lines.join('\n');
    };

    g.proc = {
        list() {
            const cfg = config.get();
            const s = kernel.state();
            const lines = [`${pad('process', 24)}${pad('phase', 8)}${pad('scope', 7)}${pad('tier', 10)}${pad('every', 7)}state`];
            for (const p of kernel.processes) {
                const o = cfg.processes[p.id] || {};
                const q = s.quarantine[p.id];
                const st = o.enabled === false ? 'disabled'
                    : q !== undefined && Game.time < q ? `quarantined until ${q}`
                        : s.fails[p.id] ? `failing (${s.fails[p.id]})` : 'ok';
                lines.push(`${pad(p.id, 24)}${pad(p.phase, 8)}${pad(p.scope, 7)}${pad(p.tier, 10)}${pad(o.every || p.every || 1, 7)}${st}`);
            }
            return lines.join('\n');
        },
        /** @param {string} id */
        enable(id) {
            config.set(`processes.${id}.enabled`, true);
            delete kernel.state().quarantine[id];
            return `${id} enabled`;
        },
        /** @param {string} id */
        disable(id) {
            config.set(`processes.${id}.enabled`, false);
            return `${id} disabled`;
        },
        /** @param {string} id @param {number} n */
        every(id, n) {
            config.set(`processes.${id}.every`, n);
            return `${id} every ${n}`;
        },
        /** @param {string} id */
        reset(id) {
            config.reset(`processes.${id}.enabled`);
            config.reset(`processes.${id}.every`);
            delete kernel.state().quarantine[id];
            return `${id} reset to defaults`;
        }
    };

    g.config = {
        /** @param {string} [path] */
        get(path) {
            return JSON.stringify(getPath(path || '', config.get()), null, 2);
        },
        /** @param {string} path @param {any} value */
        set(path, value) {
            config.set(path, value);
            return `${path} = ${JSON.stringify(value)}`;
        },
        /** @param {string} path */
        reset(path) {
            config.reset(path);
            return `${path} reset`;
        },
        reload() {
            config.load();
            return 'config reloaded';
        }
    };
}

module.exports = { register };
