import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createGrantCredential } from '@near-intents-agent-api/sdk';
import { Near, parseKey } from 'near-kit';

// Generated for each local environment. Never load application credentials or funded keys.
export const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const OWNER = 'owner.near', PAYEE = 'payee.near';
export const TEST_KEY = 'ed25519:vbKRaNtGLifEXMGHhMgHEnHyuLjX1Hb6VdEDQJ4NkARFxCcx4AYdyeLRLuLsoGbuDtwUZBHKtJkzM5RzBRafzNk';
export const PUBLIC_KEY = parseKey(TEST_KEY).publicKey.toString();
export async function sign(account, payload) {
  const near = new Near({ network: 'mainnet', privateKey: TEST_KEY, defaultSignerId: account });
  return { accountId: account, ...await near.signMessage({ ...payload, nonce: Buffer.from(payload.nonce, 'base64') }) };
}
export const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const json = (res, value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
const bodyOf = async req => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : null; };

export async function provider(directory, { treasury = false, account = OWNER } = {}) {
  const id = randomBytes(32).toString('hex');
  const credential = createGrantCredential();
  const owner = { type: 'near', account_id: account, public_key: PUBLIC_KEY };
  const wallet = { wallet_id: 'local-wallet', near_account_id: 'local-wallet.near' };
  const policy = { frozen: false, actions: ['transfer'], confidential: true, owner_approval: true, assets: [USDC],
    destinations: { mode: 'only', list: [{ action: 'transfer', address: PAYEE, confidential: true }] },
    limits: { per_transaction: { [USDC]: '25000000' } }, max_actions_per_hour: 10,
    budget: { daily_usd: '50', weekly_usd: null, monthly_usd: '200' }, timelock_ms: 0 };
  if (treasury) { policy.actions = ['swap']; policy.owner_approval = false; policy.assets = 'any'; policy.destinations.list = []; }
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const grant = { grant_id: 'local-grant', agent_id: id, wallet_id: wallet.wallet_id, label: 'invoices',
    issued_at: new Date().toISOString(), expires_at: expires, revoked_at: null, owner_epoch: 1,
    owner_message: { domain: 'near-intents-agent-api.agent-grant.v6', owner, tenant_id: 'local', agent_id: id,
      wallet_id: wallet.wallet_id, label: 'invoices', credential: credential.commitment, network: 'mainnet',
      issued_at_ms: Date.now(), expires_at_ms: Date.parse(expires), owner_epoch: 1, nonce: 'local', recipient: 'local' } };
  const grants = [grant];
  const requests = [], errors = [], transfers = [], intents = [];
  let unavailable = false;
  const status = payment => ({ correlation_id: payment.correlation, agent_id: id, type: 'transfer', status: payment.status,
    created_at: payment.at, updated_at: payment.at, failure_code: null, details: { approval_id: payment.approval } });
  const approval = payment => {
    const data = { amount: payment.body.amount, chain: 'near', flow: 'transfer', kind: 'confidential', to: payment.body.recipient, token: payment.body.asset };
    return { approval_id: payment.approval, wallet_id: wallet.wallet_id, status: payment.status === 'PENDING_APPROVAL' ? 'PENDING' : 'APPROVED',
      expires_at: expires, request_type: 'confidential', request_data: data,
      request_hash: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
  };
  let dropNextTransfer = false, dropNextSignature = false, ownerOutcomeUnavailable = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local'), body = await bodyOf(req);
      const entry = { method: req.method, path: url.pathname, query: url.search, body, key: req.headers['idempotency-key'] };
      requests.push(entry); appendFileSync(`${directory}/provider.jsonl`, JSON.stringify(entry) + '\n');
      if (url.pathname === '/chain') {
        const { params, id: requestId } = body;
        if (params.request_type === 'view_access_key' && [OWNER, PAYEE].includes(params.account_id) && params.public_key === PUBLIC_KEY)
          return json(res, { jsonrpc: '2.0', id: requestId, result: { nonce: 1, permission: 'FullAccess', block_height: 1, block_hash: '11111111111111111111111111111111' } });
        if (params.request_type === 'call_function' && params.method_name === 'get_policy' && [OWNER, PAYEE].includes(params.account_id))
          return json(res, { jsonrpc: '2.0', id: requestId, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: params.account_id } }, code: -32000, message: 'Server error' } });
        throw new Error(`Undeclared chain request: ${JSON.stringify(params)}`);
      }
      if (unavailable) return json(res, { error: 'Declared local provider outage' }, 503);
      if (req.method === 'GET') {
        const base = `/v1/agents/${id}`;
        if (url.pathname === base) return json(res, { id, status: 'ACTIVE', archived: false, deleted: false, owner, wallet });
        if (url.pathname === `${base}/wallet`) return json(res, wallet);
        if (url.pathname === `${base}/grants`) return json(res, { data: grants });
        if (url.pathname === `${base}/policy`) return json(res, { policy, revision: 1, status: 'APPLIED', provider_policy_synced: true, wallet_id: wallet.wallet_id,
          cooldowns: { policy_change_available_at: null, unfreeze_available_at: null },
          usage: { budget: Object.fromEntries(['daily', 'weekly', 'monthly'].map(window => [window, { limit_usd: policy.budget[`${window}_usd`], spent_usd: '0', remaining_usd: policy.budget[`${window}_usd`], resets_at: null }])), timelock: { delay_ms: 0, scheduled_count: 0 } } });
        if (url.pathname === `${base}/policy/history`) return json(res, { data: [], next_cursor: null });
        if (url.pathname === `${base}/balances`) return json(res, { near_account_id: wallet.near_account_id, source: url.searchParams.get('source'),
          balances: [{ asset_id: USDC, balance_raw: url.searchParams.get('source') === 'public' ? '0' : (100000000n - transfers.filter(p => p.status === 'SUCCESS').reduce((sum, p) => sum + BigInt(p.body.amount), 0n)).toString() }] });
        if (url.pathname === '/v1/tokens') return json(res, { data: [
          { asset_id: USDC, symbol: 'USDC', decimals: 6, price: 1 },
          { asset_id: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, price: 2 },
          { asset_id: 'nep141:eth.omft.near', symbol: 'ETH', decimals: 18, price: 2000 },
        ].map(token => ({ ...token, price_updated_at: new Date().toISOString(), price_expires_at: expires })) });
        if (url.pathname === `${base}/history`) return json(res, { data: transfers.map(status), next_cursor: null });
        if (url.pathname === '/v1/status') {
          const correlation = url.searchParams.get('correlation_id');
          const payment = transfers.find(p => p.correlation === correlation);
          if (payment) return json(res, status(payment));
          const intent = intents.find(i => i.correlation_id === correlation);
          if (intent && ownerOutcomeUnavailable) return json(res, { error: 'Local scenario withholds owner outcome' }, 503);
          if (intent) return json(res, { correlation_id: correlation, agent_id: id, type: intent.type, status: intent.submitted ? 'SUCCESS' : 'PENDING_SIGNATURE' });
        }
        const payment = transfers.find(p => url.pathname === `${base}/approvals/${p.approval}`);
        if (payment) return json(res, approval(payment));
      }
      if (req.method === 'POST' && url.pathname === `/v1/agents/${id}/transfer`) {
        if (req.headers['x-grant-token'] !== credential.token || !entry.key) throw new Error('Missing grant or operation identity');
        if (body.recipient !== PAYEE || body.asset !== USDC || body.confidential !== true) throw new Error('Unexpected transfer terms');
        const payment = { body, key: entry.key, correlation: randomUUID(), approval: randomUUID(), status: 'PENDING_APPROVAL', at: new Date().toISOString() };
        transfers.push(payment);
        if (dropNextTransfer) { dropNextTransfer = false; return res.destroy(); }
        return json(res, { correlation_id: payment.correlation });
      }
      if (req.method === 'POST' && url.pathname === '/v1/generate-intent') {
        if (treasury && body.type === 'grant_issue') {
          if (body.agent_id !== id || !body.label.startsWith('treasury:') || !body.credential) throw new Error('Unexpected strategy grant');
          const generated = { correlation_id: randomUUID(), type: 'grant_issue', signer: owner, expires_at: expires,
            intent: { standard: 'nep413', payload: { message: JSON.stringify(body), nonce: randomBytes(32).toString('base64'), recipient: 'local-provider' } },
            preview: { summary: 'Authorize the saved local strategy' } };
          intents.push({ ...generated, grantRequest: body }); return json(res, generated);
        }
        const payment = transfers.find(p => p.approval === body.approval_id);
        if (body.type !== 'approval_vote' || body.verdict !== 'approve' || !payment) throw new Error('Unexpected owner request');
        const generated = { correlation_id: randomUUID(), type: 'approval_vote', signer: owner, expires_at: expires,
          intent: { standard: 'nep413', payload: { message: JSON.stringify(body), nonce: randomBytes(32).toString('base64'), recipient: 'local-provider' } },
          preview: { summary: 'Approve the local test payout', approval: { ...approval(payment), verdict: 'approve' } } };
        intents.push({ ...generated, payment }); return json(res, generated);
      }
      if (req.method === 'POST' && url.pathname === '/v1/submit-intent') {
        const intent = intents.find(i => i.correlation_id === body.correlation_id);
        if (!intent || intent.submitted) throw new Error('Unknown or repeated owner submission');
        intent.submitted = true;
        if (intent.grantRequest) {
          const request = intent.grantRequest;
          grants.push({ ...grant, grant_id: randomUUID(), label: request.label, expires_at: request.expires_at,
            owner_message: { ...grant.owner_message, label: request.label, credential: request.credential, expires_at_ms: Date.parse(request.expires_at) } });
        } else intent.payment.status = 'PROCESSING';
        if (dropNextSignature) { dropNextSignature = false; return res.destroy(); }
        return json(res, { correlation_id: intent.correlation_id, status: 'SUCCESS' });
      }
      throw new Error(`Undeclared provider request: ${req.method} ${url.pathname}`);
    } catch (error) { errors.push(String(error)); json(res, { error: String(error) }, 500); }
  });
  const port = await listen(server);
  return { id, token: credential.token, url: `http://127.0.0.1:${port}`, requests, errors, transfers, intents, grants,
    setUnavailable(value) { unavailable = value; },
    dropTransferResponse() { dropNextTransfer = true; },
    dropSignatureResponse() { dropNextSignature = true; ownerOutcomeUnavailable = true; },
    revealOwnerOutcome() { ownerOutcomeUnavailable = false; }, settle() { if (!intents.some(i => i.submitted)) throw new Error('Not approved'); transfers[0].status = 'SUCCESS'; },
    close: () => new Promise(resolve => server.close(resolve)) };
}
