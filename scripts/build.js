'use strict';

/**
 * Bundles src/main.js into dist/main.js (DESIGN §14).
 *
 * Target is ES2017 on purpose: the game's JS runtime version isn't documented
 * anywhere current, and Node 8 (the last documented runtime) supports ES2017.
 * esbuild lowers newer syntax (?. ?? object spread) so we can still write it.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

function gitSha() {
    try {
        return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
    } catch (e) {
        return 'unknown';
    }
}

async function build() {
    const outfile = path.join(root, 'dist', 'main.js');
    const banner = `// screepify v2 · ${gitSha()} · built ${new Date().toISOString()}`;
    const result = await esbuild.build({
        entryPoints: [path.join(root, 'src', 'main.js')],
        outfile,
        bundle: true,
        format: 'cjs',
        platform: 'neutral',
        target: 'es2017',
        banner: { js: banner },
        legalComments: 'none',
        logLevel: 'warning',
        metafile: true
    });
    const bytes = fs.statSync(outfile).size;
    const modules = Object.keys(result.metafile.inputs).length;
    console.log(`built dist/main.js · ${modules} modules · ${(bytes / 1024).toFixed(1)} KB`);
}

if (require.main === module) {
    build().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { build };
