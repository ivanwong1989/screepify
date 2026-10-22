'use strict';

/**
 * Uploads dist/main.js to a Screeps code branch (DESIGN §14).
 *
 *   node scripts/deploy.js [--branch v2] [--ptr]
 *
 * Token: SCREEPS_TOKEN env var, or `token` in .screeps.json.
 * This NEVER activates the branch. Switching the live colony to v2 is a manual
 * step in-game (or via the API) — that's the switchover/rollback lever.
 */

const fs = require('fs');
const path = require('path');
const { ScreepsAPI } = require('screeps-api');

const root = path.join(__dirname, '..');

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const next = process.argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
}

function readToken() {
    if (process.env.SCREEPS_TOKEN) return process.env.SCREEPS_TOKEN;
    try {
        return require(path.join(root, '.screeps.json')).token;
    } catch (e) {
        return null;
    }
}

async function deploy() {
    const branch = arg('branch', 'v2');
    const ptr = !!arg('ptr', false);
    const token = readToken();
    if (!token) throw new Error('No token: set SCREEPS_TOKEN or add "token" to .screeps.json');

    const file = path.join(root, 'dist', 'main.js');
    if (!fs.existsSync(file)) throw new Error('dist/main.js missing: run `npm run build` first');
    const modules = { main: fs.readFileSync(file, 'utf8') };

    const api = new ScreepsAPI({
        token,
        protocol: 'https',
        hostname: 'screeps.com',
        port: 443,
        path: ptr ? '/ptr/' : '/'
    });

    const { list = [] } = await api.raw.user.branches();
    if (!list.some(b => b.branch === branch)) {
        // Clone from the active branch, then overwrite with our code below.
        const active = list.find(b => b.activeWorld) || list[0];
        const source = active ? active.branch : 'default';
        await api.raw.user.cloneBranch(source, branch, modules);
        console.log(`created code branch "${branch}" (cloned from "${source}")`);
    }

    const res = await api.code.set(branch, modules);
    if (!res || res.ok !== 1) throw new Error(`upload failed: ${JSON.stringify(res)}`);

    const activeWorld = (list.find(b => b.activeWorld) || {}).branch;
    console.log(`uploaded ${(modules.main.length / 1024).toFixed(1)} KB to ${ptr ? 'PTR ' : ''}branch "${branch}"`);
    console.log(`active world branch: "${activeWorld || 'unknown'}"${activeWorld === branch ? '  ← LIVE' : ' (unchanged)'}`);
}

deploy().catch(err => {
    console.error(err.message || err);
    process.exit(1);
});
