/**
 * Purpose: normalized CRUD helpers for persistent service records.
 * Responsibilities: upsert, remove, and fetch services by room.
 * Persistent state touched: Memory.services.
 * Heap state: none.
 */

function ensureRoot() {
  if (!Memory.services || typeof Memory.services !== 'object') {
    Memory.services = {};
  }
}

function upsert(serviceRecord) {
  ensureRoot();
  if (!serviceRecord || !serviceRecord.id) return null;

  const id = serviceRecord.id;
  const existing = Memory.services[id] || {};

  existing.id = id;
  existing.type = serviceRecord.type;
  existing.roomName = serviceRecord.roomName;
  existing.anchorId = serviceRecord.anchorId || null;
  existing.role = serviceRecord.role;
  existing.desired = serviceRecord.desired;
  existing.mode = serviceRecord.mode;
  existing.data = serviceRecord.data || {};

  Memory.services[id] = existing;
  return existing;
}

function remove(serviceId) {
  ensureRoot();
  delete Memory.services[serviceId];
}

function getAll() {
  ensureRoot();
  return Memory.services;
}

function getByRoom(roomName) {
  ensureRoot();
  const out = [];
  for (const id in Memory.services) {
    if (!Object.prototype.hasOwnProperty.call(Memory.services, id)) continue;
    const record = Memory.services[id];
    if (record.roomName === roomName) out.push(record);
  }
  return out;
}

module.exports = {
  upsert,
  remove,
  getAll,
  getByRoom,
};
