// @ts-check
'use strict';

const log = require('../../services/log');

/** CPU taken from the bucket per pixel. */
const PIXEL_CPU_COST = 10000;

/**
 * Generates a pixel whenever the bucket is full (DESIGN D8, §5.2), unless a
 * burst job is waiting for that bucket. Runs in REPORT, after the burst slot.
 * @type {import('../../contracts/process').Process}
 */
module.exports = {
    id: 'report.pixel',
    phase: 'REPORT',
    scope: 'shard',
    tier: 'normal',
    priority: 900,
    run(ctx) {
        if (!ctx.config.pixel.enabled) return;
        if (ctx.kernel.burstPending) return;
        if (ctx.cpu.bucket < PIXEL_CPU_COST) return;
        const cpu = /** @type {any} */ (Game.cpu);
        if (typeof cpu.generatePixel !== 'function') return;
        const result = cpu.generatePixel();
        if (result === OK) log.debug('pixel', 'generated a pixel');
    },
    PIXEL_CPU_COST
};
