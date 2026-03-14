/**
 * Purpose: normalized CRUD helpers for mission records.
 * Responsibilities: maintain active mission objects with compact assignment state.
 * Persistent state touched: Memory.missions.
 * Heap state: none.
 */

function ensureRoot() {
  if (!Memory.missions || typeof Memory.missions !== 'object') {
    Memory.missions = {};
  }
}

function upsert(missionRecord) {
  ensureRoot();
  if (!missionRecord || !missionRecord.id) return null;

  const id = missionRecord.id;
  const existing = Memory.missions[id] || {};

  existing.id = id;
  existing.type = missionRecord.type;
  existing.roomName = missionRecord.roomName;
  existing.priority = missionRecord.priority;
  existing.desired = missionRecord.desired;
  if (!Array.isArray(existing.assigned)) existing.assigned = [];
  existing.status = missionRecord.status || 'active';
  existing.data = missionRecord.data || {};

  Memory.missions[id] = existing;
  return existing;
}

function remove(missionId) {
  ensureRoot();
  delete Memory.missions[missionId];
}

function getAll() {
  ensureRoot();
  return Memory.missions;
}

function getByRoom(roomName) {
  ensureRoot();
  const out = [];
  for (const id in Memory.missions) {
    if (!Object.prototype.hasOwnProperty.call(Memory.missions, id)) continue;
    const record = Memory.missions[id];
    if (record.roomName === roomName) out.push(record);
  }
  return out;
}

function getActiveByRoom(roomName) {
  const records = getByRoom(roomName);
  const out = [];
  for (let i = 0; i < records.length; i++) {
    if (records[i].status === 'active') out.push(records[i]);
  }
  return out;
}

module.exports = {
  upsert,
  remove,
  getAll,
  getByRoom,
  getActiveByRoom,
};
