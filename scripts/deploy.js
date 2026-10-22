'use strict';

/**
 * Uploads dist/main.js to a Screeps code branch (DESIGN §14).
 *
 *   node scripts/deploy.js [--branch v2] [--ptr]
 *
 * Token: SCREEPS_TOKEN env var, or `token` in .screeps.json.
 * This NEVER activates the branch. Switching the live colony to v2 is a manual
 * step in-game (or via the API) — that's the switchover/rollback lever.
 *
 * Uses Node's https directly (no axios), so it works behind HTTPS proxies too.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

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

/**
 * @param {string} method
 * @param {string} apiPath  e.g. '/api/user/code'
 * @param {object|null} body
 * @param {{token: string, prefix: string}} opts
 */
function request(method, apiPath, body, opts) {
    const data = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'screeps.com',
            port: 443,
            path: opts.prefix + apiPath,
            method,
            headers: Object.assign(
                { 'X-Token': opts.token },
                data ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) } : {}
            )
        }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => {
                let json = null;
                try {
                    json = JSON.parse(text);
                } catch (e) {
                    return reject(new Error(`${method} ${apiPath} → HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                }
                if (res.statusCode !== 200 || json.ok !== 1) {
                    return reject(new Error(`${method} ${apiPath} → HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                }
                resolve(json);
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function deploy() {
    const branch = arg('branch', 'v2');
    const ptr = !!arg('ptr', false);
    const token = readToken();
    if (!token) throw new Error('No token: set SCREEPS_TOKEN or add "token" to .screeps.json');
    const opts = { token, prefix: ptr ? '/ptr' : '' };

    const file = path.join(root, 'dist', 'main.js');
    if (!fs.existsSync(file)) throw new Error('dist/main.js missing: run `npm run build` first');
    const modules = { main: fs.readFileSync(file, 'utf8') };

    const { list = [] } = await request('GET', '/api/user/branches', null, opts);
    const activeWorld = (list.find(b => b.activeWorld) || {}).branch;
    if (!list.some(b => b.branch === branch)) {
        // Clone from the active branch, then overwrite with our code below.
        const source = activeWorld || 'default';
        await request('POST', '/api/user/clone-branch', { branch: source, newName: branch, defaultModules: modules }, opts);
        console.log(`created code branch "${branch}" (cloned from "${source}")`);
    }

    await request('POST', '/api/user/code', { branch, modules }, opts);
    console.log(`uploaded ${(modules.main.length / 1024).toFixed(1)} KB to ${ptr ? 'PTR ' : ''}branch "${branch}"`);
    console.log(`active world branch: "${activeWorld || 'unknown'}"${activeWorld === branch ? '  ← LIVE' : ' (unchanged)'}`);
}

deploy().catch(err => {
    console.error(err.message || err);
    process.exit(1);
});
