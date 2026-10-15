// A process-wide backstop, inherited by Node fixture children. Loopback/IPC fixtures remain real.
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const loopback = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node's net.connect forwards a normalized [options, callback] tuple.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' ? first : typeof first === 'string' && !/^\d+$/.test(first) ? { path: first }
    : { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (!options.path && !loopback(options.host ?? options.hostname ?? 'localhost')) throw new Error('Offline test blocked a non-loopback connection');
  // A custom resolver could turn an allowed hostname into an external address.
  if (!options.path && options.lookup) throw new Error('Offline test blocked a custom DNS resolver');
  return Reflect.apply(connect, this, args);
};
syncBuiltinESMExports();
const fetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!loopback(url.hostname)) throw new Error('Offline test blocked a non-loopback fetch');
  return fetch(input, init);
};
