// Synthetic gateway only. Every provider/chain call goes to its dedicated synthetic provider.
const provider = new URL(process.env.STAGING_PROVIDER_ORIGIN ?? process.env.NEAR_INTENTS_AGENT_API_URL);
if (!['https:', 'http:'].includes(provider.protocol) || provider.username || provider.password || provider.pathname !== '/') throw Error('Invalid synthetic provider origin');
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
 if (url.origin === provider.origin || ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return original(input, init);
 if (url.hostname === 'tx.main.fastnear.com' && url.pathname === '/v0/transactions') return original(new URL('/__staging/transactions',provider),init);
 if (url.hostname === 'transfers.main.fastnear.com' && url.pathname === '/v0/transfers') return original(new URL('/__staging/transfers',provider),init);
 throw Error('Synthetic gateway blocked an external fetch');
};
