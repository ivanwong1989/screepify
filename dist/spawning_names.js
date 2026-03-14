/**
 * Purpose: generate informative deterministic creep names.
 * Responsibilities: encode role, room, anchor/mission and token.
 * Persistent state touched: none.
 * Heap state: none.
 */

function sanitize(value) {
  if (!value) return 'none';
  return String(value).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}

function makeServiceName(serviceRecord) {
  const role = sanitize(serviceRecord.role);
  const roomName = sanitize(serviceRecord.roomName);
  const anchor = sanitize(serviceRecord.anchorId || serviceRecord.id);
  const token = String(Game.time % 10000).padStart(4, '0');
  return role + '_' + roomName + '_' + anchor + '_' + token;
}

function makeSharedName(roleName, roomName) {
  const role = sanitize(roleName);
  const room = sanitize(roomName);
  const token = String(Game.time % 10000).padStart(4, '0');
  return role + '_' + room + '_shared_' + token;
}

module.exports = {
  makeServiceName,
  makeSharedName,
};
