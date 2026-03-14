/**
 * Purpose: provide lightweight logging wrappers.
 * Responsibilities: print structured logs with tick prefix.
 * Persistent state touched: none.
 * Heap state: none.
 */

function toText(args) {
  return args
    .map(function mapArg(value) {
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch (error) {
        return String(value);
      }
    })
    .join(' ');
}

function info() {
  console.log('[INFO][' + Game.time + '] ' + toText(Array.prototype.slice.call(arguments)));
}

function warn() {
  console.log('[WARN][' + Game.time + '] ' + toText(Array.prototype.slice.call(arguments)));
}

function error() {
  console.log('[ERROR][' + Game.time + '] ' + toText(Array.prototype.slice.call(arguments)));
}

module.exports = {
  info,
  warn,
  error,
};
