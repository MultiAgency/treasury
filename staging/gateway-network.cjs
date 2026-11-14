// Synthetic gateway only. Every provider/chain call goes to its dedicated synthetic provider.
const provider = new URL(process.env.STAGING_PROVIDER_ORIGIN ?? process.env.NEAR_INTENTS_AGENT_API_URL);
if (!['https:', 'http:'].includes(provider.protocol) || provider.username || provider.password || provider.pathname !== '/') throw Error('Invalid synthetic provider origin');
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
 if (url.origin === provider.origin || ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return original(input, init);
 // A DAO's signature is found in its real mainnet transactions: its account's list, then those transactions. Synthetic
 // receipts (`synthetic-…`) stay with the provider; a lookup mixing both is refused.
 if (url.hostname === 'tx.main.fastnear.com' && url.pathname === '/v0/account') return original(input, init);
 if (url.hostname === 'tx.main.fastnear.com' && url.pathname === '/v0/transactions') {
  let hashes;
  try { hashes = JSON.parse(typeof init?.body === 'string' ? init.body : '').tx_hashes; } catch {}
  if (!Array.isArray(hashes) || !hashes.length || hashes.some(hash => typeof hash !== 'string')) throw Error('Synthetic gateway blocked a transactions lookup without hashes');
  const synthetic = hashes.filter(hash => hash.startsWith('synthetic-')).length;
  if (synthetic === hashes.length) return original(new URL('/__staging/transactions',provider),init);
  if (synthetic === 0) return original(input, init);
  throw Error('Synthetic gateway blocked a transactions lookup mixing synthetic and chain receipts');
 }
 if (url.hostname === 'transfers.main.fastnear.com' && url.pathname === '/v0/transfers') return original(new URL('/__staging/transfers',provider),init);
 throw Error('Synthetic gateway blocked an external fetch');
};
