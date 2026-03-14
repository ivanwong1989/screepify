/**
 * Purpose: role execution dispatcher for all creeps.
 * Responsibilities: resolve role and call narrow runner modules.
 * Persistent state touched: none directly.
 * Heap state: none.
 */

const creepUtils = require('utils_creep');
const minerStatic = require('roles_role.minerStatic');
const worker = require('roles_role.worker');
const haulerDedicated = require('roles_role.haulerDedicated');
const upgraderStatic = require('roles_role.upgraderStatic');

function resolveRole(creep) {
  if (creep.memory && creep.memory.role) return creep.memory.role;
  const parsed = creepUtils.parseCreepName(creep.name);
  return parsed ? parsed.role : null;
}

function runRole(creep, role) {
  if (role === 'minerStatic') return minerStatic.run(creep);
  if (role === 'worker') return worker.run(creep);
  if (role === 'haulerDedicated') return haulerDedicated.run(creep);
  if (role === 'upgraderStatic') return upgraderStatic.run(creep);
  return null;
}

function run(context) {
  const creeps = context && context.creeps ? context.creeps : Game.creeps;
  for (const name in creeps) {
    if (!Object.prototype.hasOwnProperty.call(creeps, name)) continue;
    const creep = creeps[name];
    const role = resolveRole(creep);
    if (!role) continue;
    runRole(creep, role);
  }
}

module.exports = { run };
