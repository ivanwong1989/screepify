const { ScreepsAPI } = require('screeps-api');
const git = require('simple-git')();
const fs = require('fs');
const path = require('path');

async function uploadDev() {
    // 1. Check current branch
    const status = await git.status();
    if (status.current !== 'dev') {
        console.log(`ℹ️  Current branch is '${status.current}'. Skipping local upload.`);
        console.log(`👉 Switch to 'dev' branch to sync with local server.`);
        return;
    }

    // 2. Local Server Configuration
    const api = new ScreepsAPI({
        host: '127.0.0.1',
        port: 21025,
        password: '', // Set this in your server console
        secure: false
    });

    console.log(`🚀 Syncing 'dev' branch to Local Private Server...`);

    // 3. Gather your code (assumes code is in a folder named 'src')
    const sourceDir = path.join(__dirname, 'src');
    const files = fs.readdirSync(sourceDir)
        .filter(f => f.endsWith('.js'))
        .reduce((acc, f) => {
            const name = f.replace('.js', '');
            acc[name] = fs.readFileSync(path.join(sourceDir, f), 'utf8');
            return acc;
        }, {});

    // 4. Push to the 'default' branch on the local server
    try {
        await api.code.set('default', files);
        console.log(`✅ Local sync complete!`);
    } catch (err) {
        console.error(`❌ Failed to push to local server: ${err.message}`);
    }
}

uploadDev();