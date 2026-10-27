// @ts-check
'use strict';

const laneFit = require('../services/laneFit');
const laneStore = require('../services/laneStore');

/**
 * Lane fit console (services/laneFit, plan.laneFit).
 *
 *   laneFit.show(room)   dry run: every spawn/tower/extension the room may still
 *                        get, in build order, drawn in the room for this tick
 *
 * On/off: config.set('laneFit.enabled', true|false); sites at once:
 * config.set('laneFit.maxSites', 2); veto a tile with a flag named NOBUILD*.
 */

const MARK = { [STRUCTURE_SPAWN]: 'S', [STRUCTURE_TOWER]: 'T', [STRUCTURE_EXTENSION]: 'e' };

function register() {
    const g = /** @type {any} */ (global);
    g.laneFit = {
        /** @param {string} roomName */
        show(roomName) {
            const room = Game.rooms[roomName];
            if (!room) return `no vision in ${roomName}`;
            const lane = laneStore.get(room);
            if (!lane) return `${roomName}: no core lane yet`;
            const saved = laneStore.saved(roomName);
            const stale = !saved || saved.sig !== laneStore.signature(room);
            const { picks, need, slots } = laneFit.plan(room, lane, Infinity);
            const lines = [
                `${roomName}: lane ${lane.path.length} tiles${lane.loop ? ' (loop)' : ''}, ${slots} free slots next to it` +
                    `${stale ? ' — lane out of date, plan.laneFit waits for the rebuild' : ''}`,
                `RCL allows ${laneFit.TYPES.map(t => `+${need[t]} ${t}`).join(', ')}`
            ];
            for (const t of laneFit.TYPES) {
                const mine = picks.filter(p => p.type === t);
                if (mine.length) lines.push(`  ${t}: ${mine.map(p => `${p.x},${p.y}`).join('  ')}`);
                const short = need[t] - mine.length;
                if (short > 0) lines.push(`  ${t}: ${short} with no slot (lane too short or boxed in)`);
            }
            const vis = typeof RoomVisual === 'function' ? new RoomVisual(roomName) : null;
            if (vis) {
                picks.forEach((p, i) => vis.text(`${MARK[p.type] || '?'}${i + 1}`, p.x, p.y + 0.2, { color: '#7fff7f', font: 0.4 }));
            }
            return lines.join('\n');
        }
    };
}

module.exports = { register };
