const profiler = require('screeps-profiler');

function makeNamedFn(displayName, fn) {
  // Creates a function whose .name becomes displayName (or close to it)
  // Using an object literal with computed key makes V8 assign the name.
  return {
    [displayName]: function (...args) {
      return fn.apply(this, args);
    }
  }[displayName];
}

function profRequire(path, name) {
  const exp = require(path);

  if (Memory.profilerEnabled !== true) return exp;

  if (!global.__profRequire) global.__profRequire = { wrapped: {} };
  const cache = global.__profRequire.wrapped;

  // cache key must be stable
  const key = `${path}::${name}`;

  if (cache[key]) return cache[key];

  let wrapped = exp;

  if (typeof exp === 'function') {
    // IMPORTANT: name the function BEFORE registerFN so exports that rely on fn.name work
    const named = makeNamedFn(name.replace(/[^\w$]/g, '_'), exp);
    wrapped = profiler.registerFN(named, name);
  } else if (exp && typeof exp === 'object') {
    profiler.registerObject(exp, name);
    wrapped = exp;
  }

  cache[key] = wrapped;
  return wrapped;
}

module.exports = { profRequire };