// @ts-check
'use strict';

const memhack = require('./kernel/memhack');
const { createKernel } = require('./kernel/kernel');
const registry = require('./kernel/registry');
const consoleCommands = require('./console/index');

// Runs once per VM (global reset).
memhack.register();
const kernel = createKernel(registry);
consoleCommands.register(kernel);

module.exports.loop = function loop() {
    memhack.runHack();
    kernel.tick();
};
