'use strict';

const cpuEma = require('telemetry_cpuEma');
const sparkTelemetry = require('telemetry_sparkTelemetry');

function tick() {
    // keep EMA responsibility here (still telemetry)
    cpuEma.tick();
    sparkTelemetry.sample();
}

function print() {
    sparkTelemetry.print();
}

module.exports = { tick, print };