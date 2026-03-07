/**
 * Combat Visualizer for assault pathing debug.
 *
 * Default mode is lightweight:
 * - Draw anchor/chosen tiles
 * - Draw hostile ATTACK / RANGED_ATTACK threat zones
 * - Draw short-range hostile tower danger zones
 *
 * Full-room heatmap is optional via `showHeatmap: true`.
 */

function colorForCost(c) {
    if (c >= 255) return { fill: '#000000', opacity: 0.45 };
    if (c >= 220) return { fill: '#8e44ad', opacity: 0.35 };
    if (c >= 140) return { fill: '#c0392b', opacity: 0.30 };
    if (c >= 80) return { fill: '#e67e22', opacity: 0.26 };
    if (c >= 45) return { fill: '#f1c40f', opacity: 0.22 };
    if (c >= 20) return { fill: '#2ecc71', opacity: 0.18 };
    return null;
}

function drawLegend(vis, x, y, showHeatmap) {
    const lines = showHeatmap
        ? [
            'CombatMatrix',
            'mode: heatmap',
            '>=220 purple',
            '>=140 red',
            '>=80 orange',
            '>=45 yellow',
            '>=20 green',
            '255 impassable'
        ]
        : [
            'CombatMatrix',
            'mode: focused',
            'red ring: melee',
            'orange ring: ranged',
            'purple ring: tower'
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

function hasLivePart(creep, partType) {
    if (!creep || !Array.isArray(creep.body)) return false;
    for (const p of creep.body) {
        if (p && p.type === partType && p.hits > 0) return true;
    }
    return false;
}

function drawThreatFocus(vis, room, opts) {
    const {
        showHostileThreat = true,
        showTowerDanger = true,
        towerDangerRange = 8,
    } = opts || {};

    if (showHostileThreat) {
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        for (const h of hostiles) {
            const hasMelee = hasLivePart(h, ATTACK);
            const hasRanged = hasLivePart(h, RANGED_ATTACK);
            if (!hasMelee && !hasRanged) continue;

            if (hasMelee) {
                vis.circle(h.pos.x, h.pos.y, {
                    radius: 1.1,
                    fill: '#ff4d4d',
                    opacity: 0.14,
                    stroke: '#ff4d4d',
                    strokeWidth: 0.10
                });
            }

            if (hasRanged) {
                vis.circle(h.pos.x, h.pos.y, {
                    radius: 3.1,
                    fill: '#ff9933',
                    opacity: 0.10,
                    stroke: '#ff9933',
                    strokeWidth: 0.10
                });
            }
        }
    }

    if (showTowerDanger) {
        const towers = room.find(FIND_STRUCTURES, {
            filter: (s) => s.structureType === STRUCTURE_TOWER && !s.my
        });

        const r = Math.max(1, Math.min(20, Number(towerDangerRange) || 8));
        for (const t of towers) {
            vis.circle(t.pos.x, t.pos.y, {
                radius: r + 0.1,
                fill: '#8e44ad',
                opacity: 0.08,
                stroke: '#8e44ad',
                strokeWidth: 0.10
            });
        }
    }
}

function normalizeAnchor(a, roomName) {
    if (!a) return null;
    const rn = a.roomName || (a.room && a.room.name) || roomName;
    if (rn !== roomName) return null;
    const x = a.x;
    const y = a.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || x > 49 || y < 0 || y > 49) return null;
    return {
        roomName: rn,
        x: Math.floor(x),
        y: Math.floor(y),
        kind: a.kind || 'anchor',
        label: a.label || null
    };
}

function styleForAnchor(kind) {
    if (kind === 'solo') return { stroke: '#ff4dff', text: '#ff4dff', glyph: 'S' };
    if (kind === 'duo') return { stroke: '#00e5ff', text: '#00e5ff', glyph: 'D' };
    return { stroke: '#ffffff', text: '#ffffff', glyph: 'A' };
}

function drawHeatmap(vis, costs, opts) {
    const {
        step = 1,
        minCost = 20,
        showNumbers = false,
        numberThreshold = 120,
        showLowNumbers = false,
        lowNumberThreshold = 3,
    } = opts || {};

    for (let x = 0; x < 50; x += step) {
        for (let y = 0; y < 50; y += step) {
            const sx = Math.min(49, x + Math.floor(step / 2));
            const sy = Math.min(49, y + Math.floor(step / 2));
            const c = costs.get(sx, sy);

            if (c >= minCost || c === 255) {
                const style = colorForCost(c);
                if (style) {
                    vis.rect(x - 0.5, y - 0.5, step, step, {
                        fill: style.fill,
                        opacity: style.opacity,
                        stroke: undefined
                    });
                }
            }

            if (showLowNumbers && c !== 255 && c >= lowNumberThreshold && c < minCost) {
                vis.text(String(c), sx, sy + 0.15, {
                    font: 0.32,
                    opacity: 0.55,
                    color: '#b6ffb6',
                    stroke: '#000000',
                    strokeWidth: 0.10
                });
            }

            if (showNumbers && c >= numberThreshold && c !== 255) {
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

function drawCombatMatrix(room, roomCallback, opts) {
    if (!room || !roomCallback) return;

    const {
        legend = true,
        showHeatmap = false,

        // Threat focus options.
        showHostileThreat = true,
        showTowerDanger = true,
        towerDangerRange = 8,

        // Heatmap options (used only when showHeatmap=true).
        step = 1,
        minCost = 20,
        showNumbers = false,
        numberThreshold = 120,
        showLowNumbers = false,
        lowNumberThreshold = 3,

        // [{roomName,x,y,kind:'solo'|'duo'|'anchor',label?:string}]
        anchorPositions = null,
    } = opts || {};

    const vis = new RoomVisual(room.name);
    if (legend) drawLegend(vis, 1, 1, showHeatmap);

    drawThreatFocus(vis, room, { showHostileThreat, showTowerDanger, towerDangerRange });

    let costs = null;
    if (showHeatmap || (Array.isArray(anchorPositions) && anchorPositions.length)) {
        costs = roomCallback(room.name);
    }

    if (showHeatmap && costs) {
        drawHeatmap(vis, costs, {
            step,
            minCost,
            showNumbers,
            numberThreshold,
            showLowNumbers,
            lowNumberThreshold,
        });
    }

    if (Array.isArray(anchorPositions) && anchorPositions.length) {
        for (const raw of anchorPositions) {
            const a = normalizeAnchor(raw, room.name);
            if (!a) continue;

            const st = styleForAnchor(a.kind);

            vis.rect(a.x - 0.5, a.y - 0.5, 1, 1, {
                fill: undefined,
                stroke: st.stroke,
                strokeWidth: 0.18,
                opacity: 0.95
            });

            vis.text(st.glyph, a.x, a.y + 0.2, {
                font: 0.55,
                opacity: 0.9,
                color: st.text,
                stroke: '#000000',
                strokeWidth: 0.12
            });

            if (a.label) {
                vis.text(String(a.label), a.x, a.y - 0.25, {
                    font: 0.35,
                    opacity: 0.85,
                    color: st.text,
                    stroke: '#000000',
                    strokeWidth: 0.12
                });
            }

            // Show current matrix cost at the chosen tile for quick tactical checks.
            if (costs) {
                const c = costs.get(a.x, a.y);
                vis.text(String(c), a.x, a.y + 0.48, {
                    font: 0.28,
                    opacity: 0.9,
                    color: '#ffffff',
                    stroke: '#000000',
                    strokeWidth: 0.10
                });
            }
        }
    }
}

module.exports = {
    drawCombatMatrix
};
