/**
 * Purpose: serialize and compare Screeps RoomPosition values.
 * Responsibilities: compact position storage and safe reconstruction.
 * Persistent state touched: optional serialized strings in Memory records.
 * Heap state: optional runtime RoomPosition caches.
 */

function serializePos(pos) {
  if (!pos) return null;
  return pos.roomName + ':' + pos.x + ':' + pos.y;
}

function deserializePos(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length !== 3) return null;

  const roomName = parts[0];
  const x = Number(parts[1]);
  const y = Number(parts[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return new RoomPosition(x, y, roomName);
}

function samePos(a, b) {
  if (!a || !b) return false;
  return a.roomName === b.roomName && a.x === b.x && a.y === b.y;
}

module.exports = {
  serializePos,
  deserializePos,
  samePos,
};
