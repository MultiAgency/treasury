const assert = require('node:assert/strict');

/** Every RPC, including a write, must be deliberately declared by the scenario. */
function rpcValue(values, method) {
  assert.ok(Object.hasOwn(values, method), `Unexpected RPC: ${method}`);
  // Explicit undefined is a legitimate void RPC result; absent properties are never accepted.
  return values[method];
}
module.exports = { rpcValue };
