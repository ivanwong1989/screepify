/**
 * Combat Visualizer: renders the combat CostMatrix (PF overlay) to RoomVisual.
 *
 * Usage:
 *   const combatVis = require('managers_admiral_visuals_admiral.visuals.combat');
 *   combatVis.drawCombatMatrix(room, roomCallback, { step: 1, minCost: 20 });
 */

function colorForCost(c) {
    // 255 = impassable: draw dark
    if (c >= 255) return { fill: '#000000', opacity: 0.45 };

    // base terrain/roads are low. danger overlay is usually higher.
    if (c >= 220) return { fill: '#8e44ad', opacity: 0.35 }; // purple (tower near)
    if (c >= 140) return { fill: '#c0392b', opacity: 0.30 }; // red
    if (c >= 80)  return { fill: '#e67e22', opacity: 0.26 }; // orange
    if (c >= 45)  return { fill: '#f1c40f', opacity: 0.22 }; // yellow
    if (c >= 20)  return { fill: '#2ecc71', opacity: 0.18 }; // green-ish
    return null; // too low = don't draw (keeps screen clean)
}

function drawLegend(vis, x, y) {
    const lines = [
        'CombatMatrix',
        '>=220 purple',
        '>=140 red',
        '>=80 orange',
        '>=45 yellow',
        '>=20 green',
        '255 impassable'
    ];
    for (let i = 0; i < lines.length; i++) {
        vis.text(lines[i], x, y + i * 0.6, {
            font: 0.5,
            align: 'left',
            opacity: 0.9,
            stroke: '#000000',
            strokeWidth: 0.12
        });
    }
}

function drawCombatMatrix(room, roomCallback, opts) {
    if (!room || !roomCallback) return;

    const {
        // step=1 harcoded to avoid visual bug
        step = 1,
        // ignore low costs so it’s readable
        minCost = 20,
        // draw a tiny legend
        legend = true,
        // if true, print numbers for high danger tiles (heavier)
        showNumbers = false,
        // only show numbers when >= this
        numberThreshold = 120,
    } = opts || {};

    // hard clamp: combat matrix must be tile-accurate
    const s = 1;

    const costs = roomCallback(room.name);
    if (!costs) return;

    const vis = new RoomVisual(room.name);

    if (legend) drawLegend(vis, 1, 1);

    for (let x = 0; x < 50; x += step) {
        for (let y = 0; y < 50; y += step) {
            // sample center of the block (prevents "shifted" feeling)
            const sx = Math.min(49, x + Math.floor(step / 2));
            const sy = Math.min(49, y + Math.floor(step / 2));

            const c = costs.get(sx, sy);

            if (c < minCost && c !== 255) continue;

            const style = colorForCost(c);
            if (!style) continue;

            vis.rect(x - 0.5, y - 0.5, step, step, {
                fill: style.fill,
                opacity: style.opacity,
                stroke: undefined
            });

            if (showNumbers && c >= numberThreshold && c !== 255) {
                // put number near the sampled center too
                vis.text(String(c), sx, sy + 0.15, {
                    font: 0.35,
                    opacity: 0.9,
                    color: '#ffffff',
                    stroke: '#000000',
                    strokeWidth: 0.12
                });
            }
        }
    }
}

module.exports = {
    drawCombatMatrix
};