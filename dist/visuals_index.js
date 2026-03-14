/**
 * Purpose: optional low-cost debug visuals.
 * Responsibilities: draw basic status overlays only when explicitly enabled.
 * Persistent state touched: reads Memory.bot.debug.visuals.
 * Heap state: none.
 */

function run(context) {
  const enabled = !!(Memory.bot && Memory.bot.debug && Memory.bot.debug.visuals);
  if (!enabled) return;

  const rooms = context && Array.isArray(context.rooms) ? context.rooms : [];
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    room.visual.text('srv:' + Object.keys(Memory.services || {}).length, 1, 1, { align: 'left' });
    room.visual.text('msn:' + Object.keys(Memory.missions || {}).length, 1, 2, { align: 'left' });
  }
}

module.exports = { run };
