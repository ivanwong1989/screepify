// utils/sparkStats.js
'use strict';

const heap = require('utils_heap');

const SPARK = '⣀⣄⣤⣦⣶⣷⣿';

function clamp(n, lo, hi) {
    // NaN-safe clamp
    if (!Number.isFinite(n)) return lo;
    return n < lo ? lo : (n > hi ? hi : n);
}

function sparkline(values, min = null, max = null) {
    if (!values || values.length === 0) return '';
    // compute min/max only once; keep it cheap by not doing fancy stuff
    if (min == null || max == null) {
        let vmin = Infinity, vmax = -Infinity;
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (v < vmin) vmin = v;
            if (v > vmax) vmax = v;
        }
        min = (min == null) ? vmin : min;
        max = (max == null) ? vmax : max;
    }
    if (min === max) return SPARK[0].repeat(values.length);

    const span = max - min;
    let out = '';
    for (let i = 0; i < values.length; i++) {
        const t = (values[i] - min) / span; // 0..1
        const levels = SPARK.length;
        const idx = clamp(Math.floor(t * levels), 0, levels - 1);
        out += SPARK[idx];
    }
    return out;
}

// === HEAP ROOT ===
// Volatile history: survives ticks, dies on VM reset (intended).
function ensureRoot() {
    const store = heap.getStore('sparkStats'); // { series: { [name]: { maxLen, data: [] } } }
    if (!store.series || typeof store.series !== 'object') store.series = Object.create(null);
    return store;
}

function getSeries(name, maxLen) {
    const root = ensureRoot();
    const series = root.series;

    if (!series[name]) series[name] = { maxLen, data: [] };

    const s = series[name];
    if (!s.maxLen || s.maxLen !== maxLen) s.maxLen = maxLen;
    if (!Array.isArray(s.data)) s.data = [];
    return s;
}

function pushSeries(name, value, { maxLen = 60 } = {}) {
    const s = getSeries(name, maxLen);
    s.data.push(value);
    const overflow = s.data.length - s.maxLen;
    if (overflow > 0) s.data.splice(0, overflow);
}

function formatNumber(n) {
    if (!Number.isFinite(n)) return String(n);
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'b';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'm';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'k';
    return n.toFixed(2);
}

function printSeries(name, { label = name, min = null, max = null, labelWidth = 0 } = {}) {
    const root = ensureRoot();
    const s = root.series[name];

    const raw = String(label);
    const padded = (labelWidth && labelWidth > 0) ? raw.padEnd(labelWidth, ' ') : raw;

    if (!s || !s.data || s.data.length === 0) return `${padded}: (no data)`;

    const last = s.data[s.data.length - 1];
    const line = sparkline(s.data, min, max);
    return `${padded}: ${line}  last=${formatNumber(last)}`;
}

module.exports = {
    pushSeries,
    printSeries,
    sparkline,
};