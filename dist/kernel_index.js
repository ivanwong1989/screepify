/**
 * Purpose: run all systems in strict layered order for each tick.
 * Responsibilities: call every subsystem exactly once in required order.
 * Persistent state touched: indirect via subsystem calls.
 * Heap state: indirect via subsystem calls.
 */

const state = require('state_index');
const heap = require('heap_index');
const intel = require('intel_index');
const empire = require('empire_index');
const policy = require('policy_index');
const services = require('services_index');
const missions = require('missions_index');
const dispatch = require('dispatch_index');
const spawning = require('spawning_index');
const roles = require('roles_index');
const telemetry = require('telemetry_index');
const visuals = require('visuals_index');
const logger = require('utils_logger');

function safeRun(label, fn, context) {
  try {
    fn(context);
  } catch (error) {
    logger.error(label, error && error.stack ? error.stack : error);
  }
}

function run(context) {
  safeRun('state', state.init, context);
  safeRun('heap', heap.init, context);

  context.heap = global.__heap;

  safeRun('intel', intel.run, context);
  safeRun('empire', empire.run, context);
  safeRun('policy', policy.run, context);
  safeRun('services', services.run, context);
  safeRun('missions', missions.run, context);
  safeRun('dispatch', dispatch.run, context);
  safeRun('spawning', spawning.run, context);
  safeRun('roles', roles.run, context);
  safeRun('telemetry', telemetry.run, context);
  safeRun('visuals', visuals.run, context);
}

module.exports = { run };