/** Independent transport barrier: live verification must never submit an Agent API write. */
function readOnlyProviderFetch(fetch, origin, onBlocked = () => {}) {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === origin || request.headers.has('x-grant-token')) {
      let allowed = request.method === 'GET' || request.method === 'HEAD';
      if (request.method === 'POST' && /^\/v1\/agents\/[^/]+\/swap$/.test(url.pathname)) {
        const body = await request.clone().json().catch(() => null);
        allowed = body?.dry === true;
      }
      if (!allowed) {
        onBlocked();
        throw new Error('Live test blocked an Agent API submission before transport');
      }
      // Never follow a redirect that could turn a read/quote into a different request.
      return fetch(new Request(request, { redirect: 'error' }));
    }
    return fetch(input, init);
  };
}
module.exports = { readOnlyProviderFetch };
if (process.env.PROTO_TEST_MODE === 'live') {
  const origin = new URL(process.env.NEAR_INTENTS_AGENT_API_URL || 'https://api.demo.agentsonintents.com').origin;
  let blocked = false;
  globalThis.fetch = readOnlyProviderFetch(globalThis.fetch, origin, () => { blocked = true; });
  // An expected-error assertion must not accidentally turn a blocked submission into a pass.
  process.on('exit', () => { if (blocked) process.exitCode = 1; });
}
