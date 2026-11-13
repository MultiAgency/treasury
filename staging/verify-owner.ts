import { verifyNep413Signature } from '../apps/server/node_modules/near-kit/dist/index.js';
import type { KeyLookup } from '../apps/server/src/keys.ts';

/** Read-only ownership lookup is injected; no transaction RPC or signing key is accepted here. */
export async function verifyOwner({ account, publicKey, signature, message, recipient, nonce, expiresAt, lookup, now = Date.now() }: {
  account: string; publicKey: string; signature: string; message: string; recipient: string;
  nonce: string; expiresAt: number; lookup: KeyLookup; now?: number;
}) {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('Intent expired');
  const bytes = Buffer.from(nonce, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== nonce) throw new Error('Invalid nonce');
  const valid = await verifyNep413Signature({ accountId: account, publicKey, signature },
    { message, recipient, nonce: new Uint8Array(bytes) }, { nonceValidation: 'none' });
  if (!valid) throw new Error('Invalid signature');
  const permission = await lookup(account, publicKey);
  if (permission === 'unavailable') throw new Error('Wallet ownership unavailable');
  if (permission !== 'full') throw new Error('Full-access owner key required');
}
