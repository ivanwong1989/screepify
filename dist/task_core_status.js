'use strict';

const STATUS = Object.freeze({
  OK: 'OK',           // action executed successfully (or actionable state)
  MOVING: 'MOVING',   // needs move / moving to target
  WAIT: 'WAIT',       // intentionally waiting (e.g. target full)
  DONE: 'DONE',       // intent fully completed (optional distinction)
  INVALID: 'INVALID', // intent/task invalid (missing target, etc.)
  RETRY: 'RETRY',     // transient fail; try again next tick
  ERROR: 'ERROR'      // unexpected error (exceptions, etc.)
});

module.exports = STATUS;
